// Sync do celular: o MESMO miolo do desktop (lib/sync-core), com o remoto
// via POST /api/sync + Bearer JWT — o APK não carrega credenciais do Turso.
// O remoto HTTP vive na lib compartilhada (mesma peça que o desktop usa):
export { syncOnceHttp, makeHttpSyncRun, type SyncApiConfig } from "../../../lib/sync-http";
import type { SyncApiConfig } from "../../../lib/sync-http";
import type { Client } from "@libsql/client";
import type { ReplicaSyncResult } from "../../../lib/sync-core";
import { syncOnceHttp } from "../../../lib/sync-http";

// ---- Sync de fundo (usado pelas telas) ----

const subs = new Set<() => void>();

/**
 * Provedor do banco local — registrado no boot (db.ts) para evitar importar
 * expo-sqlite aqui, o que arrastaria react-native pro teste em Node.
 *
 * Fica DEFERIDO de propósito: um sync pode começar antes do banco abrir (o
 * AppState "active" do cold start dispara junto com o boot). Antes isso
 * virava o erro "banco local não inicializado" na cara do usuário; agora a
 * chamada espera o provedor ser registrado e segue — o "toque pra tentar de
 * novo" deixa de ser necessário.
 */
let clientProvider: (() => Promise<Client>) | null = null;
let resolveProvider: ((fn: () => Promise<Client>) => void) | null = null;
const providerReady = new Promise<() => Promise<Client>>((resolve) => {
  resolveProvider = resolve;
});

export function setLocalClientProvider(fn: () => Promise<Client>): void {
  clientProvider = fn;
  resolveProvider?.(fn);
  resolveProvider = null;
}

/** Espera o provedor (com teto, pra nunca pendurar um sync pra sempre). */
async function getClientProvider(): Promise<() => Promise<Client>> {
  if (clientProvider) return clientProvider;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      providerReady,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("banco local não inicializado")), 5000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

let activeSyncPromise: Promise<boolean> | null = null;
let lastResult: ReplicaSyncResult | null = null;
let lastError: string | null = null;

export function getLastSync(): { result: ReplicaSyncResult | null; error: string | null } {
  return { result: lastResult, error: lastError };
}

/**
 * Um ciclo silencioso — barra múltiplas chamadas em paralelo aguardando o ciclo
 * ativo terminar e avisa as telas no fim. Falha só registra (tenta de novo na próxima).
 */
export async function syncQuiet(api: SyncApiConfig): Promise<boolean> {
  if (activeSyncPromise) return activeSyncPromise;

  activeSyncPromise = (async () => {
    try {
      const provider = await getClientProvider();
      const client = await provider();
      lastResult = await syncOnceHttp(client, api);
      lastError = null;
      subs.forEach((fn) => fn());
      return true;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      activeSyncPromise = null;
    }
  })();

  return activeSyncPromise;
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
