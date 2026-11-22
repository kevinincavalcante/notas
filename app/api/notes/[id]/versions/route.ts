import { NextResponse } from "next/server";
import { db } from "@/lib/turso";
import { ensureVersionColumns } from "@/lib/note-versions";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    // Banco antigo sem as colunas novas? Migra antes de consultar.
    await ensureVersionColumns(db);

    const result = await db.execute({
      sql: `
        SELECT id, note_id, title, body, content_hash, created_at
        FROM note_versions
        WHERE note_id = ?
        ORDER BY created_at DESC
        LIMIT 50
      `,
      args: [id],
    });

    return NextResponse.json({ versions: result.rows });
  } catch (error) {
    console.error("Erro ao listar versões da nota:", error);
    return NextResponse.json({ error: "Erro ao buscar versões" }, { status: 500 });
  }
}
