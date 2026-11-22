import type { Client, InStatement } from "@libsql/client";
import { EMPTY_CONTENT_HASH, isEncrypted, isEncryptedEmpty } from "../../../lib/vault-crypto";

/**
 * Camada de dados local do celular — mesma estrutura do desktop:
 * mutações escrevem no SQLite E no change_log (o sync leva depois).
 * Nada aqui toca em rede: offline-first de verdade.
 */

export interface NoteRow {
  id: string;
  title: string;
  body: string;
  color: string;
  is_pinned: number;
  is_archived: number;
  /** 1 = nota do cofre (title/body chegam cifrados; tela própria) */
  is_vault: number;
  created_at: number;
  updated_at: number;
}

export interface TagRow {
  id: string;
  name: string;
  count: number;
}

export interface AttachmentRow {
  id: string;
  note_id: string;
  storage_key: string;
  file_name: string;
  mime_type: string;
  file_size: number;
  duration_seconds: number | null;
  created_at: number;
}

/** Igual ao logChange de lib/sync-log.ts, sem importar o turso do servidor. */
async function logChange(
  client: Client,
  entity: "note" | "tombstone" | "attachment",
  entityId: string,
  op: "upsert" | "delete"
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO change_log (entity, entity_id, op, at) VALUES (?, ?, ?, ?)`,
    args: [entity, entityId, op, Date.now()],
  });
}

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(",");

// ---- Leitura ----

export async function listNotes(client: Client, tagId: string | null): Promise<NoteRow[]> {
  // Notas do cofre (is_vault = 1) ficam fora da lista comum — tela própria em /vault
  const res = tagId
    ? await client.execute({
        sql: `
          SELECT n.* FROM notes n
          JOIN note_tags nt ON nt.note_id = n.id
          WHERE nt.tag_id = ? AND n.is_archived = 0 AND n.is_vault = 0
          ORDER BY n.is_pinned DESC, n.updated_at DESC
          LIMIT 200
        `,
        args: [tagId],
      })
    : await client.execute({
        sql: `
          SELECT * FROM notes WHERE is_archived = 0 AND is_vault = 0
          ORDER BY is_pinned DESC, updated_at DESC
          LIMIT 200
        `,
      });
  return res.rows as unknown as NoteRow[];
}

export async function listTags(client: Client): Promise<TagRow[]> {
  const res = await client.execute({
    sql: `
      SELECT t.id, t.name, COUNT(nt.note_id) AS count
      FROM tags t
      LEFT JOIN note_tags nt ON nt.tag_id = t.id
      GROUP BY t.id
      ORDER BY t.name COLLATE NOCASE
    `,
  });
  return res.rows as unknown as TagRow[];
}

/** Tags (nome) de um lote de notas — pra mostrar nos chips do card. */
export async function tagsForNotes(
  client: Client,
  ids: string[]
): Promise<Record<string, string[]>> {
  if (ids.length === 0) return {};
  const res = await client.execute({
    sql: `
      SELECT nt.note_id, t.name FROM note_tags nt
      JOIN tags t ON t.id = nt.tag_id
      WHERE nt.note_id IN (${placeholders(ids.length)})
      ORDER BY t.name COLLATE NOCASE
    `,
    args: ids,
  });
  const byNote: Record<string, string[]> = {};
  for (const row of res.rows) {
    const noteId = row.note_id as string;
    (byNote[noteId] ||= []).push(row.name as string);
  }
  return byNote;
}

/** Busca local FTS5 — espelho da /api/notes/search (prefixos + bm25). */
export async function searchNotes(client: Client, query: string): Promise<NoteRow[]> {
  const ftsQuery = query
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[*"'()]/g, ""))
    .filter(Boolean)
    .map((w) => `${w}*`)
    .join(" ");
  if (!ftsQuery) return [];
  const res = await client.execute({
    sql: `
      SELECT n.* FROM notes_fts
      JOIN notes n ON n.rowid = notes_fts.rowid
      WHERE notes_fts MATCH ? AND n.is_archived = 0 AND n.is_vault = 0
      ORDER BY bm25(notes_fts)
      LIMIT 50
    `,
    args: [ftsQuery],
  });
  return res.rows as unknown as NoteRow[];
}

export async function getNote(client: Client, id: string): Promise<NoteRow | null> {
  const res = await client.execute({
    sql: `SELECT * FROM notes WHERE id = ?`,
    args: [id],
  });
  return (res.rows[0] as unknown as NoteRow) || null;
}

// ---- Escrita (toda mutação loga no change_log) ----

export async function createNote(
  client: Client,
  initial?: { title?: string; body?: string; color?: string }
): Promise<string> {
  const id = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `n-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();
  await client.execute({
    sql: `
      INSERT INTO notes (id, title, body, color, is_pinned, is_archived, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, 0, ?, ?)
    `,
    args: [
      id,
      initial?.title ?? "",
      initial?.body ?? "",
      initial?.color ?? "default",
      now,
      now,
    ],
  });
  await logChange(client, "note", id, "upsert");
  return id;
}

export interface NotePatch {
  title?: string;
  body?: string;
  color?: string;
}

