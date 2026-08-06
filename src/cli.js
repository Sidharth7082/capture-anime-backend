// ============================================================================
// Importer CLI.
//
//   node src/cli.js                                  full anime catalog
//   node src/cli.js --sort TRENDING_DESC --max-pages 3
//   node src/cli.js --season WINTER --year 2024 --format TV
//   node src/cli.js --ids 21,16498                    (specific titles)
//   node src/cli.js --dry-run --max-pages 1           (no DB writes)
//
// All flags:
//   --type <ANIME|MANGA>        default ANIME
//   --sort <MediaSort>          default POPULARITY_DESC
//   --season <WINTER|SPRING|SUMMER|FALL>
//   --year <YYYY>               requires --season
//   --format <TV|TV_SHORT|MOVIE|SPECIAL|OVA|ONA|MUSIC>
//   --status <FINISHED|RELEASING|NOT_YET_RELEASED|CANCELLED|HIATUS>
//   --ids <1,2,3>               import specific AniList ids instead of a page
//   --page <n>                  starting page (default 1)
//   --max-pages <n>             stop after n pages (default: until exhausted)
//   --per-page <n>              default 50 (max 50)
//   --characters <n>            max characters per title (default 25, max 25)
//   --va-language <StaffLanguage> default JAPANESE
//   --include-adult             import adult titles too
//   --skip-episodes             do not seed episode placeholders
//   --delay-ms <n>              min ms between API requests (default 400)
//   --dry-run                   fetch and validate but write nothing
// ============================================================================

import { AniListClient } from './anilist/client.js';
import { importCatalog, importByIds, pageVariables } from './anilist/importer.js';
import { PAGE_MEDIA_QUERY } from './anilist/queries.js';
import { closePool, getPool } from './db.js';

const VALID = {
  type: ['ANIME', 'MANGA'],
  season: ['WINTER', 'SPRING', 'SUMMER', 'FALL'],
  format: ['TV', 'TV_SHORT', 'MOVIE', 'SPECIAL', 'OVA', 'ONA', 'MUSIC'],
  status: ['FINISHED', 'RELEASING', 'NOT_YET_RELEASED', 'CANCELLED', 'HIATUS'],
};

function parseArgs(argv) {
  const opts = {
    type: 'ANIME',
    sort: 'POPULARITY_DESC',
    season: null,
    year: null,
    format: null,
    status: null,
    ids: null,
    page: 1,
    maxPages: null,
    perPage: Number(process.env.ANILIST_PER_PAGE) || 50,
    characters: 25,
    vaLanguage: 'JAPANESE',
    includeAdult: false,
    skipEpisodes: false,
    delayMs: Number(process.env.ANILIST_DELAY_MS) || 400,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => argv[++i];
    switch (flag) {
      case '--type': opts.type = value().toUpperCase(); break;
      case '--sort': opts.sort = value().toUpperCase(); break;
      case '--season': opts.season = value().toUpperCase(); break;
      case '--year': opts.year = Number(value()); break;
      case '--format': opts.format = value().toUpperCase(); break;
      case '--status': opts.status = value().toUpperCase(); break;
      case '--ids': opts.ids = value().split(',').map((s) => Number(s.trim())).filter(Boolean); break;
      case '--page': opts.page = Number(value()); break;
      case '--max-pages': opts.maxPages = Number(value()); break;
      case '--per-page': opts.perPage = Number(value()); break;
      case '--characters': opts.characters = Number(value()); break;
      case '--va-language': opts.vaLanguage = value().toUpperCase(); break;
      case '--include-adult': opts.includeAdult = true; break;
      case '--skip-episodes': opts.skipEpisodes = true; break;
      case '--delay-ms': opts.delayMs = Number(value()); break;
      case '--dry-run': opts.dryRun = true; break;
      default:
        console.error(`unknown flag: ${flag}`);
        process.exit(1);
    }
  }
  return opts;
}

