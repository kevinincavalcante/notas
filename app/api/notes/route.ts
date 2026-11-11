import { NextResponse } from "next/server";
import { db } from "@/lib/turso";
import crypto from "crypto";
import { getTagsByNoteId } from "@/lib/tags";
import { syncUrlAutoTags } from "@/lib/url-autotag";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const isArchived = searchParams.get("archived") === "1" ? 1 : 0;

    // Busca as notas ordenadas: fixadas primeiro, depois pela data de atualização
    const notesResult = await db.execute({
      sql: `
        SELECT id, title, body, color, is_pinned, is_archived, created_at, updated_at
        FROM notes
        WHERE is_archived = ?
        ORDER BY is_pinned DESC, updated_at DESC
      `,
      args: [isArchived],
    });

    const noteIds = notesResult.rows.map((r) => r.id as string);
    const tagsByNoteId = await getTagsByNoteId(noteIds);

    // Busca os anexos dessas notas
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

    const notes = notesResult.rows.map((row) => ({
      ...row,
      is_pinned: Boolean(row.is_pinned),
      is_archived: Boolean(row.is_archived),
      attachments: attachmentsByNoteId[row.id as string] || [],
      tags: tagsByNoteId[row.id as string] || [],
    }));

    return NextResponse.json({ notes });
  } catch (error) {
    console.error("Erro ao listar notas:", error);
    return NextResponse.json({ error: "Erro ao buscar notas" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const data = await request.json();
    const id = crypto.randomUUID();
    const now = Date.now();
    const title = (data.title || "").trim();
    const body = (data.body || "").trim();
    const color = data.color || "default";
    const isPinned = data.is_pinned ? 1 : 0;
    const isArchived = data.is_archived ? 1 : 0;

    await db.execute({
      sql: `
        INSERT INTO notes (id, title, body, color, is_pinned, is_archived, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [id, title, body, color, isPinned, isArchived, now, now],
    });

    // Marcadores automáticos por URL do corpo (falha silenciosa)
    if (body) {
      try {
        await syncUrlAutoTags(id, body);
      } catch (tagErr) {
        console.warn("Falha nas auto-tags de URL:", tagErr);
      }
    }

    return NextResponse.json({
      note: {
        id,
        title,
        body,
        color,
        is_pinned: Boolean(isPinned),
        is_archived: Boolean(isArchived),
        created_at: now,
        updated_at: now,
        attachments: [],
      },
    });
  } catch (error) {
    console.error("Erro ao criar nota:", error);
    return NextResponse.json({ error: "Erro ao criar nota" }, { status: 500 });
  }
}
