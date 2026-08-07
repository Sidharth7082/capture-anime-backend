/**
 * In-memory import metrics — the single source of truth for the /health
 * endpoint and the shutdown status line. Records the currently running
 * import (page + counters) and the last completed one (counts + duration).
 */
import type { RunCounters, RunResult } from "./pipeline/types.js";

export interface CurrentRun extends RunCounters {
  source: string;
  startedAt: string; // ISO
  page: number;
}

export interface LastRun extends CurrentRun {
  finishedAt: string; // ISO
  durationMs: number;
  status: "completed" | "failed";
  error?: string | null;
}

export class Metrics {
  private readonly processStartedAt = Date.now();
  private _current: CurrentRun | null = null;
  private _lastRun: LastRun | null = null;
  private _nextRunAt: number | null = null;

  recordStart(source: string): void {
    this._current = { source, startedAt: new Date().toISOString(), page: 0, fetched: 0, inserted: 0, updated: 0, failed: 0 };
  }

  recordPage(source: string, page: number, counts: RunCounters): void {
    if (!this._current) this.recordStart(source);
    this._current!.page = page;
    this._current!.fetched = counts.fetched;
    this._current!.inserted = counts.inserted;
    this._current!.updated = counts.updated;
    this._current!.failed = counts.failed;
  }

  recordEnd(source: string, result: RunResult, status: "completed" | "failed", error?: string | null): void {
    const start = this._current?.source === source ? this._current : null;
    const startedAt = start?.startedAt ?? new Date().toISOString();
    const durationMs = Date.now() - new Date(startedAt).getTime();
    this._lastRun = {
      source,
      status,
      error: error ?? null,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs,
      page: start?.page ?? 0,
      fetched: result.fetched,
      inserted: result.inserted,
      updated: result.updated,
      failed: result.failed,
    };
    this._current = null;
  }

  setNextRunAt(timestamp: number | null): void {
    this._nextRunAt = timestamp;
  }

  get nextRunAt(): number | null {
    return this._nextRunAt;
  }

  get current(): CurrentRun | null {
    return this._current;
  }

  get lastRun(): LastRun | null {
    return this._lastRun;
  }

  snapshot(): { uptimeSeconds: number; current: CurrentRun | null; lastRun: LastRun | null; nextRunAt: number | null } {
    return {
      uptimeSeconds: Math.floor((Date.now() - this.processStartedAt) / 1000),
      current: this._current,
      lastRun: this._lastRun,
      nextRunAt: this._nextRunAt,
    };
  }
}

export function createMetrics(): Metrics {
  return new Metrics();
}
