import { db } from "@/lib/turso";

/**
 * Registra uma mutação no change_log — a base do cursor incremental do sync
 * (docs/SYNC.md). O `seq` auto-incremento é o cursor: réplicas puxam tudo
 * com seq > seu último cursor.
 *
 * Deve ser chamado SEMPRE na mesma operação que mutou o dado (logo após a
 * escrita principal ter sucesso). Se o log falhar, a mudança fica invisível
 * pro sync — por isso NÃO engolimos o erro: a rota falha e o cliente repete
 * a operação (idempotente), re-logando de forma consistente.
 */
export async function logChange(
  entity: "note" | "attachment" | "tombstone",
  entityId: string,
  op: "upsert" | "delete"
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO change_log (entity, entity_id, op, at) VALUES (?, ?, ?, ?)`,
    args: [entity, entityId, op, Date.now()],
  });
}
