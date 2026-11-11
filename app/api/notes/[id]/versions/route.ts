import { NextResponse } from "next/server";
import { db } from "@/lib/turso";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const result = await db.execute({
      sql: `
        SELECT id, note_id, title, body, created_at
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
