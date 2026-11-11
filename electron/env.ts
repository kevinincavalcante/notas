import { app } from "electron";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

/**
 * Carrega a config ANTES de qualquer import de lib (lib/turso.ts abre o
 * client de banco no load do módulo). Este módulo é importado PRIMEIRO
 * no main.ts — a ordem dos imports é o contrato aqui.
 */

function loadEnvFile(path: string): boolean {
  if (!existsSync(path)) return false;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i !== -1 && !process.env[t.slice(0, i).trim()]) {
      process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
  return true;
}

const isDev = !app.isPackaged;

let envSource = "nenhum arquivo";
if (isDev) {
  if (loadEnvFile(join(process.cwd(), ".env.local"))) envSource = ".env.local (dev)";
} else {
  // Empacotado: config do usuário em ~/.config/Notas/notas.env
  if (loadEnvFile(join(app.getPath("userData"), "notas.env"))) envSource = "notas.env (usuário)";
}

// Banco local da réplica — lib/turso.ts lê NOTES_DB_PATH no load
const localDbPath =
  process.env.NOTES_DB_PATH?.trim() || join(app.getPath("userData"), "notas.db");
process.env.NOTES_DB_PATH = localDbPath;

export { envSource, localDbPath, isDev };
