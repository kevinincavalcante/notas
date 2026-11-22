import type { Client } from "@libsql/client";

/**
 * Migrações idempotentes de colunas que o CREATE IF NOT EXISTS não cobre
 * (ALTER TABLE é one-shot). Roda em TODOS os bancos: web/Turso, desktop e
 * mobile (via ensureSchema) — scripts/init-db.mjs replica as mesmas.
 */

/** Helper compartilhado: `true` se a tabela já tem a coluna. */
export async function hasColumn(client: Client, table: string, column: string): Promise<boolean> {
  const cols = await client.execute({ sql: `PRAGMA table_info(${table})`, args: [] });
  return cols.rows.some((r) => r.name === column);
}

/**
 * Histórico de versões:
 *  - `content_hash`: hash determinístico do CONTEÚDO EM CLARO da versão.
 *    No cofre title/body são ciphertext com IV aleatório — comparar string
 *    direto nunca detecta "mesmo conteúdo" (IV diferente → string diferente),
 *    e era isso que enchia o histórico de versões repetidas/vazias. O cliente
 *    calcula o hash antes de cifrar e manda junto no PATCH.
 *  - `is_instance_snapshot`: marca o snapshot automático que o sync cria
 *    quando aplica um push de outra réplica. Esses snapshots são linhas de
 *    timeline (o que a réplica viu), não edições do usuário.
 */
export async function migrateVersionColumns(client: Client): Promise<void> {
  if (!(await hasColumn(client, "note_versions", "content_hash"))) {
    await client.execute(`ALTER TABLE note_versions ADD COLUMN content_hash TEXT DEFAULT NULL`);
  }
  if (!(await hasColumn(client, "note_versions", "is_instance_snapshot"))) {
    await client.execute(
      `ALTER TABLE note_versions ADD COLUMN is_instance_snapshot INTEGER NOT NULL DEFAULT 0`
    );
  }
}

/**
 * Limpeza opcional do histórico antigo (`npm run db:purge-blank-versions`):
 * apaga as versões de estado vazio que os bugs anteriores gravaram. Não roda
 * sozinho — o usuário decide quando limpar o que já existe.
 */
export async function purgeBlankVersions(client: Client): Promise<number> {
  try {
    await migrateVersionColumns(client);
    const res = await client.execute({
      sql: `
        DELETE FROM note_versions
        WHERE COALESCE(TRIM(title), '') = ''
          AND COALESCE(TRIM(body), '') = ''
          AND content_hash IS NULL
      `,
      args: [],
    });
    return res.rowsAffected;
  } catch {
    return 0;
  }
}
