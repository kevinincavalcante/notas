import { cookies } from "next/headers";
import { NextRequest } from "next/server";
import { verifyToken, AUTH_COOKIE_NAME, type SessionPayload } from "@/lib/jwt";

export { createToken, verifyToken, AUTH_COOKIE_NAME, type SessionPayload } from "@/lib/jwt";

export async function getSession(): Promise<SessionPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(AUTH_COOKIE_NAME)?.value;
  if (!token) return null;
  return verifyToken(token);
}

export async function getSessionFromRequest(req: NextRequest): Promise<SessionPayload | null> {
  const token =
    req.cookies.get(AUTH_COOKIE_NAME)?.value ||
    // App mobile (Expo): Bearer token no header em vez de cookie
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ||
    "";
  if (!token) return null;
  return verifyToken(token);
}
