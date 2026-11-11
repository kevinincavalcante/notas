import { NextResponse } from "next/server";
import { db } from "@/lib/turso";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const query = (searchParams.get("q") || "").trim();

    if (!query) {
      return NextResponse.json({ notes: [] });
    }

    // Prepara query FTS5 tratando caracteres especiais e adicionando prefixo (*)
    // Sanitiza palavras permitindo letras, números e acentos
    const sanitizedWords = query
      .replace(/["*]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 0)
      .map((w) => `"${w}"*`);

    if (sanitizedWords.length === 0) {
      return NextResponse.json({ notes: [] });
    }

    const ftsQuery = sanitizedWords.join(" AND ");

    const result = await db.execute({
      sql: `
        SELECT 
          n.id, 
          n.title, 
          n.body, 
          n.color, 
          n.is_pinned, 
          n.is_archived, 
          n.created_at, 
          n.updated_at,
          snippet(notes_fts, 0, '<mark>', '</mark>', '...', 10) as title_snippet,
          snippet(notes_fts, 1, '<mark>', '</mark>', '...', 15) as body_snippet
        FROM notes_fts
        JOIN notes n ON n.rowid = notes_fts.rowid
        WHERE notes_fts MATCH ?
        ORDER BY bm25(notes_fts)
        LIMIT 50
      `,
      args: [ftsQuery],
    });

    const noteIds = result.rows.map((r) => r.id as string);

    // Carrega anexos para as notas encontradas
    let attachmentsByNoteId: Record<string, any[]> = {};
    if (noteIds.length > 0) {
      const placeholders = noteIds.map(() => "?").join(",");
      const attResult = await db.execute({
        sql: `
          SELECT id, note_id, storage_key, file_name, mime_type, file_size, duration_seconds, created_at
          FROM attachments
          WHERE note_id IN (${placeholders})
          ORDER BY created_at ASC
        `,
        args: noteIds,
      });

      for (const row of attResult.rows) {
        const nid = row.note_id as string;
        if (!attachmentsByNoteId[nid]) attachmentsByNoteId[nid] = [];
        attachmentsByNoteId[nid].push(row);
      }
    }

    const notes = result.rows.map((row) => ({
      ...row,
      is_pinned: Boolean(row.is_pinned),
      is_archived: Boolean(row.is_archived),
      attachments: attachmentsByNoteId[row.id as string] || [],
    }));

    return NextResponse.json({ notes });
  } catch (error) {
    console.error("Erro na busca FTS5:", error);
    return NextResponse.json({ error: "Erro na busca" }, { status: 500 });
  }
}
