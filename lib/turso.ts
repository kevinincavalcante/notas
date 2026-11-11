import { createClient, type Client } from "@libsql/client";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";

/**
 * Driver do banco, escolhido por ambiente:
 *
 * - Desktop (Electron): NOTES_DB_PATH definido → SQLite local em arquivo.
 *   Todo carregamento é leitura de disco — instantâneo, offline-first;
 *   a sincronização acontece em background pelo motor de sync (lib/sync-replica.ts).
 * - Web/hospedado: TURSO_URL / TURSO_LINK → Turso (libSQL remoto).
 *
 * As duas opções usam a MESMA API (@libsql/client) — o app inteiro não faz
 * ideia de qual banco está por trás.
 */

const localPath = process.env.NOTES_DB_PATH?.trim();
const url = localPath
  ? `file:${localPath}`
  : process.env.TURSO_URL || process.env.TURSO_LINK || "";
const authToken = process.env.TURSO_TOKEN || process.env.TURSO_AUTH_TOKEN || "";

if (!url) {
  console.warn("⚠️ Nenhum banco configurado (NOTES_DB_PATH ou TURSO_LINK).");
}

if (localPath && !existsSync(localPath)) {
  try {
    mkdirSync(dirname(localPath), { recursive: true });
  } catch {
    // libSQL reportará o erro real ao abrir
  }
}

export const db: Client = createClient({
  url,
  authToken: localPath ? undefined : authToken,
});

/** true quando o app está rodando sobre banco local (desktop). */
export const isLocalDb = Boolean(localPath);
