import type { Client } from "@libsql/client";
import { runSync, type SyncPush } from "@/lib/sync";
import { deleteAttachmentFile } from "@/lib/storage";

/**
 * Cliente de sync de uma réplica (desktop): leva as mudanças LOCAIS ao
 * remoto (push, LWW) e aplica as do remoto no local (pull), tudo por
 * cima do motor compartilhado (lib/sync.ts) — sem servidor HTTP no meio:
 * o Turso é o hub direto.
 *
 * Cursores guardados na tabela local `sync_meta`:
 * - sync_cursor: último seq do remoto já aplicado aqui
 * - sync_pushed_seq: último seq do change_log LOCAL já enviado
 *
 * Mudanças PUXADAS não entram no change_log local (senão a réplica
 * re-enviaria o que acabou de receber); as rotas de CRUD locais continuam
 * logando normalmente.
 */

export interface ReplicaSyncResult {
  ok: boolean;
  cursor: number;
  pushedNotes: number;
  pushedVersions: number;
  pulledNotes: number;
  pulledVersions: number;
  appliedTombstones: number;
  conflicts: string[];
  error?: string;
}

async function getMeta(client: Client, key: string): Promise<number> {
  const res = await client.execute({
    sql: `SELECT value FROM sync_meta WHERE key = ?`,
    args: [key],
  });
  return Number(res.rows[0]?.value) || 0;
}

async function setMeta(client: Client, key: string, value: number): Promise<void> {
  await client.execute({
    sql: `
      INSERT INTO sync_meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `,
    args: [key, String(value)],
  });
}

/** Coleta as mudanças locais pendentes de envio, por entidade. */
async function collectLocalPush(
  local: Client,
  pushedSeq: number,
  versionsWatermark: number
): Promise<SyncPush> {
  const logRes = await local.execute({
    sql: `SELECT entity, entity_id, op FROM change_log WHERE seq > ? ORDER BY seq ASC`,
    args: [pushedSeq],
  });

  const noteIds = new Set<string>();
  const attUpserts = new Set<string>();
  const attRemoved: string[] = [];
  const tombIds = new Set<string>();

  for (const row of logRes.rows) {
    const entity = row.entity as string;
    const entityId = row.entity_id as string;
    const op = row.op as string;

    if (entity === "note" && op === "upsert") noteIds.add(entityId);
    else if (entity === "tombstone") tombIds.add(entityId);
    else if (entity === "attachment") {
      if (op === "upsert") attUpserts.add(entityId);
      else attRemoved.push(entityId);
    }
  }

  const push: SyncPush = {
    notes: [],
    attachments: [],
    attachments_removed: attRemoved,
    tombstones: [],
    versions: [],
  };

  const idList = (set: Set<string>) => Array.from(set);
  const placeholders = (n: number) => n > 0 ? Array.from({ length: n }, () => "?").join(",") : "";

  // Notas: só envia as que ainda existem (tombstoned saem via tombstones)
  if (noteIds.size > 0) {
    const ids = idList(noteIds);
    const res = await local.execute({
      sql: `SELECT id, title, body, color, is_pinned, is_archived, created_at, updated_at
            FROM notes WHERE id IN (${placeholders(ids.length)})`,
      args: ids,
    });
    push.notes = res.rows.map((r) => ({
      id: r.id as string,
      title: r.title as string,
      body: r.body as string,
      color: r.color as string,
      is_pinned: r.is_pinned as number,
      is_archived: r.is_archived as number,
      created_at: Number(r.created_at),
      updated_at: Number(r.updated_at),
    }));
  }

  if (attUpserts.size > 0) {
    const ids = idList(attUpserts);
    const res = await local.execute({
      sql: `SELECT id, note_id, storage_key, file_name, mime_type, file_size, duration_seconds, created_at
            FROM attachments WHERE id IN (${placeholders(ids.length)})`,
      args: ids,
    });
    push.attachments = res.rows.map((r) => ({
      id: r.id as string,
      note_id: r.note_id as string,
      storage_key: r.storage_key as string,
      file_name: r.file_name as string,
      mime_type: r.mime_type as string,
      file_size: Number(r.file_size),
      duration_seconds: (r.duration_seconds as number | null) ?? null,
      created_at: Number(r.created_at),
    }));
  }

  if (tombIds.size > 0) {
    const ids = idList(tombIds);
    const res = await local.execute({
      sql: `SELECT id, deleted_at FROM tombstones WHERE id IN (${placeholders(ids.length)})`,
      args: ids,
    });
    push.tombstones = res.rows.map((r) => ({
      id: r.id as string,
      deleted_at: Number(r.deleted_at),
    }));
  }

  // Versões do histórico: append-only — envia tudo com created_at >= marca
  // d'água (na 1ª sync com watermark 0, backfilla o histórico local inteiro
  // pro remoto). Notas tombstoned são ignoradas: versão morre com a nota.
  const versionsRes = await local.execute({
    sql: `
      SELECT id, note_id, title, body, created_at FROM note_versions
      WHERE created_at >= ?
        AND note_id NOT IN (SELECT id FROM tombstones)
      ORDER BY created_at ASC
    `,
    args: [versionsWatermark],
  });
  push.versions = versionsRes.rows.map((r) => ({
    id: r.id as string,
    note_id: r.note_id as string,
    title: r.title as string,
    body: r.body as string,
    created_at: Number(r.created_at),
  }));
  push.versions_watermark = versionsWatermark;

  return push;
}

