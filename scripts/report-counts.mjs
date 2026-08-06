import 'dotenv/config';
import pg from 'pg';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const q = async (sql) => (await client.query(sql)).rows[0].n;

const rows = [
  ['anime', await q('SELECT count(*)::int AS n FROM anime')],
  ['genres', await q('SELECT count(*)::int AS n FROM genres')],
  ['anime_genres', await q('SELECT count(*)::int AS n FROM anime_genres')],
  ['studios', await q('SELECT count(*)::int AS n FROM studios')],
  ['anime_studios', await q('SELECT count(*)::int AS n FROM anime_studios')],
  ['characters', await q('SELECT count(*)::int AS n FROM characters')],
  ['anime_characters', await q('SELECT count(*)::int AS n FROM anime_characters')],
  ['staff (voice actors)', await q('SELECT count(*)::int AS n FROM staff')],
  ['character_staff', await q('SELECT count(*)::int AS n FROM character_staff')],
  ['episodes', await q('SELECT count(*)::int AS n FROM episodes')],
];
for (const [t, n] of rows) console.log(t.padEnd(22), n);

const top = await client.query(
  'SELECT title_romaji, format, status, episodes FROM anime ORDER BY popularity DESC NULLS LAST LIMIT 5',
);
console.log('\nTop-imported titles:');
for (const r of top.rows) {
  console.log(`  - ${r.title_romaji} [${r.format}/${r.status}] ${r.episodes ? `${r.episodes} eps` : ''}`);
}
await client.end();
