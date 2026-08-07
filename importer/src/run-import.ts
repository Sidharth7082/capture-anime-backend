/**
 * CLI: run the anime import once and exit.
 *
 *   npm run import:anime                       full catalogue (resumes)
 *   npm run import:anime -- --limit 200        first 200 titles (test run)
 *   npm run import:anime -- --maxPages 5       first 5 pages
 *   npm run import:anime -- --dry-run          fetch + normalize, no DB writes
 *   npm run import:anime -- --reset            ignore the saved resume point
 *
 * Resume: progress is stored in `import_jobs` after every page, so a crash
 * or Ctrl-C continues from the last completed page on the next run.
 * Ctrl-C stops cleanly at the next page boundary.
 */
import "dotenv/config";
import { loadEnv, createLogger } from "./index.js";
import { createJikanClient } from "./jikan.js";
import { createDatabase } from "./database.js";
import { createTypesense } from "./typesense.js";
import { createImporter } from "./importer.js";
import { createNoopJobStore } from "./pipeline/job-store.js";

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);

// --- args -------------------------------------------------------------------
const args = process.argv.slice(2);
function argNumber(name: string): number | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  const value = Number(args[idx + 1]);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}
const limit = argNumber("--limit");
const maxPages = argNumber("--maxPages");
const dryRun = args.includes("--dry-run");
const reset = args.includes("--reset");
if (limit != null) logger.info(`[cli] limit=${limit} items`);
if (maxPages != null) logger.info(`[cli] maxPages=${maxPages}`);
if (dryRun) logger.warn("[cli] DRY-RUN: fetching + normalizing only, no database writes");
if (reset) logger.warn("[cli] RESET: ignoring the saved resume point");

// --- deps -------------------------------------------------------------------
const jikan = createJikanClient({ baseUrl: env.JIKAN_API_URL, timeoutMs: env.JIKAN_TIMEOUT_MS, retries: env.JIKAN_RETRY_COUNT, logger });
const db = dryRun
  ? (null as unknown as ReturnType<typeof createDatabase>)
  : createDatabase({ connectionString: env.DATABASE_URL, max: env.PG_POOL_MAX, logger });
const typesense = createTypesense({
  enabled: env.TYPESENSE_ENABLED === "true",
  url: env.TYPESENSE_URL ?? "http://localhost:8108",
  apiKey: env.TYPESENSE_API_KEY ?? "",
  collection: env.TYPESENSE_COLLECTION,
  logger,
});
const importer = createImporter({
  jikan,
  db: dryRun ? (null as unknown as ReturnType<typeof createDatabase>) : db,
  typesense,
  pageDelayMs: env.JIKAN_PAGE_DELAY_MS,
  logger,
});
if (dryRun) {
  // Swap in a no-op job store so dry-run never touches the database.
  importer.setJobStore(createNoopJobStore());
}

// --- graceful stop ----------------------------------------------------------
process.on("SIGINT", () => {
  logger.warn("[cli] SIGINT — stopping at the next page boundary…");
  importer.cancel();
});
process.on("SIGTERM", () => {
  logger.warn("[cli] SIGTERM — stopping at the next page boundary…");
  importer.cancel();
});

// --- run --------------------------------------------------------------------
try {
  const result = await importer.importAnime({ limit, maxPages, dryRun, reset });
  logger.info(`[cli] done — ${result.summary}`);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
} catch (err) {
  logger.error(`[cli] fatal: ${String(err)}`);
  process.exit(1);
} finally {
  if (!dryRun) await db.close();
}
