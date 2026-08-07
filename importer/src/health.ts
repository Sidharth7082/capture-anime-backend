/**
 * Health HTTP endpoint (node:http — no extra dependency).
 *
 *   GET /health  -> 200 { status, uptimeSeconds, import: { current, lastRun,
 *                       nextRunAt }, jobs: [...] }
 *
 * `jobs` mirrors the import_jobs table (last page, totals, error per source),
 * so a monitor can see resume state without touching the database directly.
 * The endpoint is deliberately read-only and dependency-light: it shares the
 * DB pool and the Metrics registry from the daemon.
 */
import { createServer, type Server } from "node:http";
import type { Database } from "./database.js";
import type { Metrics } from "./metrics.js";

export interface HealthDeps {
  metrics: Metrics;
  db: Database;
  /** TCP port to bind (0 picks a free port). */
  port: number;
  logger?: Pick<Console, "warn" | "error" | "info">;
}

export interface HealthServer {
  readonly port: number;
  listen(): Promise<HealthServer>;
  close(): Promise<void>;
}

interface JobRow {
  source: string;
  status: string;
  last_page: number;
  total_items: number;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
}

export function createHealthServer(deps: HealthDeps): HealthServer {
  const logger = deps.logger ?? console;
  let server: Server | null = null;
  let boundPort = 0;

  const server_ = createServer((req, res) => {
    if (req.method !== "GET" || (req.url !== "/health" && req.url !== "/healthz")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    const metrics = deps.metrics.snapshot();
    deps.db
      .query<JobRow>("SELECT source, status, last_page, total_items, started_at, finished_at, error FROM import_jobs ORDER BY source")
      .then((result) => {
        const body = JSON.stringify({
          status: "ok",
          uptimeSeconds: metrics.uptimeSeconds,
          import: {
            current: metrics.current,
            lastRun: metrics.lastRun,
            nextRunAt: metrics.nextRunAt,
          },
          jobs: result.rows.map((r) => ({
            source: r.source,
            status: r.status,
            lastPage: r.last_page,
            totalItems: r.total_items,
            startedAt: r.started_at,
            finishedAt: r.finished_at,
            error: r.error,
          })),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
      })
      .catch((err) => {
        // The import_jobs table may not exist yet on a fresh database —
        // still report health, with an empty job list.
        logger.warn(`[health] import_jobs read failed: ${String(err)}`);
        const body = JSON.stringify({
          status: "ok",
          uptimeSeconds: metrics.uptimeSeconds,
          import: { current: metrics.current, lastRun: metrics.lastRun, nextRunAt: metrics.nextRunAt },
          jobs: [],
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
      });
  });

  const health: HealthServer = {
    get port() {
      return boundPort;
    },
    listen(): Promise<HealthServer> {
      return new Promise((resolve, reject) => {
        const srv = server_.listen(deps.port, "0.0.0.0", () => {
          const address = srv.address();
          boundPort = typeof address === "object" && address ? address.port : deps.port;
          server = srv;
          resolve(health);
        });
        srv.once("error", reject);
      });
    },
    async close() {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = null;
      }
    },
  };
  return health;
}
