/**
 * Typesense client wrapper (optional search index).
 *
 * The importer will eventually mirror the anime catalog into Typesense so the
 * frontend can search it. This module only wires up the client — indexing
 * logic lands together with the importer steps. When `enabled` is false every
 * method no-ops, so the rest of the pipeline can treat Typesense as optional.
 */
import Typesense from "typesense";
import type { Sink } from "./pipeline/types.js";

export interface TypesenseConfig {
  enabled: boolean;
  url: string;
  apiKey: string;
  collection: string;
  logger?: Pick<Console, "warn" | "error" | "info">;
}

export interface TypesenseClient {
  readonly enabled: boolean;
  readonly collection: string;
  /** Connectivity check against the configured collection. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export class NoopTypesense implements TypesenseClient {
  readonly enabled = false;
  readonly collection: string;
  private readonly logger: Pick<Console, "warn" | "error" | "info">;

  constructor(config: TypesenseConfig) {
    this.collection = config.collection;
    this.logger = config.logger ?? console;
  }

  async ping(): Promise<boolean> {
    this.logger.warn("[typesense] disabled — skipping connectivity check");
    return false;
  }

  async close(): Promise<void> {
    // nothing to release
  }
}

export class RealTypesense implements TypesenseClient {
  readonly enabled = true;
  readonly collection: string;
  private readonly client: Typesense.Client;
  private readonly logger: Pick<Console, "warn" | "error" | "info">;

  constructor(config: TypesenseConfig) {
    this.collection = config.collection;
    this.logger = config.logger ?? console;
    this.client = new Typesense.Client({
      nodes: [{ host: hostOf(config.url), port: portOf(config.url), protocol: protocolOf(config.url) }],
      apiKey: config.apiKey,
      connectionTimeoutSeconds: 5,
    });
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.health.retrieve();
      return true;
    } catch (err) {
      this.logger.warn(`[typesense] health check failed: ${String(err)}`);
      return false;
    }
  }

  async close(): Promise<void> {
    // typesense client keeps no long-lived sockets that need explicit release
  }
}

/** Build the right client based on `enabled`. */
export function createTypesense(config: TypesenseConfig): TypesenseClient {
  return config.enabled ? new RealTypesense(config) : new NoopTypesense(config);
}

/**
 * Pipeline sink — no-op until Stage 5 (Typesense indexing). Kept as the
 * default so the runner's contract is exercised end to end.
 */
export function createNoopSink(logger?: Pick<Console, "debug" | "info" | "warn" | "error">): Sink<unknown> {
  return {
    async ingest(rows) {
      logger?.debug?.(`[sink] no-op (Typesense disabled): ${rows.length} rows`);
    },
  };
}
// --- tiny URL helpers (keeps the typesense dep config simple) ---------------

function hostOf(url: string): string {
  return new URL(url).hostname;
}
function portOf(url: string): number {
  return Number(new URL(url).port || 8108);
}
function protocolOf(url: string): "http" | "https" {
  return new URL(url).protocol === "https:" ? "https" : "http";
}
