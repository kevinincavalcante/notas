import { SignJWT, jwtVerify } from "jose";

/**
 * Secret do JWT sem fallback inseguro: em produção a ausência de JWT_SECRET
 * é um erro fatal; em desenvolvimento apenas avisa (DX local).
 */
const INSECURE_DEV_SECRET = "default_insecure_secret_replace_in_env_local";

function getJwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET?.trim();
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "JWT_SECRET não configurado. Defina uma chave de alta entropia no .env.local antes de rodar em produção."
      );
    }
    console.warn(
      "[AUTH] JWT_SECRET ausente — usando segredo inseguro de desenvolvimento. NÃO use em produção!"
    );
    return new TextEncoder().encode(INSECURE_DEV_SECRET);
  }
  if (secret.length < 32) {
    console.warn(
      "[AUTH] JWT_SECRET com menos de 32 caracteres — recomenda-se uma chave de alta entropia."
    );
  }
  return new TextEncoder().encode(secret);
}

export const AUTH_COOKIE_NAME = "auth_token";
const TOKEN_EXPIRY = "30d";

export interface SessionPayload {
  username: string;
}

export async function createToken(payload: SessionPayload): Promise<string> {
  return await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(TOKEN_EXPIRY)
    .sign(getJwtSecret());
}

export async function verifyToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    return payload as unknown as SessionPayload;
  } catch {
    return null;
  }
}
