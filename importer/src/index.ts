/**
 * Importer entrypoint.
 *
 * Boot sequence: load + validate env -> build the service clients -> run one
 * import (optional) -> start the scheduler -> wait for signals. Shuts down
 * cleanly on SIGINT/SIGTERM so Docker can stop the container gracefully.
 */
import "dotenv/config";
import { z } from "zod";
import { createJikanClient, type JikanClient } from "./jikan.js";
import { createAniListClient, type AniListClient } from "./anilist.js";
import { createDatabase, type Database } from "./database.js";
import { createTypesense, type TypesenseClient } from "./typesense.js";
import { createImporter } from "./importer.js";
import { createScheduler } from "./scheduler.js";
import { createMetrics } from "./metrics.js";
import { createHealthServer, type HealthServer } from "./health.js";

// ---------------------------------------------------------------------------
// Environment (validated once at boot — fail fast with the exact missing key)
// ---------------------------------------------------------------------------
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  LOG_FORMAT: z.enum(["pretty", "json"]).optional(),

  JIKAN_API_URL: z.string().url(),
  JIKAN_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  JIKAN_RETRY_COUNT: z.coerce.number().int().min(0).max(10).default(3),
  JIKAN_PAGE_DELAY_MS: z.coerce.number().int().min(0).default(150),
  ENRICH_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(10),
  ENRICH_STALE_DAYS: z.coerce.number().int().min(0).max(3650).default(0),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  PG_POOL_MAX: z.coerce.number().int().min(1).max(100).default(5),

  TYPESENSE_ENABLED: z.enum(["true", "false"]).default("false"),
  TYPESENSE_URL: z.string().url().optional(),
  TYPESENSE_API_KEY: z.string().min(1).optional(),
  TYPESENSE_COLLECTION: z.string().min(1).default("anime"),

  ANILIST_ENABLED: z.enum(["true", "false"]).default("false"),
  ANILIST_ENDPOINT: z.string().url().default("https://graphql.anilist.co"),
  ANILIST_ACCESS_TOKEN: z.string().min(1).optional(),
  ANILIST_PER_PAGE: z.coerce.number().int().min(1).max(100).default(50),
  ANILIST_MIN_INTERVAL_MS: z.coerce.number().int().min(0).default(450),

  RUN_ON_START: z.enum(["true", "false"]).default("true"),
  SCHEDULER_ENABLED: z.enum(["true", "false"]).default("true"),
  SCHEDULER_INTERVAL_MS: z.coerce.number().int().min(1).default(3_600_000),

  HEALTH_ENABLED: z.enum(["true", "false"]).default("true"),
  HEALTH_PORT: z.coerce.number().int().min(0).max(65535).default(9090),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    console.error(`Invalid environment configuration:\n${issues}\nSee importer/.env.example`);
    process.exit(1);
  }
  const env = parsed.data;
  // Default: JSON logs in production, human-readable locally.
  env.LOG_FORMAT = env.LOG_FORMAT ?? (env.NODE_ENV === "production" ? "json" : "pretty");
  return env;
}

// ---------------------------------------------------------------------------
// Logging (tiny leveled logger — no extra dependency)
// ---------------------------------------------------------------------------
type Level = "debug" | "info" | "warn" | "error";
const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export type Logger = Pick<Console, "debug" | "info" | "warn" | "error">;

export type LogFormat = "pretty" | "json";

/**
 * Leveled logger. `pretty` writes `2026-... [LEVEL] message fields...`;
 * `json` writes one JSON object per line ({ ts, level, msg, ...fields })
 * so logs can be piped into jq / a log collector.
 */
