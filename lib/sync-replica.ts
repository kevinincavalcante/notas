import type { Client } from "@libsql/client";
import { runSync, type SyncPush } from "@/lib/sync";
import { deleteAttachmentFile } from "@/lib/storage";
import { syncOnceWith, type ReplicaSyncResult } from "@/lib/sync-core";

export type { ReplicaSyncResult } from "@/lib/sync-core";
export { getMeta, setMeta } from "@/lib/sync-core";

/**
 * Cliente de sync de uma réplica (desktop): leva as mudanças LOCAIS ao
 * remoto (push, LWW) e aplica as do remoto no local (pull), tudo por
 * cima do motor compartilhado (lib/sync.ts) — sem servidor HTTP no meio:
 * o Turso é o hub direto.
 *
 * O miolo (coleta de push, aplicação de pull, cursores) vive em
 * lib/sync-core.ts — o app mobile (Expo) roda o MESMO miolo com o remoto
 * via POST /api/sync + JWT (mobile/lib/sync.ts).
 *
 * Cursores guardados na tabela local `sync_meta`:
 * - sync_cursor: último seq do remoto já aplicado aqui
 * - sync_pushed_seq: último seq do change_log LOCAL já enviado
 *
 * Mudanças PUXADAS não entram no change_log local (senão a réplica
 * re-enviaria o que acabou de receber); as rotas de CRUD locais continuam
 * logando normalmente.
 */

/**
 * Executa UM ciclo de sincronização da réplica local contra o remoto.
 * Idempotente: chamar de novo sem mudanças é barato (só lê cursores).
 */
export function syncOnce(local: Client, remote: Client): Promise<ReplicaSyncResult> {
  return syncOnceWith(local, (cursor: number, push: SyncPush) => runSync(remote, cursor, push), {
    // Esta réplica tem credenciais do R2: apaga binários de notas excluídas
    deleteBinary: deleteAttachmentFile,
  });
}

/**
 * Laço de sync com backoff — usado pelo processo main do Electron.
 * `onStatus` é chamado no fim de TODO ciclo (ok ou falha) — é ele que
 * alimenta o indicador de sync da UI. Retorna a função de cancelamento.
 */
export function startSyncLoop(
  local: Client,
  remote: Client,
  options: {
    intervalMs?: number;
    onSync?: (r: ReplicaSyncResult) => void;
    onStatus?: (s: { ok: boolean; at: number; error?: string; changed?: boolean }) => void;
  } = {}
): () => void {
  const intervalMs = options.intervalMs || 30_000;
  let stopped = false;
  let failures = 0;

  const run = async () => {
    if (stopped) return;
    try {
      const r = await syncOnce(local, remote);
      failures = 0;
      options.onSync?.(r);
      options.onStatus?.({
        ok: true,
        at: Date.now(),
        changed:
          (r.pulledNotes || 0) + (r.pulledVersions || 0) + r.appliedTombstones + r.conflicts.length > 0,
      });
    } catch (err) {
      failures++;
      console.warn("[SYNC] falhou:", err);
      options.onStatus?.({
        ok: false,
        at: Date.now(),
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const backoff = Math.min(failures * intervalMs, 2 * 60_000);
    if (!stopped) setTimeout(run, intervalMs + backoff);
  };

  // primeiro ciclo logo no boot
  setTimeout(run, 3_000);

  return () => {
    stopped = true;
  };
}
