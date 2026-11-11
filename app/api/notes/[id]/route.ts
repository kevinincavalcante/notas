import { NextResponse } from "next/server";
import { db } from "@/lib/turso";
import crypto from "crypto";
import { getTagsByNoteId } from "@/lib/tags";
import { syncBodyAutoTags } from "@/lib/url-autotag";
import { deleteAttachmentFile } from "@/lib/storage";

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

    const tagsByNoteId = await getTagsByNoteId([id]);

    return NextResponse.json({
      note: {
        ...note,
        is_pinned: Boolean(note.is_pinned),
        is_archived: Boolean(note.is_archived),
        attachments: attResult.rows,
        tags: tagsByNoteId[id] || [],
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

    // Se title ou body foram modificados, salva snapshot no histórico (sem duplicatas)
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

        // Só cria versão se o conteúdo realmente mudou em relação ao estado atual
        if (curTitle !== newTitle || curBody !== newBody) {
          if (curTitle || curBody) {
            // Verifica se a última versão no histórico já não possui exatamente esse mesmo conteúdo
            const lastVersionRes = await db.execute({
              sql: `SELECT title, body FROM note_versions WHERE note_id = ? ORDER BY created_at DESC LIMIT 1`,
              args: [id],
            });

            let isDuplicate = false;
            if (lastVersionRes.rows.length > 0) {
              const lastV = lastVersionRes.rows[0];
              const lastTitle = ((lastV.title as string) || "").trim();
              const lastBody = ((lastV.body as string) || "").trim();
              if (lastTitle === curTitle && lastBody === curBody) {
                isDuplicate = true;
              }
            }

            if (!isDuplicate) {
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

    // Marcadores automáticos do corpo: recalcula quando o corpo mudou (falha silenciosa)
    let freshTags: unknown = null;
    if ("body" in body) {
      try {
        await syncBodyAutoTags(id, (body.body || "").trim());
        // Devolve as tags atualizadas pra UI aplicar na hora, sem precisar de refresh
        const tagsByNoteId = await getTagsByNoteId([id]);
        freshTags = tagsByNoteId[id] || [];
      } catch (tagErr) {
        console.warn("Falha nas auto-tags do corpo:", tagErr);
      }
    }

    return NextResponse.json({ success: true, updated_at: now, tags: freshTags });
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

    // 1. Busca todos os anexos (imagens, áudios) vinculados à nota antes de deletar
    const attResult = await db.execute({
      sql: `SELECT storage_key FROM attachments WHERE note_id = ?`,
      args: [id],
    });

    // 2. Remove todos os arquivos do Cloudflare R2 / Storage local em paralelo
    if (attResult.rows.length > 0) {
      await Promise.allSettled(
        attResult.rows.map(async (row) => {
          const fileId = row.storage_key as string;
          if (fileId) {
            try {
              await deleteAttachmentFile(fileId);
            } catch (storageErr) {
              console.warn(`Aviso ao excluir arquivo "${fileId}" do storage:`, storageErr);
            }
          }
        })
      );
    }

    // 3. Remove a nota do Turso (cascade remove attachments e note_versions)
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
