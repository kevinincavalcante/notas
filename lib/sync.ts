import { db } from "@/lib/turso";
import { logChange } from "@/lib/sync-log";
import { syncBodyAutoTags } from "@/lib/url-autotag";
import { deleteAttachmentFile } from "@/lib/storage";

/**
 * Motor server-side do sync (docs/SYNC.md):
 *
 * 1. applyPush — aplica mudanças de uma réplica com LWW por updated_at
 * 2. collectChanges — monta o pull incremental a partir do change_log
 *
 * Tags/note_tags NÃO são entidades sincronizadas: são derivadas de forma
 * determinística do conteúdo (auto-tags) — cada réplica re-deriva ao aplicar
 * mudanças (syncBodyAutoTags). O response traz snapshot de tags/note_tags
 * apenas para bootstrap/rápida convergência de leitura.
 */

export interface PushedNote {
  id: string;
  title: string;
  body: string;
  color: string;
  is_pinned: number | boolean;
  is_archived: number | boolean;
  created_at: number;
  updated_at: number;
}

export interface PushedAttachment {
  id: string;
  note_id: string;
  storage_key: string;
  file_name: string;
  mime_type: string;
  file_size: number;
  duration_seconds: number | null;
  created_at: number;
}

export interface PushedTombstone {
  id: string;
  deleted_at: number;
}

export interface SyncPush {
  notes?: PushedNote[];
  attachments?: PushedAttachment[];
  tombstones?: PushedTombstone[];
}

interface SyncResult {
  cursor: number;
  conflicts: string[];
}

/**
 * Remove uma nota e seus binários do storage — usada tanto pelo DELETE da API
 * quanto pelo sync quando chega tombstone de outra réplica.
 */
async function hardDeleteNote(noteId: string): Promise<void> {
  const attResult = await db.execute({
    sql: `SELECT storage_key FROM attachments WHERE note_id = ?`,
    args: [noteId],
  });

  await Promise.allSettled(
    attResult.rows.map(async (row) => {
      const fileId = row.storage_key as string;
      if (!fileId) return;
      try {
        await deleteAttachmentFile(fileId);
      } catch (storageErr) {
        console.warn(`Aviso ao excluir arquivo "${fileId}" do storage:`, storageErr);
      }
    })
  );

  await db.execute({
    sql: `DELETE FROM notes WHERE id = ?`,
    args: [noteId],
  });
}

