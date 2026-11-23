import { openDatabaseSync, type SQLiteDatabase } from "expo-sqlite";
import type { Client } from "@libsql/client";
import { ensureSchema } from "../../../lib/db-schema";
import { createExpoClient } from "./sqlite-client";
import { setLocalClientProvider } from "./sync";

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

/**
 * Registra o provedor JÁ no import deste módulo (não espera a Home montar).
 * Sem isso, um sync disparado pelo AppState no cold start (ou pelo share)
 * podia rodar antes do banco abrir e mostrar "banco local não inicializado".
 */
setLocalClientProvider(() => getDb().then((d) => d.client));
