import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");

export function createSqliteD1(dbPath = ":memory:", { migrate = true } = {}) {
  const sqlite = new DatabaseSync(dbPath);
  sqlite.exec("PRAGMA foreign_keys = ON;");

  const d1 = {
    sqlite,
    prepare(sql) {
      return createPreparedStatement(sqlite, sql, []);
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((stmt) => stmt._runSync());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    close() {
      sqlite.close();
    }
  };

  if (migrate) {
    applyMigrations(sqlite);
  }

  return d1;
}

export function applyMigrations(sqlite, maxMigration = null) {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    if (maxMigration && file > maxMigration) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    sqlite.exec(sql);
  }
}

function createPreparedStatement(sqlite, sql, args) {
  const normalizedArgs = args.map((value) => (value === undefined ? null : value));
  return {
    bind(...boundArgs) {
      return createPreparedStatement(sqlite, sql, boundArgs);
    },
    async first() {
      const row = sqlite.prepare(sql).get(...normalizedArgs);
      return row ?? null;
    },
    async all() {
      const results = sqlite.prepare(sql).all(...normalizedArgs);
      return { success: true, results };
    },
    _runSync() {
      const info = sqlite.prepare(sql).run(...normalizedArgs);
      return {
        success: true,
        meta: {
          changes: Number(info.changes),
          last_row_id: Number(info.lastInsertRowid)
        }
      };
    },
    async run() {
      return this._runSync();
    }
  };
}