/** Aplica o push de uma réplica com LWW. Retorna ids que perderam o conflito. */
async function applyPush(push: SyncPush): Promise<string[]> {
  const conflicts: string[] = [];

  // Tombstones primeiro: exclusão vence update concorrente (docs/SYNC.md, regra 3)
  for (const tomb of push.tombstones || []) {
    if (!tomb?.id) continue;

    await db.execute({
      sql: `
        INSERT INTO tombstones (id, entity, deleted_at)
        VALUES (?, 'note', ?)
        ON CONFLICT(id) DO UPDATE SET deleted_at = MAX(deleted_at, excluded.deleted_at)
      `,
      args: [tomb.id, tomb.deleted_at || Date.now()],
    });

    // Só apaga de fato se a nota ainda existir (idempotente)
    const exists = await db.execute({
      sql: `SELECT 1 AS x FROM notes WHERE id = ?`,
      args: [tomb.id],
    });
    if (exists.rows.length > 0) {
      await hardDeleteNote(tomb.id);
      await logChange("tombstone", tomb.id, "delete");
    }
  }

  for (const note of push.notes || []) {
    if (!note?.id) continue;

    const isPinned = note.is_pinned ? 1 : 0;
    const isArchived = note.is_archived ? 1 : 0;

    const localRes = await db.execute({
      sql: `SELECT updated_at FROM notes WHERE id = ?`,
      args: [note.id],
    });

    if (localRes.rows.length === 0) {
      // Bootstrap/nova nota da réplica: entra direto
      await db.execute({
        sql: `
          INSERT INTO notes (id, title, body, color, is_pinned, is_archived, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
          note.id,
          note.title ?? "",
          note.body ?? "",
          note.color || "default",
          isPinned,
          isArchived,
          note.created_at || Date.now(),
          note.updated_at || Date.now(),
        ],
      });
      await logChange("note", note.id, "upsert");
      continue;
    }

    const localUpdatedAt = Number(localRes.rows[0].updated_at);
    if ((note.updated_at || 0) > localUpdatedAt) {
      await db.execute({
        sql: `
          UPDATE notes
          SET title = ?, body = ?, color = ?, is_pinned = ?, is_archived = ?, updated_at = ?
          WHERE id = ?
        `,
        args: [
          note.title ?? "",
          note.body ?? "",
          note.color || "default",
          isPinned,
          isArchived,
          note.updated_at,
          note.id,
        ],
      });
      await logChange("note", note.id, "upsert");
    } else {
      // Perdeu o LWW (estado local da réplica é igual ou mais novo)
      conflicts.push(note.id);
    }
  }

  // Metadados de anexo (binário não trafega no sync — vai direto ao R2)
  for (const att of push.attachments || []) {
    if (!att?.id) continue;

    const localRes = await db.execute({
      sql: `SELECT created_at FROM attachments WHERE id = ?`,
      args: [att.id],
    });

    if (localRes.rows.length === 0) {
      await db.execute({
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
      await logChange("attachment", att.id, "upsert");
    }
    // Anexo existente nunca é sobrescrito: anexos são imutáveis (mesmo id = mesmo binário)
  }

  return conflicts;
}

/** Re-deriva auto-tags das notas cujo conteúdo o push realmente alterou (LWW venceu). */
async function rederiveTagsForNotes(notes: PushedNote[], conflicts: string[]): Promise<void> {
  const conflictSet = new Set(conflicts);
  const changed = (notes || []).filter((n) => n?.id && !conflictSet.has(n.id));
  if (changed.length === 0) return;

  await Promise.allSettled(
    changed.map((n) => syncBodyAutoTags(n.id, (n.body || "").trim()))
  );
}

/** Monta o pull incremental: tudo que mudou no servidor desde o cursor.
 *  Cursor 0 = bootstrap: replica nova, devolve o estado completo. */
async function collectChanges(cursor: number, conflicts: string[]): Promise<Record<string, unknown>> {
  const logRes = await db.execute({
    sql: `SELECT seq, entity, entity_id, op FROM change_log WHERE seq > ? ORDER BY seq ASC`,
    args: [cursor],
  });

  const noteIds = new Set<string>();
  const attachmentIds = new Set<string>();
  const tombstoneIds = new Set<string>();
  const attachmentRemoved: string[] = [];

  // Cursor novo = maior seq global do log (mesmo sem novidades, a réplica
  // nunca mais refaz o bootstrap)
  const maxRes = await db.execute(`SELECT COALESCE(MAX(seq), 0) AS m FROM change_log`);
  const newCursor = Math.max(cursor, Number(maxRes.rows[0].m));

  for (const row of logRes.rows) {
    const entity = row.entity as string;
    const entityId = row.entity_id as string;
    const op = row.op as string;

    if (entity === "note" && op === "upsert") noteIds.add(entityId);
    else if (entity === "attachment") {
      if (op === "upsert") attachmentIds.add(entityId);
      else attachmentRemoved.push(entityId);
    } else if (entity === "tombstone") tombstoneIds.add(entityId);
  }

  // Bootstrap (cursor 0): o change_log só cobre o futuro — manda o estado completo
  let notes: Record<string, unknown>[] = [];
  if (cursor === 0) {
    const res = await db.execute(`SELECT * FROM notes`);
    notes = res.rows as Record<string, unknown>[];
  } else {
    const noteIdList = Array.from(noteIds);
    if (noteIdList.length > 0) {
      const placeholders = noteIdList.map(() => "?").join(",");
      const res = await db.execute({
        sql: `SELECT * FROM notes WHERE id IN (${placeholders})`,
        args: noteIdList,
      });
      notes = res.rows as Record<string, unknown>[];
    }
  }

  let attachments: Record<string, unknown>[] = [];
  if (cursor === 0) {
    const res = await db.execute(`SELECT * FROM attachments`);
    attachments = res.rows as Record<string, unknown>[];
  } else {
    const attIdList = Array.from(attachmentIds);
    if (attIdList.length > 0) {
      const placeholders = attIdList.map(() => "?").join(",");
      const res = await db.execute({
        sql: `SELECT * FROM attachments WHERE id IN (${placeholders})`,
        args: attIdList,
      });
      attachments = res.rows as Record<string, unknown>[];
    }
  }

  let tombstones: Record<string, unknown>[] = [];
  if (cursor === 0) {
    const res = await db.execute(`SELECT id, deleted_at FROM tombstones`);
    tombstones = res.rows as Record<string, unknown>[];
  } else {
    const tombIdList = Array.from(tombstoneIds);
    if (tombIdList.length > 0) {
      const placeholders = tombIdList.map(() => "?").join(",");
      const res = await db.execute({
        sql: `SELECT id, deleted_at FROM tombstones WHERE id IN (${placeholders})`,
        args: tombIdList,
      });
      tombstones = res.rows as Record<string, unknown>[];
    }
  }

  // Snapshots de tags/note_tags: pequenos e derivados — bootstrap e convergência
  const tagsRes = await db.execute(`SELECT id, name, kind, source, created_at FROM tags`);
  const noteTagsRes = await db.execute(`SELECT note_id, tag_id, created_at FROM note_tags`);

  return {
    cursor: newCursor,
    notes,
    attachments,
    attachments_removed: attachmentRemoved,
    tombstones,
    tags: tagsRes.rows,
    note_tags: noteTagsRes.rows,
    conflicts,
  };
}

/**
 * Executa um ciclo completo de sync: aplica o push, re-deriva tags das notas
 * alteradas e devolve o pull incremental.
 */
export async function runSync(
  cursor: number,
  push: SyncPush
): Promise<Record<string, unknown>> {
  const conflicts = await applyPush(push);
  await rederiveTagsForNotes(push.notes || [], conflicts);
  return collectChanges(cursor, conflicts);
}
