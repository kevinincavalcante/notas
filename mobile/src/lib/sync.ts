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
