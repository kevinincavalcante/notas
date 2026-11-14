import { NextResponse } from "next/server";
import { db } from "@/lib/turso";
import { logChange } from "@/lib/sync-log";

/**
 * Reescreve o conteúdo das versões de uma nota — usado APENAS nas
 * transições do cofre:
 *
 *   - entrar no cofre: o cliente cifra title/body de cada versão e envia aqui;
 *   - sair do cofre: o cliente envia as versões descriptografadas.
 *
 * O servidor nunca vê plaintext (ou vê só no momento em que a nota deixa o
 * cofre — o mesmo PATCH que tira a nota do cofre já grava o texto claro).
 * Versões continuam append-only no protocolo: IDs são preservados.
 */

interface IncomingVersion {
  id: string;
  title: string;
  body: string;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const data = await request.json();
    const versions: IncomingVersion[] = Array.isArray(data?.versions) ? data.versions : [];

    if (versions.length === 0) {
      return NextResponse.json({ error: "Nenhuma versão enviada" }, { status: 400 });
    }

    let updated = 0;
    for (const ver of versions) {
      if (!ver?.id) continue;
      const res = await db.execute({
        sql: `UPDATE note_versions SET title = ?, body = ? WHERE id = ? AND note_id = ?`,
        args: [ver.title ?? "", ver.body ?? "", ver.id, id],
      });
      if (res.rowsAffected > 0) updated++;
    }

    if (updated > 0) {
      await logChange("note", id, "upsert");
    }

    return NextResponse.json({ success: true, updated });
  } catch (error) {
    console.error("Erro ao atualizar versões da nota:", error);
    return NextResponse.json({ error: "Erro ao atualizar versões" }, { status: 500 });
  }
}
