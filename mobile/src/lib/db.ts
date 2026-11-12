import { openDatabaseSync, type SQLiteDatabase } from "expo-sqlite";
import type { Client } from "@libsql/client";
import { ensureSchema } from "../../../lib/db-schema";
import { createExpoClient } from "./sqlite-client";

export * from "./db-core";

let dbp: Promise<{ db: SQLiteDatabase; client: Client }> | null = null;

/** Abre o banco uma única vez (schema idempotente). */
export function getDb(): Promise<{ db: SQLiteDatabase; client: Client }> {
  if (!dbp) {
    dbp = (async () => {
      const db = openDatabaseSync("notas.db");
      await db.execAsync("PRAGMA foreign_keys = ON");
      const client = createExpoClient(db);
      await ensureSchema(client);
      return { db, client };
    })();
  }
  return dbp;
}
