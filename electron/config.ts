import { app, safeStorage } from "electron";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

/**
 * Config do desktop thin-client (userData/notas-config.json):
 * só API + usuário + token — ZERO credenciais de Turso/R2.
 * O token é cifrado com o cofre do SO quando disponível.
 */

export interface DesktopConfig {
  apiUrl: string;
  username?: string;
  /** token cifrado (safeStorage) ou plain, conforme encrypted */
  token?: string;
  encrypted?: boolean;
  /** secreto do sidecar local (gerado uma vez) */
  localSecret?: string;
}

export const DEFAULT_API_URL = "";

const configPath = join(app.getPath("userData"), "notas-config.json");

export function loadConfig(): DesktopConfig {
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as DesktopConfig;
    return { apiUrl: DEFAULT_API_URL, ...raw };
  } catch {
    return { apiUrl: DEFAULT_API_URL };
  }
}

export function saveConfig(patch: Partial<DesktopConfig>): DesktopConfig {
  const next = { ...loadConfig(), ...patch };
  writeFileSync(configPath, JSON.stringify(next, null, 2));
  return next;
}

export function encryptToken(token: string): { token: string; encrypted: boolean } {
  if (safeStorage?.isEncryptionAvailable?.()) {
    return {
      token: safeStorage.encryptString(token).toString("base64"),
      encrypted: true,
    };
  }
  return { token, encrypted: false }; // fallback: texto puro (SO sem cofre)
}

export function decryptToken(stored: string | undefined, encrypted: boolean | undefined): string | null {
  if (!stored) return null;
  if (encrypted) {
    try {
      return safeStorage.decryptString(Buffer.from(stored, "base64"));
    } catch {
      return null;
    }
  }
  // Se não foi marcado explicitamente como encrypted, testa se é um JWT válido em texto puro
  if (stored.startsWith("ey")) {
    return stored;
  }
  // Tenta descriptografar caso tenha sido salvo criptografado sem a flag
  if (safeStorage?.isEncryptionAvailable?.()) {
    try {
      return safeStorage.decryptString(Buffer.from(stored, "base64"));
    } catch {
      return null;
    }
  }
  return null;
}

export function getSessionToken(): string | null {
  const cfg = loadConfig();
  return decryptToken(cfg.token, cfg.encrypted);
}

export function configExists(): boolean {
  return existsSync(configPath);
}
