/**
 * Unit tests for catalog verification — the check/classification logic with
 * an in-memory fake query client (no database, no Typesense).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCatalogChecks, runTypesenseCountCheck, CATALOG_CHECKS } from "./verify-catalog.js";

/** Fake db: canned rows keyed by the SQL prefix they must match. */
function fakeDb(routes: Record<string, Record<string, unknown>[]>) {
  return {
    async query(sql: string): Promise<{ rows: Record<string, unknown>[] }> {
      const key = Object.keys(routes).find((k) => sql.includes(k));
      return { rows: key ? (routes[key] ?? []) : [] };
    },
  };
}

test("a healthy catalog passes every check", async () => {
  const results = await runCatalogChecks(fakeDb({})); // every query -> []
  assert.equal(results.length, CATALOG_CHECKS.length);
  for (const r of results) assert.equal(r.ok, true, `${r.name} should pass`);
  assert.equal(results.find((r) => r.name === "anime_count")!.ok, true);
});

test("duplicate MAL ids and missing slugs are hard errors", async () => {
  const results = await runCatalogChecks(
    fakeDb({
      "HAVING COUNT(*) > 1": [{ id_mal: 1, c: 2 }],
      "slug IS NULL": [{ c: 3 }],
    }),
  );
  const dup = results.find((r) => r.name === "no_duplicate_mal")!;
  const slug = results.find((r) => r.name === "no_missing_slugs")!;
  assert.equal(dup.ok, false);
  assert.equal(dup.severity, "error");
  assert.match(dup.detail, /mal_id 1 x2/);
  assert.equal(slug.ok, false);
  assert.equal(slug.severity, "error");
});

test("anime without genres/pictures are warnings, not failures", async () => {
  const results = await runCatalogChecks(
    fakeDb({
      "NOT EXISTS (SELECT 1 FROM anime_genres": [{ c: 7 }],
    }),
  );
  const genres = results.find((r) => r.name === "no_missing_genres")!;
  assert.equal(genres.ok, false);
  assert.equal(genres.severity, "warn");
});

test("orphan rows across content tables are a hard error", async () => {
  const results = await runCatalogChecks(
    fakeDb({
      "HAVING SUM(c) > 0": [
        { table_name: "anime_pictures", c: 2 },
        { table_name: "episodes", c: 1 },
      ],
    }),
  );
  const orphans = results.find((r) => r.name === "no_orphan_rows")!;
  assert.equal(orphans.ok, false);
  assert.equal(orphans.severity, "error");
  assert.match(orphans.detail, /anime_pictures: 2/);
});

test("typesense count check: enabled mismatch errors, disabled skips", async () => {
  const db = fakeDb({ "FROM anime": [{ c: 100 }] });

  const disabled = await runTypesenseCountCheck(db as never, {
    enabled: false,
    collection: "anime",
  } as never);
  assert.equal(disabled.skipped, true);
  assert.equal(disabled.ok, true);

  const mismatch = await runTypesenseCountCheck(db as never, {
    enabled: true,
    collection: "anime",
    retrieveCollection: async () => ({ num_documents: 42 }),
  } as never);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.severity, "error");
  assert.match(mismatch.detail, /db=100 typesense=42/);

  const match = await runTypesenseCountCheck(db as never, {
    enabled: true,
    collection: "anime",
    retrieveCollection: async () => ({ num_documents: 100 }),
  } as never);
  assert.equal(match.ok, true);
});
