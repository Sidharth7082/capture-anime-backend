/**
 * Import orchestrator.
 *
 * This is the skeleton the importer steps will fill in (Jikan fetch ->
 * normalize -> upsert into PostgreSQL -> mirror into Typesense). Deliberately
 * contains NO import logic yet — it exists so the wiring, scheduler and
 * container can be exercised end to end.
 */
import type { JikanClient } from "./jikan.js";
import type { Database } from "./database.js";
import type { TypesenseClient } from "./typesense.js";

export interface ImportDeps {
  jikan: JikanClient;
  db: Database;
  typesense: TypesenseClient;
  logger?: Pick<Console, "warn" | "error" | "info">;
}

export interface ImportResult {
  ok: boolean;
  /** Total records written to the database. */
  imported: number;
  /** Records mirrored into Typesense (0 when disabled). */
  indexed: number;
  /** Human-readable summary for logs. */
  summary: string;
}

export class Importer {
  private readonly deps: ImportDeps;
  private readonly logger: Pick<Console, "warn" | "error" | "info">;

  constructor(deps: ImportDeps) {
    this.deps = deps;
    this.logger = deps.logger ?? console;
  }

  /**
   * Run one full import pass.
   *
   * TODO(step-by-step): implement each stage as its own method:
   *   1. fetchAnime()          — paginated Jikan fetch (top/seasonal/seasons)
   *   2. fetchDetails()        — per-title enrichment (episodes, staff, ...)
   *   3. normalize()           — map Jikan shapes to the platform schema
   *   4. upsertIntoDatabase()  — idempotent writes (ON CONFLICT)
   *   5. indexIntoTypesense()  — mirror normalized records (when enabled)
   */
  async run(): Promise<ImportResult> {
    this.logger.info(`[importer] run() is a scaffold — importing not implemented yet`);
    this.logger.info(`[importer] jikan=${this.deps.jikan.baseUrl} typesense=${this.deps.typesense.enabled ? "enabled" : "disabled"}`);
    return { ok: true, imported: 0, indexed: 0, summary: "scaffold run (no-op)" };
  }
}

export function createImporter(deps: ImportDeps): Importer {
  return new Importer(deps);
}
