import { NextResponse } from "next/server";
import { runSync, type SyncPush } from "@/lib/sync";
import { db } from "@/lib/turso";

/**
 * POST /api/sync — protocolo de sincronização entre réplicas (docs/SYNC.md).
 *
 * Protegida pelo mesmo JWT da app (cookie auth_token, via proxy.ts).
 * O app desktop loga uma vez na réplica remota e usa o token pro sync.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);

    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Payload inválido" }, { status: 400 });
    }

    const cursor = Number(body.cursor) || 0;
    if (cursor < 0) {
      return NextResponse.json({ error: "cursor negativo" }, { status: 400 });
    }

    const push: SyncPush = body.push || {};
    const result = await runSync(db, cursor, push);

    return NextResponse.json(result);
  } catch (error) {
    console.error("Erro no sync:", error);
    return NextResponse.json({ error: "Erro no sync" }, { status: 500 });
  }
}
