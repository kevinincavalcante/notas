import type { Client, InStatement, ResultSet } from "@libsql/client";

/**
 * Adaptador: banco SQLite do celular → interface `Client` do libSQL.
 *
 * O motor de sync (lib/sync-core.ts) é parametrizado por `Client` — com
 * este adaptador ele roda no expo-sqlite sem uma linha alterada.
 *
 * Duck-typed de propósito: o tipo real do expo-sqlite vem só como `import
 * type` (apagado em runtime), então o teste e2e em Node passa um shim com
 * a MESMA API e valida o adaptador de verdade.
 */
export interface MinimalSqliteDatabase {
  getAllAsync(sql: string, ...params: unknown[]): Promise<unknown[]>;
  runAsync(
    sql: string,
    ...params: unknown[]
  ): Promise<{ changes: number; lastInsertRowid?: number | bigint }>;
  execAsync(sql: string): Promise<void>;
}

const READ_RE = /^\s*(SELECT|WITH|PRAGMA|VALUES)\b/i;

export function createExpoClient(db: MinimalSqliteDatabase): Client {
  const execute = async (stmt: InStatement): Promise<ResultSet> => {
    const sql = typeof stmt === "string" ? stmt : stmt.sql;
    const rawArgs = typeof stmt === "string" ? undefined : stmt.args;
    const params: unknown[] =
      rawArgs === undefined
        ? []
        : Array.isArray(rawArgs)
          ? rawArgs
          : [rawArgs];

    if (READ_RE.test(sql)) {
      const rows = (await db.getAllAsync(sql, ...params)) as Record<
        string,
        unknown
      >[];
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
      return {
        columns,
        rows,
        rowsAffected: 0,
        lastInsertRowid: undefined,
      } as unknown as ResultSet;
    }

    const result = await db.runAsync(sql, ...params);
    return {
      columns: [],
      rows: [],
      rowsAffected: Number(result.changes),
      lastInsertRowid:
        result.lastInsertRowid === undefined ? undefined : Number(result.lastInsertRowid),
    } as unknown as ResultSet;
  };

  return {
    execute,
    executeMultiple: async (sql: string): Promise<void> => {
      await db.execAsync(sql);
    },
    batch: async (stmts: InStatement[]): Promise<void> => {
      for (const stmt of stmts) {
        await execute(stmt);
      }
    },
  } as unknown as Client;
}
