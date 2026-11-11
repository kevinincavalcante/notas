import { NextResponse } from "next/server";
import { db } from "@/lib/turso";

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
    const now = Date.now();

    // Aplica o título e corpo da versão selecionada diretamente na nota (sem criar nova versão no histórico)
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
