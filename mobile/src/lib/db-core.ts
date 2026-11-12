import type { Client, InStatement } from "@libsql/client";

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
  created_at: number;
  updated_at: number;
}

export interface TagRow {
  id: string;
  name: string;
  count: number;
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
  const res = tagId
    ? await client.execute({
        sql: `
          SELECT n.* FROM notes n
          JOIN note_tags nt ON nt.note_id = n.id
          WHERE nt.tag_id = ? AND n.is_archived = 0
          ORDER BY n.is_pinned DESC, n.updated_at DESC
          LIMIT 200
        `,
        args: [tagId],
      })
    : await client.execute({
        sql: `
          SELECT * FROM notes WHERE is_archived = 0
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
      WHERE notes_fts MATCH ? AND n.is_archived = 0
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

export async function createNote(client: Client): Promise<string> {
  const id = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `n-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();
  await client.execute({
    sql: `
      INSERT INTO notes (id, title, body, color, is_pinned, is_archived, created_at, updated_at)
      VALUES (?, '', '', 'default', 0, 0, ?, ?)
    `,
    args: [id, now, now],
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

export async function rawExecute(client: Client, stmt: InStatement) {
  return client.execute(stmt);
}
