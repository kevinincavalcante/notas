import { NextResponse } from "next/server";
import { db } from "@/lib/turso";
import { getTagsByNoteId } from "@/lib/tags";
import { syncBodyAutoTags } from "@/lib/url-autotag";
import { logChange } from "@/lib/sync-log";
import { deleteAttachmentFile } from "@/lib/storage";
import { appendVersionIfChanged } from "@/lib/note-versions";

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
        is_vault: Boolean(note.is_vault),
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

    const allowedFields = ["title", "body", "color", "is_pinned", "is_archived", "is_vault"];
    const updates: string[] = [];
    const values: any[] = [];

    // Hash do CONTEÚDO EM CLARO da versão anterior e do novo (o cofre manda;
    // nunca é persistido na nota, só no histórico). Fora de allowedFields.
    const prevContentHash =
      typeof body.prev_content_hash === "string" && body.prev_content_hash
        ? body.prev_content_hash
        : null;
    const newContentHash =
      typeof body.content_hash === "string" && body.content_hash ? body.content_hash : null;

    // Se title ou body foram modificados, salva snapshot no histórico (sem
    // duplicatas — no cofre a comparação é pelo hash do plaintext, já que o
    // ciphertext muda a cada cifração por causa do IV aleatório).
    if ("title" in body || "body" in body) {
      const currentResult = await db.execute({
        sql: `SELECT title, body, updated_at FROM notes WHERE id = ?`,
        args: [id],
      });

      if (currentResult.rows.length > 0) {
        const cur = currentResult.rows[0];
        const curTitle = (cur.title as string) || "";
        const curBody = (cur.body as string) || "";
        const newTitle = "title" in body ? (body.title || "") : curTitle;
        const newBody = "body" in body ? (body.body || "") : curBody;

        // Mudou de verdade? Com os dois hashes (cofre) a resposta é exata;
        // sem eles cai na comparação de texto (notas normais).
        const changed =
          prevContentHash && newContentHash
            ? prevContentHash !== newContentHash
            : curTitle.trim() !== String(newTitle).trim() ||
              curBody.trim() !== String(newBody).trim();

        if (changed) {
          await appendVersionIfChanged(db, {
            note_id: id,
            title: curTitle,
            body: curBody,
            content_hash: prevContentHash,
            created_at: (cur.updated_at as number) || Date.now(),
          });
        }
      }
    }

    for (const field of allowedFields) {
      if (field in body) {
        updates.push(`${field} = ?`);
        if (field === "is_pinned" || field === "is_archived" || field === "is_vault") {
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
    await logChange("note", id, "upsert");

    // Marcadores automáticos do corpo: recalcula quando o corpo mudou (falha
    // silenciosa). Notas do cofre são puladas — o corpo é ciphertext.
    let freshTags: unknown = null;
    const noteIsVault = await db.execute({
      sql: `SELECT is_vault FROM notes WHERE id = ?`,
      args: [id],
    });
    const vaultFlag = Boolean(Number(noteIsVault.rows[0]?.is_vault) || 0);
    if ("body" in body && !vaultFlag) {
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

    // 4. Tombstone: exclusões propagam pelo sync (docs/SYNC.md)
    await db.execute({
      sql: `
        INSERT INTO tombstones (id, entity, deleted_at)
        VALUES (?, 'note', ?)
        ON CONFLICT(id) DO UPDATE SET deleted_at = MAX(deleted_at, excluded.deleted_at)
      `,
      args: [id, Date.now()],
    });
    await logChange("tombstone", id, "delete");

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Erro ao excluir nota:", error);
    return NextResponse.json({ error: "Erro ao excluir nota" }, { status: 500 });
  }
}
