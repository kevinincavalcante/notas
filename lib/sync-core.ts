import type { Client } from "@libsql/client";
import type { SyncPush } from "@/lib/sync-types";

/**
 * Miolo PURO do cliente de sync — compartilhado entre as réplicas:
 *
 *   - Desktop (Electron): syncOnce em lib/sync-replica.ts, remoto por SQL
 *     direto (Turso é o hub).
 *   - Mobile (Expo): syncOnce em mobile/lib/sync.ts, remoto por
 *     POST /api/sync + JWT (o APK não carrega credenciais do Turso).
 *
 * Este arquivo NÃO pode importar nada de servidor (aws-sdk, storage, env):
 * entra no bundle do celular. Apagar binários locais é injetado via
 * `deleteBinary` (desktop: R2 local; mobile: cache sob demanda).
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

export interface PullOptions {
  /** Apaga o binário local do anexo (só na réplica que guarda os arquivos). */
  deleteBinary?: (storageKey: string) => Promise<void>;
}

/** Roda um ciclo completo no remoto: aplica push e devolve o pull incremental. */
export type RunSyncFn = (
  cursor: number,
  push: SyncPush
) => Promise<Record<string, unknown>>;

export async function getMeta(client: Client, key: string): Promise<number> {
  const res = await client.execute({
    sql: `SELECT value FROM sync_meta WHERE key = ?`,
    args: [key],
  });
  return Number(res.rows[0]?.value) || 0;
}

export async function setMeta(client: Client, key: string, value: number): Promise<void> {
  await client.execute({
    sql: `
      INSERT INTO sync_meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `,
    args: [key, String(value)],
  });
}

/** Coleta as mudanças locais pendentes de envio, por entidade. */
export async function collectLocalPush(
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
      sql: `SELECT * FROM notes WHERE id IN (${placeholders(ids.length)})`,
      args: ids,
    });
    push.notes = res.rows as unknown as SyncPush["notes"];
  }

  // Tombstones pendentes
  if (tombIds.size > 0) {
    const ids = idList(tombIds);
    const res = await local.execute({
      sql: `SELECT id, deleted_at FROM tombstones WHERE id IN (${placeholders(ids.length)})`,
      args: ids,
    });
    push.tombstones = res.rows as unknown as SyncPush["tombstones"];
  }

  // Anexos criados/alterados que ainda existem
  if (attUpserts.size > 0) {
    const ids = idList(attUpserts);
    const res = await local.execute({
      sql: `SELECT * FROM attachments WHERE id IN (${placeholders(ids.length)})`,
      args: ids,
    });
    push.attachments = res.rows as unknown as SyncPush["attachments"];
  }

  // Versões criadas localmente após a última marca d'água
  const verRes = await local.execute({
    sql: `SELECT * FROM note_versions WHERE created_at > ? ORDER BY created_at ASC`,
    args: [versionsWatermark],
  });
  push.versions = verRes.rows as unknown as SyncPush["versions"];

  return push;
}

/** Aplica o pull incremental (ou bootstrap) vindo do remoto no banco local. */
export async function applyPull(
  local: Client,
  result: Record<string, unknown>,
  options: PullOptions = {}
): Promise<{ pulledNotes: number; pulledVersions: number; appliedTombstones: number }> {
  const { deleteBinary } = options;
  let pulledNotes = 0;
  let pulledVersions = 0;
  let appliedTombstones = 0;

  // Tombstones primeiro: exclusão do remoto apaga a cópia local
  for (const tomb of (result.tombstones as { id: string; deleted_at: number }[]) || []) {
    if (!tomb?.id) continue;

    const isNew = await local.execute({
      sql: `SELECT 1 FROM tombstones WHERE id = ?`,
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

    // Apaga a cópia local (binário, onde a réplica o tiver)
    if (deleteBinary) {
      const atts = await local.execute({
        sql: `SELECT storage_key FROM attachments WHERE note_id = ?`,
        args: [tomb.id],
      });
      await Promise.allSettled(
        atts.rows.map(async (row) => {
          try {
            await deleteBinary(row.storage_key as string);
          } catch {
            // binário pode nem existir localmente (anexo sob demanda)
          }
        })
      );
    }
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
    } else {
      const localUpdated = Number(localRes.rows[0].updated_at) || 0;
      if (note.updated_at > localUpdated) {
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
    }
  }

  // Lista atualizada de notas locais vivas (para validação de FKs)
  const notasLocais = new Set(
    (await local.execute(`SELECT id FROM notes`)).rows.map((r) => r.id as string)
  );

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
    if (!att?.id || !att?.note_id || !notasLocais.has(att.note_id)) continue;
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
    if (key && deleteBinary) {
      try {
        await deleteBinary(key);
      } catch {
        // binário pode nem existir localmente
      }
    }
  }

  // Versões do histórico do remoto: append-only, dedupe por id. Só entra
  // versão de nota que existe localmente (FK não é coberta pelo OR IGNORE —
  // a nota pode ter sido tombstoned aqui entre syncs).
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

  const tagsLocais = new Set(
    (await local.execute(`SELECT id FROM tags`)).rows.map((r) => r.id as string)
  );

  for (const nt of (result.note_tags as { note_id: string; tag_id: string; created_at: number }[]) || []) {
    if (!nt?.note_id || !nt?.tag_id || !notasLocais.has(nt.note_id) || !tagsLocais.has(nt.tag_id)) continue;
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
 * Executa UM ciclo de sincronização da réplica local contra o remoto,
 * com o acesso ao remoto injetado (`run`). Idempotente: chamar de novo
 * sem mudanças é barato (só lê cursores).
 */
export async function syncOnceWith(
  local: Client,
  run: RunSyncFn,
  options: PullOptions = {}
): Promise<ReplicaSyncResult> {
  const lastCursor = await getMeta(local, "sync_cursor");
  const pushedSeq = await getMeta(local, "sync_pushed_seq");
  const versionsWatermark = await getMeta(local, "sync_versions_watermark");

  // Maior seq atual do log local — se o push for aceito, vira o novo pushedSeq
  const maxSeqRes = await local.execute(`SELECT COALESCE(MAX(seq), 0) AS m FROM change_log`);
  const currentMaxSeq = Number(maxSeqRes.rows[0].m);

  // Maior created_at das versões antes de enviar
  const maxVerRes = await local.execute(`SELECT COALESCE(MAX(created_at), 0) AS m FROM note_versions`);
  const currentMaxVer = Number(maxVerRes.rows[0].m);

  const push = await collectLocalPush(local, pushedSeq, versionsWatermark);

  let result: Record<string, unknown>;
  try {
    result = await run(lastCursor, push);
  } catch (err) {
    return {
      ok: false,
      cursor: lastCursor,
      pushedNotes: 0,
      pushedVersions: 0,
      pulledNotes: 0,
      pulledVersions: 0,
      appliedTombstones: 0,
      conflicts: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Push foi aceito: avança os cursores locais
  await setMeta(local, "sync_pushed_seq", currentMaxSeq);
  if (currentMaxVer > versionsWatermark) {
    await setMeta(local, "sync_versions_watermark", currentMaxVer);
  }

  const { pulledNotes, pulledVersions, appliedTombstones } = await applyPull(local, result, options);

  const newCursor = Number(result.cursor) || lastCursor;
  await setMeta(local, "sync_cursor", newCursor);

  return {
    ok: true,
    cursor: newCursor,
    pushedNotes: push.notes?.length ?? 0,
    pushedVersions: push.versions?.length ?? 0,
    pulledNotes,
    pulledVersions,
    appliedTombstones,
    conflicts: (result.conflicts as string[]) || [],
  };
}
