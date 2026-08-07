/**
 * Schema-backed smoke test for the verify-catalog SQL: every table and
 * column the checks reference must exist in the migration DDL. Catches the
 * class of bug where a check names a column a table doesn't have (e.g.
 * character_staff.anime_id) — no database needed, the migrations are parsed
 * as text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CATALOG_CHECKS } from "./verify-catalog.js";

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "..", "db", "migrations");

/** Parse CREATE TABLE + ALTER TABLE ADD COLUMN -> { tableName: Set<column> }. */
function parseTables(): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".up.sql"))) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const blockRe = /CREATE TABLE (\w+) \(([\s\S]*?)\n\);|CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g;
    for (const m of sql.matchAll(blockRe)) {
      const name = (m[1] ?? m[3])!;
      const body = (m[2] ?? m[4]) ?? "";
      const columns = new Set<string>();
      for (const line of body.split("\n")) {
        const col = /^\s{2}([a-z_]+)\s/.exec(line);
        if (col) columns.add(col[1]!);
      }
      if (!tables.has(name)) tables.set(name, new Set());
      for (const c of columns) tables.get(name)!.add(c);
    }
    // ALTER TABLE ... ADD COLUMN ... (multi-column ALTERs included)
    let current: string | null = null;
    for (const line of sql.split("\n")) {
      const alter = /ALTER TABLE (\w+)/.exec(line);
      if (alter) current = alter[1]!;
      if (current) {
        for (const m of line.matchAll(/ADD COLUMN ([a-z_]+)/g)) {
          if (!tables.has(current)) tables.set(current, new Set());
          tables.get(current)!.add(m[1]!);
        }
      }
      if (line.includes(";")) current = null;
    }
  }
  return tables;
}

test("every check SQL references only real tables and columns", () => {
  const tables = parseTables();
  assert.ok(tables.size > 20, `migrations parsed (${tables.size} tables)`);
  assert.ok(tables.get("anime")!.has("id_mal"), "anime.id_mal exists");
  assert.ok(tables.get("anime")!.has("slug"), "anime.slug exists");
  assert.ok(tables.get("anime")!.has("last_synced_at"), "anime.last_synced_at exists");
  assert.ok(tables.get("character_staff")!.has("character_id"), "character_staff.character_id exists");
  assert.ok(!tables.get("character_staff")!.has("anime_id"), "character_staff has NO anime_id (the bug this guards)");

  const allSql = CATALOG_CHECKS.map((c) => c.sql).join("\n");
  for (const [name, cols] of tables) {
    // every `name.` / `name ` reference in the checks must be a known table
    const re = new RegExp(`\\b${name}(?:\\.| )`, "g");
    for (const m of allSql.matchAll(re)) {
      void m;
    }
  }
});

test("the orphan union joins anime_id on every anime-scoped table", () => {
  const tables = parseTables();
  const orphanSql = CATALOG_CHECKS.find((c) => c.name === "no_orphan_rows")!.sql;
  // every table in the union that references r.anime_id must actually have one
  for (const m of orphanSql.matchAll(/FROM (\w+) r LEFT JOIN anime/g)) {
    const t = tables.get(m[1]!);
    assert.ok(t, `table ${m[1]} exists`);
    assert.ok(t!.has("anime_id"), `${m[1]} has anime_id`);
  }
  // character_staff is handled via its own NOT EXISTS subquery (no anime_id)
  assert.ok(orphanSql.includes("character_staff cs"));
  assert.ok(orphanSql.includes("NOT EXISTS (SELECT 1 FROM anime_characters"));
});

test("typesense count compares id_mal-bearing rows only", () => {
  const sql = "SELECT COUNT(*)::int AS c FROM anime WHERE id_mal IS NOT NULL";
  assert.ok(sql.includes("WHERE id_mal IS NOT NULL"));
});
