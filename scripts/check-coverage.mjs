// CI coverage gate: runs the backend suite with coverage and fails when
// line coverage drops below the threshold.
//
//   npm run test:ci                (threshold 90)
//   COVERAGE_MIN=85 npm run test:ci
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const minCoverage = Number(process.env.COVERAGE_MIN ?? 90);

console.log(`[coverage] running tests with coverage (gate: >= ${minCoverage}% lines)`);
const result = spawnSync(
  process.execPath,
  ['--test', '--experimental-test-coverage', 'test/unit/**/*.test.mjs'],
  { cwd: root, encoding: 'utf8' },
);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);

// Parse the "all files" row: `ℹ all files | 93.17 | 79.04 | 84.19 |`
const m = /all files\s*\|\s*([\d.]+)/.exec(result.stdout);
if (!m) {
  console.error('[coverage] could not parse the coverage report');
  process.exit(1);
}
const lineCoverage = Number(m[1]);
console.log(`[coverage] line coverage: ${lineCoverage}% (gate: ${minCoverage}%)`);
if (lineCoverage < minCoverage) {
  console.error(`[coverage] FAIL: coverage ${lineCoverage}% < ${minCoverage}%`);
  process.exit(1);
}
console.log('[coverage] PASS');
process.exit(result.status ?? 1);
