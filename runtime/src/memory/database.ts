import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { RpcError } from "../ipc/peer.ts";
import { ErrorCodes } from "../protocol.ts";
import type { TenantPaths } from "../tenant.ts";

type Row = { payload: string; version: number };
type Query = (sql: string, values?: (string | number)[]) => Promise<{ rows: Row[]; changes: number }>;
export type Stored<T> = { value: T; version: number };

/** Primary-key violations from SQLite (1555/2067), MySQL (1062) and PostgreSQL (23505). */
function isDuplicateKey(error: unknown): boolean {
  const e = error as { errcode?: unknown; errno?: unknown; code?: unknown } | null;
  return e?.errcode === 1555 || e?.errcode === 2067 || e?.errno === 1062 || e?.code === "ER_DUP_ENTRY" || e?.code === "23505";
}
const conflict = () => new RpcError(ErrorCodes.conflict, "record changed concurrently; reload and retry");

/** One parameterized record format across SQL dialects; versions prevent silent lost updates. */
export class DatabaseStore {
  constructor(private query: Query, private disconnect: () => Promise<void>) {}

  async init() {
    await this.query(`CREATE TABLE IF NOT EXISTS forge_records (
      workspace VARCHAR(128) NOT NULL, user_id VARCHAR(128) NOT NULL,
      kind VARCHAR(16) NOT NULL, id VARCHAR(128) NOT NULL,
      payload TEXT NOT NULL, version INTEGER NOT NULL,
      PRIMARY KEY (workspace, user_id, kind, id)
    )`);
  }
  private scope(paths: TenantPaths, kind: string) { return [paths.tenant.workspace, paths.tenant.userId, kind]; }
  async list<T>(paths: TenantPaths, kind: string): Promise<T[]> {
    const result = await this.query("SELECT payload, version FROM forge_records WHERE workspace = ? AND user_id = ? AND kind = ?", this.scope(paths, kind));
    return result.rows.map((r) => JSON.parse(r.payload) as T);
  }
  async get<T>(paths: TenantPaths, kind: string, id: string): Promise<Stored<T> | undefined> {
    const result = await this.query("SELECT payload, version FROM forge_records WHERE workspace = ? AND user_id = ? AND kind = ? AND id = ?", [...this.scope(paths, kind), id]);
    const row = result.rows[0];
    return row ? { value: JSON.parse(row.payload) as T, version: Number(row.version) } : undefined;
  }
  async put<T>(paths: TenantPaths, kind: string, id: string, value: T, version: number): Promise<number> {
    const scope = [...this.scope(paths, kind), id];
    if (version === 0) {
      try {
        await this.query("INSERT INTO forge_records (workspace, user_id, kind, id, payload, version) VALUES (?, ?, ?, ?, ?, ?)", [...scope, JSON.stringify(value), 1]);
      } catch (error) {
        throw isDuplicateKey(error) ? conflict() : error;
      }
    } else {
      const result = await this.query("UPDATE forge_records SET payload = ?, version = ? WHERE workspace = ? AND user_id = ? AND kind = ? AND id = ? AND version = ?", [JSON.stringify(value), version + 1, ...scope, version]);
      if (result.changes !== 1) throw conflict();
    }
    return version + 1;
  }
  async remove(paths: TenantPaths, kind: string, id: string, version: number) {
    const result = await this.query("DELETE FROM forge_records WHERE workspace = ? AND user_id = ? AND kind = ? AND id = ? AND version = ?", [...this.scope(paths, kind), id, version]);
    if (result.changes !== 1) throw conflict();
  }
  close() { return this.disconnect(); }
}

export let database: DatabaseStore | undefined;

export async function configureStorage(dataDir: string): Promise<void> {
  const driver = process.env.FORGE_STORAGE ?? "file";
  if (driver === "file") return;
  let query: Query;
  let close: () => Promise<void>;
  if (driver === "sqlite") {
    const { DatabaseSync } = await import("node:sqlite");
    const path = resolve(process.env.FORGE_SQLITE_PATH ?? `${dataDir}/conversations.sqlite`);
    await mkdir(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    query = async (sql, values = []) => {
      const statement = db.prepare(sql);
      return sql.startsWith("SELECT")
        ? { rows: statement.all(...values) as Row[], changes: 0 }
        : { rows: [], changes: Number(statement.run(...values).changes) };
    };
    close = async () => { db.close(); };
  } else if (driver === "mysql") {
    if (!process.env.FORGE_DATABASE_URL) throw new Error("FORGE_DATABASE_URL is required for mysql");
    const { createPool } = await import("mysql2/promise");
    const pool = createPool(process.env.FORGE_DATABASE_URL);
    query = async (sql, values = []) => {
      // LONGTEXT holds full histories; binary collation preserves case-sensitive tenant identities.
      const mysql = sql.replace("payload TEXT", "payload LONGTEXT") + (sql.startsWith("CREATE TABLE") ? " CHARACTER SET utf8mb4 COLLATE utf8mb4_bin" : "");
      const [result] = await pool.execute(mysql, values);
      return { rows: Array.isArray(result) ? result as Row[] : [], changes: "affectedRows" in result ? result.affectedRows : 0 };
    };
    close = () => pool.end();
  } else if (driver === "pgsql" || driver === "postgres" || driver === "postgresql") {
    if (!process.env.FORGE_DATABASE_URL) throw new Error("FORGE_DATABASE_URL is required for pgsql");
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: process.env.FORGE_DATABASE_URL });
    query = async (sql, values = []) => {
      let index = 0;
      const result = await pool.query(sql.replace(/\?/g, () => `$${++index}`), values);
      return { rows: result.rows as Row[], changes: result.rowCount ?? 0 };
    };
    close = () => pool.end();
  } else {
    throw new Error("FORGE_STORAGE must be file, sqlite, mysql or pgsql");
  }
  const store = new DatabaseStore(query, close);
  try { await store.init(); } catch (error) { await store.close(); throw error; }
  database = store;
}
