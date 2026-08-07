/**
 * Catalog health verification — one command to know the catalog is healthy
 * after any import/enrichment run.
 *
 *   cd importer && npm run verify-catalog     (or: npm run catalog:verify)
 *
 * Hard failures (duplicates, missing slugs, orphan rows, Typesense drift)
 * print ✗ and exit 1. Data-completeness warnings (anime without genres /
 * pictures / characters — normal before the enrichment stage has run) print
 * ⚠ with counts but do not fail the check.
 */
import type { Database } from "./database.js";
import type { TypesenseClient } from "./typesense.js";
import { loadEnv, createLogger } from "./index.js";
import { createDatabase } from "./database.js";
import { createTypesense } from "./typesense.js";

export interface CheckDef {
  name: string;
  label: string;
  severity: "error" | "warn";
  sql: string;
  /** Parse query rows into a verdict. */
  evaluate: (rows: Record<string, unknown>[]) => { ok: boolean; detail: string };
}

export interface CheckResult extends CheckDef {
  ok: boolean;
  detail: string;
  skipped?: boolean;
}

const count = (rows: Record<string, unknown>[]): number => Number(rows[0]?.c ?? 0);

/** The catalog tables whose rows must all point at a real anime. */
const ORPHAN_UNION = [
  "anime_genres", "anime_studios", "anime_producers", "anime_licensors",
  "anime_themes", "anime_demographics", "anime_characters", "anime_staff",
  "anime_relations", "anime_recommendations", "anime_pictures",
  "anime_videos", "episodes",
]
  .map(
    (t) =>
      `SELECT '${t}' AS table_name, COUNT(*)::int AS c FROM ${t} r LEFT JOIN anime a ON a.id = r.anime_id WHERE a.id IS NULL`,
  )
  // character_staff has no anime_id — its orphan form is a VA link whose
  // character is no longer attached to any anime.
  .concat(
    `SELECT 'character_staff' AS table_name, COUNT(*)::int AS c FROM character_staff cs
     WHERE NOT EXISTS (SELECT 1 FROM anime_characters ac WHERE ac.character_id = cs.character_id)`,
  )
  .join("\nUNION ALL\n");

export const CATALOG_CHECKS: CheckDef[] = [
  // --- hard errors -----------------------------------------------------------
  {
    name: "no_duplicate_mal",
    label: "No duplicate MAL IDs",
    severity: "error",
    sql: "SELECT id_mal, COUNT(*)::int AS c FROM anime WHERE id_mal IS NOT NULL GROUP BY id_mal HAVING COUNT(*) > 1 LIMIT 20",
    evaluate: (rows) =>
      rows.length === 0
        ? { ok: true, detail: "unique" }
        : { ok: false, detail: rows.map((r) => `mal_id ${r.id_mal} x${r.c}`).join(", ") },
  },
  {
    name: "no_duplicate_anilist",
    label: "No duplicate AniList IDs",
    severity: "error",
    sql: "SELECT anilist_id, COUNT(*)::int AS c FROM anime WHERE anilist_id IS NOT NULL GROUP BY anilist_id HAVING COUNT(*) > 1 LIMIT 20",
    evaluate: (rows) =>
      rows.length === 0
        ? { ok: true, detail: "unique" }
        : { ok: false, detail: rows.map((r) => `anilist_id ${r.anilist_id} x${r.c}`).join(", ") },
  },
  {
    name: "no_missing_slugs",
    label: "No missing slugs",
    severity: "error",
    sql: "SELECT COUNT(*)::int AS c FROM anime WHERE slug IS NULL AND id_mal IS NOT NULL",
    evaluate: (rows) => {
      const n = count(rows);
      return n === 0 ? { ok: true, detail: "all set" } : { ok: false, detail: `${n} anime rows with id_mal but no slug (run import:anime)` };
    },
  },
  {
    name: "no_orphan_rows",
    label: "No orphan rows (FK integrity)",
    severity: "error",
    sql: `SELECT table_name, SUM(c)::int AS c FROM (${ORPHAN_UNION}) orphans GROUP BY table_name HAVING SUM(c) > 0`,
    evaluate: (rows) =>
      rows.length === 0
        ? { ok: true, detail: "all rows reference a real anime" }
        : { ok: false, detail: rows.map((r) => `${r.table_name}: ${r.c}`).join(", ") },
  },
  // --- informational ----------------------------------------------------------
  {
    name: "anime_count",
    label: "Catalog size",
    severity: "warn", // informational: never fails
    sql: "SELECT COUNT(*)::int AS c FROM anime",
    evaluate: (rows) => ({ ok: true, detail: `${count(rows)} anime` }),
  },
  // --- data completeness (warnings until enrichment has run) ------------------
  {
    name: "no_missing_genres",
    label: "Anime without genres",
    severity: "warn",
    sql: "SELECT COUNT(*)::int AS c FROM anime a WHERE NOT EXISTS (SELECT 1 FROM anime_genres ag WHERE ag.anime_id = a.id)",
    evaluate: (rows) => {
      const n = count(rows);
      return n === 0 ? { ok: true, detail: "every anime has genres" } : { ok: false, detail: `${n} anime (backfill with import:anime)` };
    },
  },
  {
    name: "no_missing_pictures",
    label: "Anime without pictures",
    severity: "warn",
    sql: "SELECT COUNT(*)::int AS c FROM anime a WHERE NOT EXISTS (SELECT 1 FROM anime_pictures ap WHERE ap.anime_id = a.id)",
    evaluate: (rows) => {
      const n = count(rows);
      return n === 0 ? { ok: true, detail: "every anime has pictures" } : { ok: false, detail: `${n} anime (backfill with import:enrich)` };
    },
  },
  {
    name: "no_missing_characters",
    label: "Anime without characters",
    severity: "warn",
    sql: "SELECT COUNT(*)::int AS c FROM anime a WHERE NOT EXISTS (SELECT 1 FROM anime_characters ac WHERE ac.anime_id = a.id)",
    evaluate: (rows) => {
      const n = count(rows);
      return n === 0 ? { ok: true, detail: "every anime has characters" } : { ok: false, detail: `${n} anime (backfill with import:enrich)` };
    },
  },
  {
    name: "no_missing_synopsis",
    label: "Anime without synopsis",
    severity: "warn",
    sql: "SELECT COUNT(*)::int AS c FROM anime WHERE description IS NULL OR description = ''",
    evaluate: (rows) => {
      const n = count(rows);
      return n === 0 ? { ok: true, detail: "every anime has a synopsis" } : { ok: false, detail: `${n} anime` };
    },
  },
  {
    name: "relations_resolved",
    label: "Unresolved anime relations",
    severity: "warn",
    sql: "SELECT COUNT(*)::int AS c FROM anime_relations WHERE media_type = 'anime' AND related_anime_id IS NULL",
    evaluate: (rows) => {
      const n = count(rows);
      return n === 0
        ? { ok: true, detail: "all relations point at the local catalog" }
        : { ok: false, detail: `${n} relations target anime not imported yet` };
    },
  },
];

