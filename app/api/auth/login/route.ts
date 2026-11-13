import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { writeFile, readFile } from "fs/promises";
import { dirname, join } from "path";
import { createToken, AUTH_COOKIE_NAME } from "@/lib/auth";
import { rateLimit, getClientIp } from "@/lib/rate-limit";
import { isDesktopLocalMode, getDesktopApiUrl } from "@/lib/desktop-session";

// 5 tentativas por IP a cada 15 minutos
const LOGIN_RATE_LIMIT = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

export async function POST(request: Request) {
  try {
    // Rate limiting ANTES do bcrypt: comparar hash é caro, e é o vetor de brute-force
    const clientIp = getClientIp(request);
    const rl = rateLimit(`login:${clientIp}`, LOGIN_RATE_LIMIT, LOGIN_WINDOW_MS);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: `Muitas tentativas. Tente novamente em ${rl.retryAfterSeconds} segundos.` },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } }
      );
    }

    const { username, password, apiUrl: apiUrlFromBody } = await request.json();

    // Desktop thin-client: as credenciais valem só na API remota — repassa o
    // login pra lá e guarda o JWT no arquivo de sessão que o sidecar lê por
    // requisição (anexos e sync). A página de login é a mesma do web.
    if (isDesktopLocalMode()) {
      // URL informada no campo do login tem prioridade; sem ela, usa a que
      // já estiver no config. Valida protocolo pra não virar fetch relativo.
      let apiUrl = (apiUrlFromBody || "").toString().trim().replace(/\/+$/, "");
      if (apiUrl) {
        try {
          const parsed = new URL(apiUrl);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
        } catch {
          return NextResponse.json(
            { error: "URL da API inválida — use http:// ou https://" },
            { status: 400 }
          );
        }
      } else {
        apiUrl = getDesktopApiUrl();
      }
      if (!apiUrl) {
        return NextResponse.json(
          { error: "Informe a URL da API no login" },
          { status: 400 }
        );
      }
      const upstream = await fetch(`${apiUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = (await upstream.json().catch(() => ({}))) as {
        token?: string;
        error?: string;
        user?: { username: string };
      };
      if (!upstream.ok || !data.token) {
        return NextResponse.json(
          { error: data.error || "Login falhou" },
          { status: upstream.status === 200 ? 500 : upstream.status }
        );
      }
      const sessionFile = process.env.NOTAS_SESSION_FILE;
      // Atualiza o env do processo vivo: sidecar e main compartilham o mesmo
      // process.env — sync e anexos passam a usar a URL nova sem restart
      process.env.NOTAS_API_URL = apiUrl;
      if (sessionFile) {
        await writeFile(sessionFile, data.token, "utf8");
        // Atualiza o config do Electron (mesmo formato de electron/config.ts):
        // apiUrl/username/token atualizados pro próximo boot — o main
        // re-cifra com safeStorage quando reescrever
        try {
          const configPath = join(dirname(sessionFile), "notas-config.json");
          let cfg: Record<string, unknown> = {};
          try {
            cfg = JSON.parse(await readFile(configPath, "utf8"));
          } catch {
            // config inexistente/corrompido: nasce novo
          }
          cfg.apiUrl = apiUrl;
          cfg.username = username;
          cfg.token = data.token;
          cfg.encrypted = false;
          await writeFile(configPath, JSON.stringify(cfg, null, 2), "utf8");
        } catch {
          // falha ao atualizar config não impede o login: o arquivo de
          // sessão já vale pra esta execução
        }
      }
      const response = NextResponse.json({ success: true, user: data.user ?? { username } });
      response.cookies.set({
        name: AUTH_COOKIE_NAME,
        value: data.token,
        httpOnly: true,
        secure: false, // sidecar local é http em 127.0.0.1
        sameSite: "strict",
        path: "/",
        maxAge: 30 * 24 * 60 * 60,
      });
      return response;
    }

    const expectedUser = (process.env.APP_USER || "admin").trim();
    // Limpa aspas e também desfaz escapes de barra invertida em '$' se tiver vindo de cópia do .env.local
    const expectedHash = (process.env.APP_PASSWORD_HASH || "")
      .trim()
      .replace(/^["']|["']$/g, "")
      .replace(/\\(\$)/g, "$1");
    const expectedPassword = process.env.APP_PASSWORD?.trim().replace(/^["']|["']$/g, "");

    if (!expectedHash && !expectedPassword) {
      return NextResponse.json(
        { error: "Servidor não configurado com APP_PASSWORD_HASH ou APP_PASSWORD" },
        { status: 500 }
      );
    }

    // Validação do nome de usuário (case-insensitive para evitar bloqueio por autocapitalize no celular)
    const inputUser = (username || "").trim();
    if (!inputUser || inputUser.toLowerCase() !== expectedUser.toLowerCase()) {
      console.warn(`[AUTH] Usuário divergente. Recebido: "${inputUser}", Esperado: "${expectedUser}"`);
      return NextResponse.json(
        { error: "Credenciais inválidas" },
        { status: 401 }
      );
    }

    // Validação da senha
    let isValid = false;
    if (expectedPassword && password === expectedPassword) {
      isValid = true;
    } else if (expectedHash) {
      isValid = await bcrypt.compare(password || "", expectedHash);
    }

    if (!isValid) {
      console.warn(`[AUTH] Senha não confere para "${inputUser}". (Hash configurado: ${!!expectedHash}, Plain configurado: ${!!expectedPassword})`);
      return NextResponse.json(
        { error: "Credenciais inválidas" },
        { status: 401 }
      );
    }

    const token = await createToken({ username: expectedUser });

    // `token` vai no corpo pro app mobile (Expo): guarda no SecureStore e
    // usa Authorization: Bearer — cookies HttpOnly são coisa de browser.
    const response = NextResponse.json({
      success: true,
      user: { username: expectedUser },
      token,
    });

    response.cookies.set({
      name: AUTH_COOKIE_NAME,
      value: token,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: 30 * 24 * 60 * 60, // 30 dias
    });

    return response;
  } catch (error) {
    console.error("Erro no login:", error);
    return NextResponse.json(
      { error: "Erro interno no servidor" },
      { status: 500 }
    );
  }
}
