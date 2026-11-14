import { NextResponse } from "next/server";
import { db } from "@/lib/turso";
import { logChange } from "@/lib/sync-log";

/**
 * Material do cofre (vault_meta): salt + iterações + DEK embrulhada.
 *
 * O servidor NUNCA vê a senha do cofre — tudo aqui é opaco pra ele (a DEK
 * vem "embrulhada" pela chave derivada da senha no cliente, modelo B).
 * Qualquer dispositivo consegue destravar digitando a senha, porque o
 * material sincroniza como entidade do protocolo.
 */

const VAULT_ID = "default";

export async function GET() {
  try {
    const res = await db.execute({
      sql: `SELECT id, salt, iterations, kdf, wrapped_dek, updated_at FROM vault_meta WHERE id = ?`,
      args: [VAULT_ID],
    });
    const meta = res.rows[0];
    if (!meta) {
      return NextResponse.json({ setup: true });
    }
    return NextResponse.json({
      setup: false,
      vault_meta: meta,
    });
  } catch (error) {
    console.error("Erro ao ler material do cofre:", error);
    return NextResponse.json({ error: "Erro ao ler material do cofre" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const data = await request.json();
    const { salt, iterations, kdf, wrapped_dek, updated_at } = data || {};
    if (!salt || !wrapped_dek || !Number(iterations)) {
      return NextResponse.json({ error: "Material do cofre incompleto" }, { status: 400 });
    }

    // LWW: rejeita gravar por cima de material mais novo (ex.: troca de senha
    // feita em outro dispositivo no meio do caminho)
    const current = await db.execute({
      sql: `SELECT updated_at FROM vault_meta WHERE id = ?`,
      args: [VAULT_ID],
    });
    const currentAt = Number(current.rows[0]?.updated_at) || 0;
    const incomingAt = Number(updated_at) || Date.now();
    if (incomingAt < currentAt) {
      return NextResponse.json(
        { error: "conflict", vault_meta: current.rows[0] ?? null },
        { status: 409 }
      );
    }

    await db.execute({
      sql: `
        INSERT INTO vault_meta (id, salt, iterations, kdf, wrapped_dek, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          salt = excluded.salt,
          iterations = excluded.iterations,
          kdf = excluded.kdf,
          wrapped_dek = excluded.wrapped_dek,
          updated_at = excluded.updated_at
      `,
      args: [VAULT_ID, salt, Number(iterations), kdf || "PBKDF2-SHA256", wrapped_dek, incomingAt],
    });
    await logChange("vault_meta", VAULT_ID, "upsert");

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Erro ao salvar material do cofre:", error);
    return NextResponse.json({ error: "Erro ao salvar material do cofre" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    await db.execute({
      sql: `DELETE FROM vault_meta WHERE id = ?`,
      args: [VAULT_ID],
    });
    // Remove notas marcadas como cofre que ficaram órfãs
    await db.execute({
      sql: `DELETE FROM notes WHERE is_vault = 1`,
      args: [],
    });
    await logChange("vault_meta", VAULT_ID, "delete");
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Erro ao resetar material do cofre:", error);
    return NextResponse.json({ error: "Erro ao resetar material do cofre" }, { status: 500 });
  }
}
