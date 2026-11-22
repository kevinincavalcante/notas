import { NextResponse } from "next/server";
import { db } from "@/lib/turso";
import { syncBodyAutoTags } from "@/lib/url-autotag";
import { logChange } from "@/lib/sync-log";
import { appendVersionIfChanged } from "@/lib/note-versions";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; versionId: string }> }
) {
  try {
    const { id, versionId } = await params;
    // O cliente do cofre manda o hash do plaintext do estado ATUAL (o
    // servidor não consegue calcular com ciphertext).
    const body = await request.json().catch(() => null);

    // Busca a versão solicitada
    const versionResult = await db.execute({
      sql: `SELECT * FROM note_versions WHERE id = ? AND note_id = ?`,
      args: [versionId, id],
    });

    if (versionResult.rows.length === 0) {
      return NextResponse.json({ error: "Versão não encontrada" }, { status: 404 });
    }

    const version = versionResult.rows[0];
    const now = Date.now();

    // Salva a versão atual no histórico antes de sobrescrever para que o usuário não perca nada
    const currentRes = await db.execute({
      sql: `SELECT title, body, updated_at FROM notes WHERE id = ?`,
      args: [id],
    });

    if (currentRes.rows.length > 0) {
      const cur = currentRes.rows[0];
      const curTitle = (cur.title as string) || "";
      const curBody = (cur.body as string) || "";
      const restoreTitle = (version.title as string) || "";
      const restoreBody = (version.body as string) || "";

      // Não repete o histórico com estado vazio nem com a mesma versão
      // (hash do plaintext vindo no corpo, pra funcionar no cofre).
      if (curTitle !== restoreTitle || curBody !== restoreBody) {
        await appendVersionIfChanged(db, {
          note_id: id,
          title: curTitle,
          body: curBody,
          content_hash:
            typeof body?.prev_content_hash === "string" ? body.prev_content_hash : null,
          created_at: (cur.updated_at as number) || now,
        });
      }
    }

    // Aplica o título e corpo da versão selecionada diretamente na nota
    await db.execute({
      sql: `UPDATE notes SET title = ?, body = ?, updated_at = ? WHERE id = ?`,
      args: [version.title as string, version.body as string, now, id],
    });

    await logChange("note", id, "upsert");

    // O corpo restaurado pode ter URLs diferentes: recalcula as auto-tags de URL
    // (falha silenciosa). Notas do cofre ficam de fora — corpo é ciphertext.
    const vaultRes = await db.execute({
      sql: `SELECT is_vault FROM notes WHERE id = ?`,
      args: [id],
    });
    if (!vaultRes.rows[0]?.is_vault) {
      try {
        await syncBodyAutoTags(id, (version.body as string) || "");
      } catch (tagErr) {
        console.warn("Falha nas auto-tags de URL após restauração:", tagErr);
      }
    }

    // Busca nota completa atualizada
    const noteRes = await db.execute({
      sql: `SELECT * FROM notes WHERE id = ?`,
      args: [id],
    });
    const updatedNote = noteRes.rows[0] || {};

    return NextResponse.json({
      success: true,
      note: {
        ...updatedNote,
        is_pinned: Boolean(updatedNote.is_pinned),
        is_archived: Boolean(updatedNote.is_archived),
      },
      restored: {
        title: version.title,
        body: version.body,
        updated_at: now,
      },
    });
  } catch (error) {
    console.error("Erro ao restaurar versão:", error);
    return NextResponse.json({ error: "Erro ao restaurar versão" }, { status: 500 });
  }
}