/** Aplica o pull no banco local (sem logChange — mudanças remotas não re-pusham). */
async function applyPull(
  local: Client,
  result: Record<string, unknown>
): Promise<{ pulledNotes: number; pulledVersions: number; appliedTombstones: number }> {
  let pulledNotes = 0;
  let pulledVersions = 0;
  let appliedTombstones = 0;

  // Tombstones primeiro (exclusão vence)
  for (const tomb of (result.tombstones as { id: string; deleted_at: number }[]) || []) {
    if (!tomb?.id) continue;

    const isNew = await local.execute({
      sql: `SELECT 1 AS x FROM tombstones WHERE id = ?`,
      args: [tomb.id],
    });
    if (isNew.rows.length === 0) appliedTombstones++;

    await local.execute({
      sql: `
        INSERT INTO tombstones (id, entity, deleted_at)
        VALUES (?, 'note', ?)
        ON CONFLICT(id) DO UPDATE SET deleted_at = MAX(deleted_at, excluded.deleted_at)
      `,
      args: [tomb.id, tomb.deleted_at || Date.now()],
    });

    // Apaga a cópia local (com os binários dela — esta réplica tem as credenciais do R2)
    const atts = await local.execute({
      sql: `SELECT storage_key FROM attachments WHERE note_id = ?`,
      args: [tomb.id],
    });
    await Promise.allSettled(
      atts.rows.map(async (row) => {
        try {
          await deleteAttachmentFile(row.storage_key as string);
        } catch {
          // binário pode nem existir localmente (anexo sob demanda)
        }
      })
    );
    await local.execute({
      sql: `DELETE FROM notes WHERE id = ?`,
      args: [tomb.id],
    });
    // FK cascade pode estar desligado no SQLite local: limpa as versões à mão
    await local.execute({
      sql: `DELETE FROM note_versions WHERE note_id = ?`,
      args: [tomb.id],
    });
  }

  for (const note of (result.notes as {
    id: string;
    title: string;
    body: string;
    color: string;
    is_pinned: number;
    is_archived: number;
    created_at: number;
    updated_at: number;
  }[]) || []) {
    if (!note?.id) continue;

    const localRes = await local.execute({
      sql: `SELECT updated_at FROM notes WHERE id = ?`,
      args: [note.id],
    });

    if (localRes.rows.length === 0) {
      await local.execute({
        sql: `
          INSERT INTO notes (id, title, body, color, is_pinned, is_archived, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
          note.id,
          note.title ?? "",
          note.body ?? "",
          note.color || "default",
          note.is_pinned ? 1 : 0,
          note.is_archived ? 1 : 0,
          note.created_at || Date.now(),
          note.updated_at || Date.now(),
        ],
      });
      pulledNotes++;
    } else if ((note.updated_at || 0) > Number(localRes.rows[0].updated_at)) {
      await local.execute({
        sql: `
          UPDATE notes
          SET title = ?, body = ?, color = ?, is_pinned = ?, is_archived = ?, updated_at = ?
          WHERE id = ?
        `,
        args: [
          note.title ?? "",
          note.body ?? "",
          note.color || "default",
          note.is_pinned ? 1 : 0,
          note.is_archived ? 1 : 0,
          note.updated_at,
          note.id,
        ],
      });
      pulledNotes++;
    }
    // Empate ou local mais novo: o local vence (é o mesmo critério do remoto)
  }

  for (const att of (result.attachments as {
    id: string;
    note_id: string;
    storage_key: string;
    file_name: string;
    mime_type: string;
    file_size: number;
    duration_seconds: number | null;
    created_at: number;
  }[]) || []) {
    if (!att?.id) continue;
    await local.execute({
      sql: `
        INSERT OR IGNORE INTO attachments
          (id, note_id, storage_key, file_name, mime_type, file_size, duration_seconds, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        att.id,
        att.note_id,
        att.storage_key,
        att.file_name,
        att.mime_type,
        att.file_size || 0,
        att.duration_seconds ?? null,
        att.created_at || Date.now(),
      ],
    });
  }

  for (const attId of (result.attachments_removed as string[]) || []) {
    if (!attId) continue;
    const row = await local.execute({
      sql: `SELECT storage_key FROM attachments WHERE id = ?`,
      args: [attId],
    });
    await local.execute({
      sql: `DELETE FROM attachments WHERE id = ?`,
      args: [attId],
    });
    const key = row.rows[0]?.storage_key as string | undefined;
    if (key) {
      try {
        await deleteAttachmentFile(key);
      } catch {
        // binário pode nem existir localmente
      }
    }
  }

  // Versões do histórico do remoto: append-only, dedupe por id. Só entra
  // versão de nota que existe localmente (FK não é coberta pelo OR IGNORE —
  // a nota pode ter sido tombstoned aqui entre syncs).
  const notasLocais = new Set(
    (await local.execute(`SELECT id FROM notes`)).rows.map((r) => r.id as string)
  );
  for (const ver of (result.versions as {
    id: string;
    note_id: string;
    title: string;
    body: string;
    created_at: number;
  }[]) || []) {
    if (!ver?.id || !ver?.note_id || !notasLocais.has(ver.note_id)) continue;
    const resVer = await local.execute({
      sql: `
        INSERT OR IGNORE INTO note_versions (id, note_id, title, body, created_at)
        VALUES (?, ?, ?, ?, ?)
      `,
      args: [ver.id, ver.note_id, ver.title ?? "", ver.body ?? "", ver.created_at || Date.now()],
    });
    if (resVer.rowsAffected > 0) pulledVersions++;
  }

  // Snapshots de tags/note_tags: só completam o que falta (INSERT OR IGNORE)
  for (const tag of (result.tags as { id: string; name: string; kind: string; source: string; created_at: number }[]) || []) {
    if (!tag?.id) continue;
    await local.execute({
      sql: `
        INSERT INTO tags (id, name, kind, source, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(name) DO NOTHING
      `,
      args: [tag.id, tag.name, tag.kind || "user", tag.source || "file", tag.created_at || Date.now()],
    });
  }
  for (const nt of (result.note_tags as { note_id: string; tag_id: string; created_at: number }[]) || []) {
    if (!nt?.note_id || !nt?.tag_id) continue;
    await local.execute({
      sql: `
        INSERT OR IGNORE INTO note_tags (note_id, tag_id, created_at)
        VALUES (?, ?, ?)
      `,
      args: [nt.note_id, nt.tag_id, nt.created_at || Date.now()],
    });
  }

  return { pulledNotes, pulledVersions, appliedTombstones };
}

/**
 * Executa UM ciclo de sincronização da réplica local contra o remoto.
 * Idempotente: chamar de novo sem mudanças é barato (só lê cursores).
 */
export async function syncOnce(local: Client, remote: Client): Promise<ReplicaSyncResult> {
  const lastCursor = await getMeta(local, "sync_cursor");
  const pushedSeq = await getMeta(local, "sync_pushed_seq");
  const versionsWatermark = await getMeta(local, "sync_versions_watermark");

  const push = await collectLocalPush(local, pushedSeq, versionsWatermark);
  const pushedNotes = push.notes?.length || 0;
  const pushedVersions = push.versions?.length || 0;

  const result = await runSync(remote, lastCursor, push);

  const { pulledNotes, pulledVersions, appliedTombstones } = await applyPull(local, result);

  const newCursor = Number(result.cursor) || lastCursor;
  await setMeta(local, "sync_cursor", newCursor);

  // Marca d'água de versões: maior created_at já presente localmente — o pull
  // de cima acabou de entrar nessa conta, então nada do remoto fica pra trás
  const maxVerRes = await local.execute(
    `SELECT COALESCE(MAX(created_at), 0) AS m FROM note_versions`
  );
  await setMeta(local, "sync_versions_watermark", Number(maxVerRes.rows[0].m));

  const maxSeqRes = await local.execute(`SELECT COALESCE(MAX(seq), 0) AS m FROM change_log`);
  const maxSeq = Number(maxSeqRes.rows[0].m);
  await setMeta(local, "sync_pushed_seq", maxSeq);

  // Poda o log local já enviado (o cursor dos OUTROS vem do remoto)
  if (maxSeq > pushedSeq) {
    await local.execute({
      sql: `DELETE FROM change_log WHERE seq <= ?`,
      args: [maxSeq],
    });
  }

  return {
    ok: true,
    cursor: newCursor,
    pushedNotes,
    pushedVersions,
    pulledNotes,
    pulledVersions,
    appliedTombstones,
    conflicts: (result.conflicts as string[]) || [],
  };
}

/**
 * Laço de sync com backoff — usado pelo processo main do Electron.
 * Retorna a função de cancelamento.
 */
export function startSyncLoop(
  local: Client,
  remote: Client,
  options: { intervalMs?: number; onSync?: (r: ReplicaSyncResult) => void } = {}
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
    } catch (err) {
      failures++;
      console.warn("[SYNC] falhou:", err);
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
