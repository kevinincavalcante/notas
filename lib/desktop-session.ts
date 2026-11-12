import { readFile } from "fs/promises";

/**
 * Modo desktop thin-client (Electron): o sidecar local não carrega
 * credenciais de Turso/R2 — o upload/download de anexos e qualquer coisa
 * de servidor é encaminhado pra API real com o JWT do usuário.
 *
 * O token fica num arquivo de sessão que o processo main escreve a cada
 * login (lido por requisição — o token muda no re-login).
 */

export function isDesktopLocalMode(): boolean {
  return process.env.NOTAS_LOCAL === "1";
}

export function isR2Configured(): boolean {
  return Boolean(
    process.env.R2_ENDPOINT && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY
  );
}

export async function getDesktopSessionToken(): Promise<string | null> {
  const file = process.env.NOTAS_SESSION_FILE;
  if (!file) return null;
  try {
    const token = (await readFile(file, "utf8")).trim();
    return token || null;
  } catch {
    return null;
  }
}

export function getDesktopApiUrl(): string {
  return (process.env.NOTAS_API_URL || "").replace(/\/+$/, "");
}