function validate(opts) {
  for (const [key, allowed] of Object.entries(VALID)) {
    const value = opts[key];
    if (value && !allowed.includes(value)) {
      console.error(`invalid --${key} "${value}"; expected one of: ${allowed.join(', ')}`);
      process.exit(1);
    }
  }
  if (opts.year && !opts.season) {
    console.error('--year requires --season');
    process.exit(1);
  }
  if (!Number.isInteger(opts.page) || opts.page < 1) {
    console.error('--page must be a positive integer');
    process.exit(1);
  }
  if (!Number.isInteger(opts.perPage) || opts.perPage < 1 || opts.perPage > 50) {
    console.error('--per-page must be between 1 and 50');
    process.exit(1);
  }
  if (!Number.isInteger(opts.characters) || opts.characters < 1 || opts.characters > 25) {
    console.error('--characters must be between 1 and 25 (AniList cap)');
    process.exit(1);
  }
  if (opts.ids && opts.page !== 1) {
    console.error('--ids cannot be combined with --page');
    process.exit(1);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  validate(opts);

  const anilist = new AniListClient({ minIntervalMs: opts.delayMs });

  if (opts.dryRun) {
    await dryRun(anilist, opts);
    return;
  }

  // Force a connection early so auth/connection errors surface before the API
  // calls start.
  getPool();

  const startedAt = Date.now();
  const summary = opts.ids
    ? await importByIds(anilist, opts.ids, {
        type: opts.type,
        charactersPerPage: opts.characters,
        vaLanguage: opts.vaLanguage,
        skipEpisodes: opts.skipEpisodes,
      })
    : await importCatalog(anilist, {
        startPage: opts.page,
        perPage: opts.perPage,
        maxPages: opts.maxPages,
        includeAdult: opts.includeAdult,
        type: opts.type,
        sort: opts.sort,
        season: opts.season,
        seasonYear: opts.year,
        format: opts.format,
        status: opts.status,
        charactersPerPage: opts.characters,
        vaLanguage: opts.vaLanguage,
        onPage: ({ page, count, totalMedia, totalCharacters }) => {
          console.log(
            `[import] page ${page}: ${count} media -> ${totalMedia} total, ${totalCharacters} character links`,
          );
        },
      });

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `\nDone in ${seconds}s after ${anilist.requestCount} API requests.` +
    (opts.ids
      ? ` Imported ${summary.results.length} titles.`
      : ` Imported ${summary.totalMedia} media across ${summary.pages} pages.`),
  );
  await closePool();
}

/** Fetches one page and prints a sample — no database writes at all. */
async function dryRun(anilist, opts) {
  console.log(`[dry-run] fetching page ${opts.page} (${opts.perPage} items) ...`);
  const variables = pageVariables({
    page: opts.page,
    perPage: opts.perPage,
    type: opts.type,
    sort: opts.sort,
    season: opts.season,
    seasonYear: opts.year,
    format: opts.format,
    status: opts.status,
    includeAdult: opts.includeAdult,
    charactersPerPage: opts.characters,
    vaLanguage: opts.vaLanguage,
  });
  const data = await anilist.query(PAGE_MEDIA_QUERY, variables);
  const { media, pageInfo } = data.Page;

  console.log(
    `[dry-run] ${media.length} media, page ${pageInfo.currentPage}/${pageInfo.lastPage ?? '?'}, hasNextPage=${pageInfo.hasNextPage}`,
  );
  for (const m of media.slice(0, 5)) {
    const title = m.title?.romaji ?? m.title?.english ?? m.title?.native ?? '(untitled)';
    console.log(
      `  #${m.id} ${title}  [${m.format ?? '-'} / ${m.status ?? '-'}] ` +
      `eps=${m.episodes ?? '-'} genres=${(m.genres ?? []).join(',') || '-'} ` +
      `chars=${m.characters?.edges?.length ?? 0} va=${(m.characters?.edges ?? []).reduce((n, e) => n + (e.voiceActors?.length ?? 0), 0)}`,
    );
  }
  if (media.length === 0) {
    console.log('[dry-run] no media returned for the given filters.');
  }
}

main().catch((err) => {
  console.error(`\nfatal: ${err.message}`);
  process.exitCode = 1;
});