export async function updateNote(client: Client, id: string, patch: NotePatch): Promise<void> {
  const keys = Object.keys(patch) as (keyof NotePatch)[];
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  const args: unknown[] = keys.map((k) => patch[k]);
  args.push(Date.now(), id);
  await client.execute({
    sql: `UPDATE notes SET ${sets}, updated_at = ? WHERE id = ?`,
    args: args as never[],
  });
  await logChange(client, "note", id, "upsert");
}

export async function setNotePinned(client: Client, id: string, pinned: boolean): Promise<void> {
  await client.execute({
    sql: `UPDATE notes SET is_pinned = ?, updated_at = ? WHERE id = ?`,
    args: [pinned ? 1 : 0, Date.now(), id],
  });
  await logChange(client, "note", id, "upsert");
}

export async function setNoteArchived(client: Client, id: string, archived: boolean): Promise<void> {
  await client.execute({
    sql: `UPDATE notes SET is_archived = ?, updated_at = ? WHERE id = ?`,
    args: [archived ? 1 : 0, Date.now(), id],
  });
  await logChange(client, "note", id, "upsert");
}

/** Entra/sai do cofre: vira flag (o conteúdo é cifrado/decifrado pelas telas). */
export async function setNoteVault(client: Client, id: string, vault: boolean): Promise<void> {
  await client.execute({
    sql: `UPDATE notes SET is_vault = ?, updated_at = ? WHERE id = ?`,
    args: [vault ? 1 : 0, Date.now(), id],
  });
  await logChange(client, "note", id, "upsert");
}

/** Exclusão = tombstone (vence em qualquer réplica, igual no desktop). */
export async function deleteNote(client: Client, id: string): Promise<void> {
  const now = Date.now();
  await client.execute({
    sql: `
      INSERT INTO tombstones (id, entity, deleted_at)
      VALUES (?, 'note', ?)
      ON CONFLICT(id) DO UPDATE SET deleted_at = MAX(deleted_at, excluded.deleted_at)
    `,
    args: [id, now],
  });
  await client.execute({ sql: `DELETE FROM notes WHERE id = ?`, args: [id] });
  await client.execute({ sql: `DELETE FROM note_versions WHERE note_id = ?`, args: [id] });
  await logChange(client, "tombstone", id, "delete");
}

// ---- Histórico de versões ----

/**
 * Histórico de versões — mesmas regras de lib/note-versions.ts.
 *
 * `content_hash` é o hash do CONTEÚDO EM CLARO: no cofre title/body são
 * ciphertext com IV aleatório, então só o hash identifica "mesmo conteúdo" e
 * revela estado vazio (hash de ""+""). Estado vazio nunca entra no histórico.
 *
 * Não lança: histórico quebrado não pode derrubar o save da nota.
 * @returns true se a linha entrou.
 */
export async function appendVersionIfChanged(
  client: Client,
  snapshot: {
    note_id: string;
    title: string;
    body: string;
    content_hash?: string | null;
    created_at: number;
    is_instance_snapshot?: boolean;
  }
): Promise<boolean> {
  try {
    const hash = snapshot.content_hash ? String(snapshot.content_hash) : "";
    // Vazio (hash do vazio, ou ciphertext de "" nas duas pontas) não vira versão
    if (hash === EMPTY_CONTENT_HASH) return false;
    if (!hash) {
      const t = snapshot.title || "";
      const b = snapshot.body || "";
      if (!t.trim() && !b.trim()) return false;
      if (isEncrypted(t) && isEncrypted(b) && isEncryptedEmpty(t) && isEncryptedEmpty(b)) {
        return false;
      }
    }
    const lastRes = await client.execute({
      sql: `SELECT title, body, content_hash, created_at
            FROM note_versions WHERE note_id = ?
            ORDER BY created_at DESC LIMIT 1`,
      args: [snapshot.note_id],
    });
    const prev = lastRes.rows[0];
    if (prev) {
      const prevTitle = String(prev.title ?? "");
      const prevBody = String(prev.body ?? "");
      const prevHash = prev.content_hash ? String(prev.content_hash) : "";
      const same =
        prevHash && hash
          ? prevHash === hash
          : prevTitle.trim() === (snapshot.title || "").trim() &&
            prevBody.trim() === (snapshot.body || "").trim();
      if (same) return false;
    }

    // ids por sequência: o mobile pode rodar sem crypto.randomUUID
    const id = `ver-${snapshot.note_id}-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
    await client.execute({
      sql: `
        INSERT OR IGNORE INTO note_versions
          (id, note_id, title, body, content_hash, is_instance_snapshot, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        id,
        snapshot.note_id,
        snapshot.title ?? "",
        snapshot.body ?? "",
        snapshot.content_hash ?? null,
        snapshot.is_instance_snapshot ? 1 : 0,
        snapshot.created_at || Date.now(),
      ],
    });
    return true;
  } catch (e) {
    console.warn("Falha ao gravar versão da nota:", e);
    return false;
  }
}

export async function rawExecute(client: Client, stmt: InStatement) {
  return client.execute(stmt);
}
