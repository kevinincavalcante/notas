import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { createToken, AUTH_COOKIE_NAME } from "@/lib/auth";

export async function POST(request: Request) {
  try {
    const { username, password } = await request.json();

    const expectedUser = (process.env.APP_USER || "admin").trim();
    const expectedHash = (process.env.APP_PASSWORD_HASH || "").trim().replace(/^["']|["']$/g, "");
    const expectedPassword = process.env.APP_PASSWORD;

    if (!expectedHash && !expectedPassword) {
      return NextResponse.json(
        { error: "Servidor não configurado com APP_PASSWORD_HASH ou APP_PASSWORD" },
        { status: 500 }
      );
    }

    // Validação do nome de usuário
    const inputUser = (username || "").trim();
    if (!inputUser || inputUser !== expectedUser) {
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
