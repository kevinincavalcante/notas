import { db } from "@/lib/turso";
import type { Client } from "@libsql/client";

/**
 * Registra uma mutação no change_log — a base do cursor incremental do sync
 * (docs/SYNC.md). O `seq` auto-incremento é o cursor: réplicas puxam tudo
 * com seq > seu último cursor.
 *
 * Deve ser chamado SEMPRE na mesma operação que mutou o dado (logo após a
 * escrita principal ter sucesso). Se o log falhar, a mudança fica invisível
 * pro sync — por isso NÃO engolimos o erro: a rota falha e o cliente repete
 * a operação (idempotente), re-logando de forma consistente.
 *
 * O client é opcional: rotas web usam o `db` global; o motor de sync do
 * desktop passa o client da réplica em que está aplicando a mudança.
 */
export async function logChange(
  entity: "note" | "attachment" | "tombstone",
  entityId: string,
  op: "upsert" | "delete",
  client: Client = db
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO change_log (entity, entity_id, op, at) VALUES (?, ?, ?, ?)`,
    args: [entity, entityId, op, Date.now()],
  });
}
