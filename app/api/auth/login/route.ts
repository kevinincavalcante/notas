import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { createToken, AUTH_COOKIE_NAME } from "@/lib/auth";

export async function POST(request: Request) {
  try {
    const { username, password } = await request.json();

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

    const response = NextResponse.json({
      success: true,
      user: { username: expectedUser },
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
