import { db } from "@/lib/turso";
import crypto from "crypto";
import type { Tag } from "@/types/note";

/**
 * Cria a tag se não existir (kind='auto') e vincula à nota.
 * Idempotente: chamar de novo não duplica o vínculo.
 * @param source origem da tag: 'file' (upload) ou 'url' (corpo da nota)
 */
export async function attachAutoTag(
  noteId: string,
  tagName: string,
  source: "file" | "url" = "file"
): Promise<void> {
  await db.execute({
    sql: `
      INSERT INTO tags (id, name, kind, source, created_at)
      VALUES (?, ?, 'auto', ?, ?)
      ON CONFLICT(name) DO NOTHING
    `,
    args: [crypto.randomUUID(), tagName, source, Date.now()],
  });

  const tagRes = await db.execute({
    sql: `SELECT id FROM tags WHERE name = ?`,
    args: [tagName],
  });
  const tagId = tagRes.rows[0]?.id as string | undefined;
  if (!tagId) return;

  await db.execute({
    sql: `
      INSERT OR IGNORE INTO note_tags (note_id, tag_id, created_at)
      VALUES (?, ?, ?)
    `,
    args: [noteId, tagId, Date.now()],
  });
}

/** Carrega as tags de várias notas em uma única query (sem N+1). */
export async function getTagsByNoteId(noteIds: string[]): Promise<Record<string, Tag[]>> {
  const tagsByNoteId: Record<string, Tag[]> = {};
  if (noteIds.length === 0) return tagsByNoteId;

  const placeholders = noteIds.map(() => "?").join(",");
  const res = await db.execute({
    sql: `
      SELECT nt.note_id, t.id, t.name, t.kind
      FROM note_tags nt
      JOIN tags t ON t.id = nt.tag_id
      WHERE nt.note_id IN (${placeholders})
      ORDER BY t.name ASC
    `,
    args: noteIds,
  });

  for (const row of res.rows) {
    const nid = row.note_id as string;
    if (!tagsByNoteId[nid]) tagsByNoteId[nid] = [];
    tagsByNoteId[nid].push({
      id: row.id as string,
      name: row.name as string,
      kind: row.kind as "auto" | "user",
    });
  }

  return tagsByNoteId;
}