/** Run the SQL checks against a query-capable db. */
export async function runCatalogChecks(
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  checks: CheckDef[] = CATALOG_CHECKS,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    try {
      const { rows } = await db.query(check.sql);
      const { ok, detail } = check.evaluate(rows);
      results.push({ ...check, ok, detail });
    } catch (err) {
      results.push({ ...check, ok: false, detail: `query failed: ${String(err)}` });
    }
  }
  return results;
}

/** Compare the Typesense document count with the anime count (enabled only). */
export async function runTypesenseCountCheck(
  db: Database,
  typesense: TypesenseClient,
): Promise<CheckResult> {
  const base: CheckResult = {
    name: "typesense_count",
    label: "Typesense count matches DB",
    severity: "error",
    sql: "",
    evaluate: () => ({ ok: true, detail: "" }),
    ok: true,
    detail: "",
  };
  if (!typesense.enabled) {
    return { ...base, detail: "skipped (TYPESENSE_ENABLED=false)", skipped: true };
  }
  try {
    // Search docs are keyed by mal_id, so only id_mal-bearing rows count.
    const { rows } = await db.query(
      "SELECT COUNT(*)::int AS c FROM anime WHERE id_mal IS NOT NULL",
    );
    const dbCount = Number(rows[0]?.c ?? 0);
    const info = await typesense.retrieveCollection();
    const tsCount = info?.num_documents ?? -1;
    const ok = tsCount === dbCount;
    return {
      ...base,
      ok,
      detail: ok ? `${dbCount} docs` : `db=${dbCount} typesense=${tsCount} (run an import to reindex)`,
    };
  } catch (err) {
    return { ...base, ok: false, detail: `query failed: ${String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL, env.LOG_FORMAT ?? "pretty");
  const db = createDatabase({ connectionString: env.DATABASE_URL, max: 3, logger });
  const typesense = createTypesense({
    enabled: env.TYPESENSE_ENABLED === "true",
    url: env.TYPESENSE_URL ?? "http://localhost:8108",
    apiKey: env.TYPESENSE_API_KEY ?? "",
    collection: env.TYPESENSE_COLLECTION,
    logger,
  });

  try {
    const results = await runCatalogChecks(db);
    results.push(await runTypesenseCountCheck(db, typesense));

    let errors = 0;
    let warnings = 0;
    for (const r of results) {
      const mark = r.skipped ? "•" : r.ok ? "✓" : r.severity === "error" ? "✗" : "⚠";
      console.log(`${mark} ${r.label}${r.detail ? ` — ${r.detail}` : ""}`);
      if (r.skipped) continue;
      if (!r.ok) {
        if (r.severity === "error") errors += 1;
        else warnings += 1;
      }
    }

    console.log("");
    if (errors > 0) {
      console.log(`✗ ${errors} error(s) — catalog needs attention`);
      process.exitCode = 1;
    } else if (warnings > 0) {
      console.log(`✓ Database OK — ${warnings} data-completeness warning(s)`);
    } else {
      console.log("✓ Database OK");
    }
  } finally {
    await db.close();
  }
}

import { pathToFileURL } from "node:url";
const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(`[verify-catalog] fatal: ${String(err)}`);
    process.exit(1);
  });
}
