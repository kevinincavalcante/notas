import type { Client } from "@libsql/client";
import { syncOnceWith, type ReplicaSyncResult } from "../../../lib/sync-core";

/**
 * Sync do celular: o MESMO miolo do desktop (lib/sync-core), com o remoto
 * via POST /api/sync + Bearer JWT — o APK não carrega credenciais do Turso.
 */

export interface SyncApiConfig {
  /** Base da API (ex: https://api.exemplo.invalid). */
  baseUrl: string;
  /** JWT do login, guardado no SecureStore. */
  token: string;
}

export async function syncOnceHttp(
  local: Client,
  api: SyncApiConfig
): Promise<ReplicaSyncResult> {
  return syncOnceWith(local, async (cursor, push) => {
    const res = await fetch(`${api.baseUrl}/api/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${api.token}`,
      },
      body: JSON.stringify({ cursor, push }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Sync HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    return (await res.json()) as Record<string, unknown>;
  });
}

// ---- Sync de fundo (usado pelas telas) ----

const subs = new Set<() => void>();

/**
 * Provedor do banco local — setado no boot do app (evita importar o
 * expo-sqlite aqui, o que arrastaria react-native pro teste em Node).
 */
let clientProvider: () => Promise<Client> = async () => {
  throw new Error("banco local não inicializado");
};

export function setLocalClientProvider(fn: () => Promise<Client>): void {
  clientProvider = fn;
}

/** Chama `fn` ao fim de cada sync ou alteração local (pra telas recarregarem). */
export function onSynced(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

/** Avisa as telas montadas que o banco local mudou (ex: flush no unmount do editor). */
export function notifyLocalChange(): void {
  subs.forEach((fn) => fn());
}

let inFlight = false;
let lastResult: ReplicaSyncResult | null = null;
let lastError: string | null = null;

export function getLastSync(): { result: ReplicaSyncResult | null; error: string | null } {
  return { result: lastResult, error: lastError };
}

/**
 * Um ciclo silencioso — barra múltiplas chamadas em paralelo e avisa
 * as telas no fim. Falha só registra (tenta de novo na próxima).
 */
export async function syncQuiet(api: SyncApiConfig): Promise<boolean> {
  if (inFlight) return false;
  inFlight = true;
  try {
    const client = await clientProvider();
    lastResult = await syncOnceHttp(client, api);
    lastError = null;
    subs.forEach((fn) => fn());
    return true;
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    return false;
  } finally {
    inFlight = false;
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;

/** Agendar sync logo após uma mutação local (debounce curto). */
export function scheduleQuietSync(api: SyncApiConfig, delayMs = 900): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void syncQuiet(api);
  }, delayMs);
}