export function createLogger(level: Level, format: LogFormat = "pretty"): Logger {
  const min = LEVEL_ORDER[level];
  const log = (lvl: Level, ...args: unknown[]) => {
    if (LEVEL_ORDER[lvl] < min) return;
    const [msg, fields] = args;
    const ts = new Date().toISOString();
    if (format === "json") {
      const entry: Record<string, unknown> = { ts, level: lvl, msg: String(msg ?? "") };
      if (fields && typeof fields === "object") Object.assign(entry, fields as Record<string, unknown>);
      console[lvl === "debug" ? "log" : lvl](JSON.stringify(entry));
      return;
    }
    const rest = args
      .slice(1)
      .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
      .join(" ");
    console[lvl === "debug" ? "log" : lvl](`${ts} [${lvl.toUpperCase()}] ${String(msg)}${rest ? ` ${rest}` : ""}`);
  };
  return {
    debug: (...a) => log("debug", ...a),
    info: (...a) => log("info", ...a),
    warn: (...a) => log("warn", ...a),
    error: (...a) => log("error", ...a),
  };
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL, env.LOG_FORMAT ?? "pretty");
  const metrics = createMetrics();

  const jikan: JikanClient = createJikanClient({
    baseUrl: env.JIKAN_API_URL,
    timeoutMs: env.JIKAN_TIMEOUT_MS,
    retries: env.JIKAN_RETRY_COUNT,
    logger,
  });
  const db: Database = createDatabase({ connectionString: env.DATABASE_URL, max: env.PG_POOL_MAX, logger });
  const typesense: TypesenseClient = createTypesense({
    enabled: env.TYPESENSE_ENABLED === "true",
    url: env.TYPESENSE_URL ?? "http://localhost:8108",
    apiKey: env.TYPESENSE_API_KEY ?? "",
    collection: env.TYPESENSE_COLLECTION,
    logger,
  });

  const anilist: AniListClient | null = env.ANILIST_ENABLED === "true" ? createAniListClient({
    endpoint: env.ANILIST_ENDPOINT,
    accessToken: env.ANILIST_ACCESS_TOKEN,
    minIntervalMs: env.ANILIST_MIN_INTERVAL_MS,
    logger,
  }) : null;

  const importer = createImporter({
    jikan,
    db,
    typesense,
    metrics,
    pageDelayMs: env.JIKAN_PAGE_DELAY_MS,
    enrichBatchSize: env.ENRICH_BATCH_SIZE,
    enrichStaleDays: env.ENRICH_STALE_DAYS,
    anilist: anilist,
    anilistPerPage: env.ANILIST_PER_PAGE,
    logger,
  });

  // Health probes (non-fatal — log and continue).
  const [jikanOk, dbOk, tsOk] = await Promise.all([jikan.ping(), db.ping(), typesense.ping()]);
  logger.info(`[boot] jikan=${jikanOk ? "up" : "DOWN"} (${jikan.baseUrl})`);
  logger.info(`[boot] database=${dbOk ? "up" : "DOWN"}`);
  logger.info(`[boot] typesense=${env.TYPESENSE_ENABLED === "true" ? (tsOk ? "up" : "DOWN") : "disabled"}`);

  const scheduler = createScheduler(() => importer.run(), {
    intervalMs: env.SCHEDULER_INTERVAL_MS,
    runOnStart: env.RUN_ON_START === "true",
    logger,
    onRunFinished: () => metrics.setNextRunAt(scheduler.getNextRunAt()),
  });

  // Health endpoint: last import, current job, next scheduled run.
  let healthServer: HealthServer | null = null;
  if (env.HEALTH_ENABLED === "true") {
    healthServer = createHealthServer({ metrics, db, port: env.HEALTH_PORT, logger });
    await healthServer.listen();
    logger.info(`[boot] health endpoint on :${healthServer.port} (GET /health)`);
  }

  if (env.SCHEDULER_ENABLED === "true") {
    scheduler.start();
    logger.info(`[boot] scheduler enabled (interval ${env.SCHEDULER_INTERVAL_MS}ms, run-on-start=${env.RUN_ON_START})`);
  } else {
    logger.info("[boot] scheduler disabled — run a single import and exit");
    await importer.run();
  }

  // Graceful shutdown.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`[boot] received ${signal} — shutting down`);
    await scheduler.stop();
    if (healthServer) await healthServer.close();
    await db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// Run only when executed directly (`node dist/index.js` / `npm run dev`).
// Importing this module from the CLI (run-import.ts) must NOT boot the daemon.
import { pathToFileURL } from "node:url";
const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(`[boot] fatal: ${String(err)}`);
    process.exit(1);
  });
}
