import type { Client } from "@libsql/client";
import { syncOnceWith, type ReplicaSyncResult } from "@/lib/sync-core";
import type { SyncPush } from "@/lib/sync-types";

/**
 * Remoto via HTTP: POST /api/sync + Bearer JWT — o mesmo protocolo usado
 * pelo app mobile. Réplicas sem credenciais do Turso (celular, desktop
 * thin-client) sincronizam por aqui; quem tem credenciais (script de
 * teste) usa SQL direto.
 */

export interface SyncApiConfig {
  /** Base da API (ex: https://minha-api.vercel.app). */
  baseUrl: string;
  /** JWT do login. */
  token: string;
}

/** Função `run` pronta pro syncOnceWith/syncOnce/startSyncLoop. */
export function makeHttpSyncRun(
  api: SyncApiConfig,
  hooks: { onUnauthorized?: () => void } = {}
): (cursor: number, push: SyncPush) => Promise<Record<string, unknown>> {
  return async (cursor, push) => {
    const res = await fetch(`${api.baseUrl.replace(/\/+$/, "")}/api/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${api.token}`,
      },
      body: JSON.stringify({ cursor, push }),
    });

    if (res.status === 401) {
      hooks.onUnauthorized?.();
      throw new Error("Token expirado ou inválido — faça login novamente");
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Sync HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return (await res.json()) as Record<string, unknown>;
  };
}

/** Um ciclo de sync completo com remoto HTTP. */
export async function syncOnceHttp(
  local: Client,
  api: SyncApiConfig,
  hooks: { onUnauthorized?: () => void } = {}
): Promise<ReplicaSyncResult> {
  return syncOnceWith(local, makeHttpSyncRun(api, hooks));
}
