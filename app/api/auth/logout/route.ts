import { NextResponse } from "next/server";
import { writeFile } from "fs/promises";
import { AUTH_COOKIE_NAME } from "@/lib/auth";
import { isDesktopLocalMode } from "@/lib/desktop-session";

export async function POST() {
  // Desktop thin-client: limpa o arquivo de sessão que o sidecar lê — sync e
  // anexos ficam sem token até o próximo login (a config cifrada do main
  // continua como fallback, mas o arquivo vazio vence na leitura fresca)
  if (isDesktopLocalMode() && process.env.NOTAS_SESSION_FILE) {
    try {
      await writeFile(process.env.NOTAS_SESSION_FILE, "", "utf8");
    } catch {
      // sem arquivo de sessão acessível, segue o fluxo normal
    }
  }

  const response = NextResponse.json({ success: true });
  response.cookies.delete(AUTH_COOKIE_NAME);
  return response;
}
