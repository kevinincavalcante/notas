import * as SecureStore from "expo-secure-store";

/**
 * Cliente HTTP da app mobile: login, guarda o JWT no SecureStore
 * (cofre do sistema) e monta as chamadas com Authorization: Bearer.
 */

const TOKEN_KEY = "notas_auth_token";
const USER_KEY = "notas_api_url";
const USER_NAME_KEY = "notas_user_name";

/** Sem default embutido: a URL da API é digitada no login e fica no SecureStore. */
export const DEFAULT_API_URL = "";

export async function getApiUrl(): Promise<string> {
  return (await SecureStore.getItemAsync(USER_KEY)) || DEFAULT_API_URL;
}

export async function setApiUrl(url: string): Promise<void> {
  const clean = url.trim().replace(/\/+$/, "");
  if (!clean || clean === DEFAULT_API_URL) {
    await SecureStore.deleteItemAsync(USER_KEY);
    return;
  }
  await SecureStore.setItemAsync(USER_KEY, clean);
}

export async function getStoredToken(): Promise<string | null> {
  return SecureStore.getItemAsync(TOKEN_KEY);
}

export async function getStoredUser(): Promise<string | null> {
  return SecureStore.getItemAsync(USER_NAME_KEY);
}

export interface LoginResult {
  ok: boolean;
  error?: string;
}

export async function login(username: string, password: string): Promise<LoginResult> {
  const baseUrl = await getApiUrl();
  if (!baseUrl) return { ok: false, error: "URL da API não configurada." };
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
  } catch {
    return { ok: false, error: "Sem conexão com a API. Confira o endereço." };
  }

  const data = (await res.json().catch(() => ({}))) as {
    token?: string;
    error?: string;
    user?: { username?: string };
  };

  if (!res.ok || !data.token) {
    return { ok: false, error: data.error || "Login falhou." };
  }

  await SecureStore.setItemAsync(TOKEN_KEY, data.token);
  await SecureStore.setItemAsync(USER_NAME_KEY, data.user?.username || username);
  return { ok: true };
}

export async function logout(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
  await SecureStore.deleteItemAsync(USER_NAME_KEY);
}

/** Headers de auth pra qualquer chamada à API. */
export async function authHeaders(): Promise<Record<string, string>> {
  const token = await getStoredToken();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

/** Config pronta pro sync — null quando não está logado. */
export async function getSyncApi(): Promise<{ baseUrl: string; token: string } | null> {
  const token = await getStoredToken();
  if (!token) return null;
  return { baseUrl: await getApiUrl(), token };
}
