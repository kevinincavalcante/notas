import { NextResponse } from "next/server";
import { db } from "@/lib/turso";
import crypto from "crypto";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const noteResult = await db.execute({
      sql: `SELECT * FROM notes WHERE id = ?`,
      args: [id],
    });

    if (noteResult.rows.length === 0) {
      return NextResponse.json({ error: "Nota não encontrada" }, { status: 404 });
    }

    const note = noteResult.rows[0];

    const attResult = await db.execute({
      sql: `SELECT * FROM attachments WHERE note_id = ? ORDER BY created_at ASC`,
      args: [id],
    });

    return NextResponse.json({
      note: {
        ...note,
        is_pinned: Boolean(note.is_pinned),
        is_archived: Boolean(note.is_archived),
        attachments: attResult.rows,
      },
    });
  } catch (error) {
    console.error("Erro ao buscar nota:", error);
    return NextResponse.json({ error: "Erro ao buscar nota" }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();

    const allowedFields = ["title", "body", "color", "is_pinned", "is_archived"];
    const updates: string[] = [];
    const values: any[] = [];

    // Se title ou body foram modificados, salva snapshot da versão anterior no histórico
    if ("title" in body || "body" in body) {
      const currentResult = await db.execute({
        sql: `SELECT title, body, updated_at FROM notes WHERE id = ?`,
        args: [id],
      });

      if (currentResult.rows.length > 0) {
        const cur = currentResult.rows[0];
        const curTitle = ((cur.title as string) || "").trim();
        const curBody = ((cur.body as string) || "").trim();
        const newTitle = "title" in body ? (body.title || "").trim() : curTitle;
        const newBody = "body" in body ? (body.body || "").trim() : curBody;

        if (curTitle !== newTitle || curBody !== newBody) {
          if (curTitle || curBody) {
            await db.execute({
              sql: `
                INSERT INTO note_versions (id, note_id, title, body, created_at)
                VALUES (?, ?, ?, ?, ?)
              `,
              args: [
                crypto.randomUUID(),
                id,
                cur.title as string,
                cur.body as string,
                (cur.updated_at as number) || Date.now(),
              ],
            });
          }
        }
      }
    }

    for (const field of allowedFields) {
      if (field in body) {
        updates.push(`${field} = ?`);
        if (field === "is_pinned" || field === "is_archived") {
          values.push(body[field] ? 1 : 0);
        } else {
          values.push(body[field]);
        }
      }
    }

    if (updates.length === 0) {
      return NextResponse.json({ error: "Nenhum campo para atualizar" }, { status: 400 });
    }

    const now = Date.now();
    updates.push("updated_at = ?");
    values.push(now);
    values.push(id);

    await db.execute({
      sql: `UPDATE notes SET ${updates.join(", ")} WHERE id = ?`,
      args: values,
    });

    return NextResponse.json({ success: true, updated_at: now });
  } catch (error) {
    console.error("Erro ao atualizar nota:", error);
    return NextResponse.json({ error: "Erro ao atualizar nota" }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Turso executará o ON DELETE CASCADE nas attachments e note_versions automaticamente
    await db.execute({
      sql: `DELETE FROM notes WHERE id = ?`,
      args: [id],
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Erro ao excluir nota:", error);
    return NextResponse.json({ error: "Erro ao excluir nota" }, { status: 500 });
  }
}
