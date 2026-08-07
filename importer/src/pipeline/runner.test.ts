/**
 * Unit tests for the pipeline runner: pagination, resume, limit, dry-run,
 * cancellation and job bookkeeping — all with in-memory fakes (no network,
 * no database).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runPipeline } from "./runner.js";
import type { FetchedPage, JobStore, NormalizedAnime, Sink, UpsertPort } from "./types.js";

interface Raw {
  id: number;
}

const toRow = (raw: Raw): NormalizedAnime =>
  ({
    idMal: raw.id,
    titleRomaji: `Title ${raw.id}`,
    titleEnglish: null,
    titleNative: null,
    synonyms: [],
    description: null,
    format: null,
    status: null,
    episodes: null,
    durationMinutes: null,
    startDate: null,
    endDate: null,
    season: null,
    seasonYear: null,
    averageScore: null,
    meanScore: null,
    popularity: null,
    favourites: null,
    source: null,
    isAdult: false,
    coverImageLarge: null,
    coverImageMedium: null,
    genres: [],
    themes: [],
    demographics: [],
    studios: [],
    producers: [],
    licensors: [],
  }) satisfies NormalizedAnime;

class FakeJobStore implements JobStore {
  resumePage = 0;
  started: { source: string; resumePage: number } | null = null;
  pages: Array<{ source: string; page: number; total: number }> = [];
  finished: { source: string; status: string; error: string | null } | null = null;

  async getResumePage(): Promise<number> {
    return this.resumePage;
  }
  async markStarted(source: string, resumePage: number): Promise<void> {
    this.started = { source, resumePage };
  }
  async markPage(source: string, page: number, total: number): Promise<void> {
    this.pages.push({ source, page, total });
  }
  async markFinished(source: string, status: "completed" | "failed", error?: string | null): Promise<void> {
    this.finished = { source, status, error: error ?? null };
  }
}

function makeFetcher(pages: Raw[][]) {
  let call = 0;
  return {
    source: "test-source",
    async fetchPage(page: number): Promise<FetchedPage<Raw>> {
      call += 1;
      const items = pages[page - 1] ?? [];
      return { items, hasNextPage: page < pages.length };
    },
    calls: () => call,
  };
}

function makeUpsert() {
  const upserted: NormalizedAnime[] = [];
  const port: UpsertPort<NormalizedAnime> = {
    async upsert(row) {
      upserted.push(row);
      return row.idMal % 2 === 0 ? "updated" : "inserted";
    },
  };
  return { port, upserted };
}

function silent() {
  return { info: () => undefined, warn: () => undefined, error: () => undefined };
}

test("runs every page until hasNextPage is false and records job progress", async () => {
  const fetcher = makeFetcher([[{ id: 1 }, { id: 2 }], [{ id: 3 }], []]);
  const jobs = new FakeJobStore();
  const ups = makeUpsert();
  const sink: Sink<NormalizedAnime> = { async ingest(rows) { assert.ok(rows.length <= 2); } };

  const result = await runPipeline<Raw, NormalizedAnime>({
    source: "test-source",
    fetcher,
    normalizer: toRow,
    validator: (r) => ({ ok: true, row: r }),
    upsert: ups.port,
    jobs,
    sink,
    logger: silent(),
  });

  assert.equal(result.fetched, 3);
  assert.equal(result.inserted, 2); // ids 1, 3
  assert.equal(result.updated, 1); // id 2
  assert.equal(result.failed, 0);
  assert.equal(result.ok, true);
  assert.equal(fetcher.calls(), 3); // page 1, 2, then the empty tail probe
  assert.deepEqual(jobs.pages.map((p) => p.page), [1, 2]);
  assert.equal(jobs.finished?.status, "completed");
});

test("resumes from the saved resume point (page N+1)", async () => {
  const fetcher = makeFetcher([[{ id: 1 }], [{ id: 2 }], [{ id: 3 }]]);
  const jobs = new FakeJobStore();
  jobs.resumePage = 1; // page 1 already completed in a previous run
  const ups = makeUpsert();

  const result = await runPipeline<Raw, NormalizedAnime>({
    source: "test-source",
    fetcher,
    normalizer: toRow,
    validator: (r) => ({ ok: true, row: r }),
    upsert: ups.port,
    jobs,
    sink: { async ingest() {} },
    logger: silent(),
  });

  assert.equal(result.fetched, 2); // pages 2 and 3 only
  assert.equal(fetcher.calls(), 2);
  assert.deepEqual(jobs.pages.map((p) => p.page), [2, 3]);
});

test("reset ignores the resume point", async () => {
  const fetcher = makeFetcher([[{ id: 1 }], [{ id: 2 }]]);
  const jobs = new FakeJobStore();
  jobs.resumePage = 5;

  const result = await runPipeline<Raw, NormalizedAnime>({
    source: "test-source",
    fetcher,
    normalizer: toRow,
    validator: (r) => ({ ok: true, row: r }),
    upsert: makeUpsert().port,
    jobs,
    sink: { async ingest() {} },
    logger: silent(),
  }, { reset: true });

  assert.equal(result.fetched, 2); // started from page 1 despite resumePage=5
  assert.deepEqual(jobs.pages.map((p) => p.page), [1, 2]);
});

test("limit stops the run and marks completion", async () => {
  const fetcher = makeFetcher([[{ id: 1 }, { id: 2 }, { id: 3 }], [{ id: 4 }]]);
  const jobs = new FakeJobStore();

  const result = await runPipeline<Raw, NormalizedAnime>({
    source: "test-source",
    fetcher,
    normalizer: toRow,
    validator: (r) => ({ ok: true, row: r }),
    upsert: makeUpsert().port,
    jobs,
    sink: { async ingest() {} },
    logger: silent(),
  }, { limit: 2 });

  assert.equal(result.fetched, 2);
  assert.equal(jobs.finished?.status, "completed");
});

test("dry-run never writes to the upsert or the job store", async () => {
  const fetcher = makeFetcher([[{ id: 1 }], []]);
  const jobs = new FakeJobStore();
  const ups = makeUpsert();

  const result = await runPipeline<Raw, NormalizedAnime>({
    source: "test-source",
    fetcher,
    normalizer: toRow,
    validator: (r) => ({ ok: true, row: r }),
    upsert: ups.port,
    jobs,
    sink: { async ingest() {} },
    logger: silent(),
  }, { dryRun: true });

  assert.equal(result.fetched, 1);
  assert.equal(ups.upserted.length, 0, "no DB writes in dry-run");
  assert.equal(jobs.pages.length, 0, "no progress persisted in dry-run");
  assert.equal(jobs.finished, null, "no job bookkeeping in dry-run");
});

test("invalid rows are counted as failures, not crashes", async () => {
  const fetcher = makeFetcher([[{ id: 1 }, { id: 2 }]]);
  const jobs = new FakeJobStore();
  const ups = makeUpsert();

  const result = await runPipeline<Raw, NormalizedAnime>({
    source: "test-source",
    fetcher,
    normalizer: toRow,
    validator: (r) => (r.idMal === 2 ? { ok: false, reason: "bad id" } : { ok: true, row: r }),
    upsert: ups.port,
    jobs,
    sink: { async ingest() {} },
    logger: silent(),
  });

  assert.equal(result.fetched, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.inserted, 1);
  assert.equal(ups.upserted.length, 1);
  assert.equal(jobs.finished?.status, "completed");
});

test("cancellation stops between pages and marks the job failed", async () => {
  let cancelled = false;
  const fetcher = {
    source: "test-source",
    async fetchPage(page: number): Promise<FetchedPage<Raw>> {
      if (page === 2) cancelled = true; // simulate a signal arriving mid-run
      return { items: [{ id: page }], hasNextPage: true };
    },
  };
  const jobs = new FakeJobStore();

  const result = await runPipeline<Raw, NormalizedAnime>({
    source: "test-source",
    fetcher,
    normalizer: toRow,
    validator: (r) => ({ ok: true, row: r }),
    upsert: makeUpsert().port,
    jobs,
    sink: { async ingest() {} },
    isCancelled: () => cancelled,
    logger: silent(),
  });

  assert.equal(result.ok, false);
  assert.equal(jobs.finished?.status, "failed");
  assert.equal(jobs.finished?.error, "cancelled by signal");
});
