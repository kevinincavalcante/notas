import { app } from "electron";
import { join } from "path";
import { randomBytes } from "crypto";
import { writeFileSync } from "fs";import { loadConfig, saveConfig } from "./config";

/**
 * ESCREVE userData/notas-local.env ANTES de qualquer import de lib —
 * este módulo é importado PRIMEIRO no main.ts (a ordem é contrato).
 * É o env do sidecar: thin-client, sem Turso/R2.
 */
const userData = app.getPath("userData");
const cfg = loadConfig();
const secret = cfg.localSecret || randomBytes(32).toString("hex");

const localEnvPath = join(userData, "notas-local.env");
const sessionFile = join(userData, "notas-session.token");
writeFileSync(
  localEnvPath,
  [
    `NOTES_DB_PATH=${join(userData, "notas.db")}`,
    `JWT_SECRET=${secret}`,
    `NOTAS_LOCAL=1`,
    `NOTAS_API_URL=${cfg.apiUrl}`,
    `NOTAS_SESSION_FILE=${sessionFile}`,
    "",
  ].join("\n")
);

if (!cfg.localSecret) saveConfig({ localSecret: secret });

/**
 * Grava o token da sessão atual no arquivo que o sidecar lê por requisição.
 *
 * NÃO pode rodar no load do módulo: safeStorage (cofre do SO) só funciona
 * depois de app.whenReady() — antes disso a descriptografia falha e o
 * arquivo era gravado vazio, matando TODO anexo (imagem/áudio) no thin-client
 * com 401, enquanto o sync (que lê o config direto) seguia funcionando.
 * Chamar depois do whenReady (main.ts, antes de subir o sidecar) e no login.
 */
export function writeSessionFile(): void {
  try {
    writeFileSync(sessionFile, getSessionToken() || "");
  } catch (err) {
    console.warn("[Notas] falha ao gravar arquivo de sessão:", err);
  }
}
