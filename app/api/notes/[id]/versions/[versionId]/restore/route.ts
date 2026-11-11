import { NextResponse } from "next/server";
import { db } from "@/lib/turso";
import crypto from "crypto";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; versionId: string }> }
) {
  try {
    const { id, versionId } = await params;

    // Busca a versão solicitada
    const versionResult = await db.execute({
      sql: `SELECT * FROM note_versions WHERE id = ? AND note_id = ?`,
      args: [versionId, id],
    });

    if (versionResult.rows.length === 0) {
      return NextResponse.json({ error: "Versão não encontrada" }, { status: 404 });
    }

    const version = versionResult.rows[0];

    // Busca a nota atual para guardar o estado antes de restaurar
    const currentNoteResult = await db.execute({
      sql: `SELECT title, body, updated_at FROM notes WHERE id = ?`,
      args: [id],
    });

    const now = Date.now();

    if (currentNoteResult.rows.length > 0) {
      const cur = currentNoteResult.rows[0];
      const curTitle = ((cur.title as string) || "").trim();
      const curBody = ((cur.body as string) || "").trim();

      // Só cria versão da nota atual se não for idêntica à última versão do histórico
      const lastVersionRes = await db.execute({
        sql: `SELECT title, body FROM note_versions WHERE note_id = ? ORDER BY created_at DESC LIMIT 1`,
        args: [id],
      });

      let isDuplicate = false;
      if (lastVersionRes.rows.length > 0) {
        const lastV = lastVersionRes.rows[0];
        if (
          ((lastV.title as string) || "").trim() === curTitle &&
          ((lastV.body as string) || "").trim() === curBody
        ) {
          isDuplicate = true;
        }
      }

      if (!isDuplicate && (curTitle || curBody)) {
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
            (cur.updated_at as number) || now,
          ],
        });
      }
    }

    // Aplica o título e corpo da versão selecionada
    await db.execute({
      sql: `UPDATE notes SET title = ?, body = ?, updated_at = ? WHERE id = ?`,
      args: [version.title as string, version.body as string, now, id],
    });

    return NextResponse.json({
      success: true,
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
