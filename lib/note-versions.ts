import type { Client } from "@libsql/client";
import { migrateVersionColumns } from "./db-migrate";
import { EMPTY_CONTENT_HASH, isEncrypted, isEncryptedEmpty } from "./vault-crypto";

/**
 * Dicionário do histórico de versões (`note_versions`).
 *
 * Regras que valem em TODAS as réplicas (web, desktop, mobile, sync):
 *  - `content_hash` identifica o CONTEÚDO EM CLARO. No cofre, title/body são
 *    ciphertext com IV aleatório: comparar as strings nunca detecta "mesmo
 *    conteúdo" (cada `encryptString` gera IV novo), então a deduplicação do
 *    histórico precisa do hash calculado antes de cifrar.
 *  - Estado VAZIO não vira versão. No cofre o ciphertext de "" é truthy, por
 *    isso a checagem antiga (`if (curTitle || curBody)`) nunca barrava nada.
 */

export interface VersionSnapshot {
  note_id: string;
  title: string;
  body: string;
  /** Hash do plaintext; null quando desconhecido (versão antiga/cliente sem hash). */
  content_hash?: string | null;
  created_at: number;
}

/** Conteúdo vazio: sem título, sem corpo — ou hash/ciphertext de vazio. */
export function isBlankVersion(v: {
  title?: string | null;
  body?: string | null;
  content_hash?: string | null;
}): boolean {
  const hash = v.content_hash ? String(v.content_hash) : "";
  // O hash do "vazio" prova que o plaintext era vazio mesmo que o campo
  // venha cifrado (cofre) — não pode entrar no histórico.
  if (hash) return hash === EMPTY_CONTENT_HASH;

  const title = v.title || "";
  const body = v.body || "";
  if (!title.trim() && !body.trim()) return true;

  // Versões antigas do cofre (gravadas sem hash): o ciphertext de "" tem
  // sempre 16 bytes de tag. Se nem título nem corpo têm conteúdo, é vazio.
  if (isEncrypted(title) && isEncrypted(body)) {
    return isEncryptedEmpty(title) && isEncryptedEmpty(body);
  }
  return false;
}

/**
 * O snapshot de timeline do sync vale para esta nota? Só fora do cofre: o
 * estado anterior chega como ciphertext, sem como saber se era vazio nem
 * comparar conteúdo — era daí que saíam versões vazias do cofre. As edições do
 * cofre geram histórico no próprio cliente (com hash do plaintext).
 */
export function shouldSnapshotInstance(note: { is_vault?: number | boolean | null }): boolean {
  return !note?.is_vault;
}

/** Última versão da nota (a mais recente pelo `created_at`). */
async function lastVersion(client: Client, noteId: string): Promise<VersionSnapshot | null> {
  const res = await client.execute({
    sql: `SELECT note_id, title, body, content_hash, created_at
          FROM note_versions WHERE note_id = ?
          ORDER BY created_at DESC LIMIT 1`,
    args: [noteId],
  });
  return (res.rows[0] as unknown as VersionSnapshot) || null;
}

/**
 * A versão anterior (`next`) pode entrar como snapshot? Duas guardas:
 *  1. nunca grava estado vazio;
 *  2. não repete a última versão — compara pelo hash do plaintext quando os
 *     dois lados têm hash (funciona no cofre); senão cai pra comparação das
 *     strings (notas normais e versões antigas sem hash).
 */
export function shouldAppendVersion(
  prev: VersionSnapshot | null,
  next: VersionSnapshot
): boolean {
  if (isBlankVersion(next)) return false;
  if (!prev) return true;
  if (prev.content_hash && next.content_hash) {
    return prev.content_hash !== next.content_hash;
  }
  return (
    (prev.title || "").trim() !== (next.title || "").trim() ||
    (prev.body || "").trim() !== (next.body || "").trim()
  );
}

/**
 * Garante as colunas do histórico antes de qualquer leitura/gravação. O Turso
 * (web) não roda `ensureSchema` no boot: chamar aqui faz a primeira consulta
 * já funcionar sem precisar de `npm run db:init`. Cache por client evita
 * repetir os PRAGMAs no mesmo processo.
 */
const migratedClients = new WeakSet<Client>();
export async function ensureVersionColumns(client: Client): Promise<void> {
  if (migratedClients.has(client)) return;
  await migrateVersionColumns(client);
  migratedClients.add(client);
}

/**
 * Grava um snapshot no histórico se ele for válido e diferente do último.
 * `is_instance_snapshot`: marca o snapshot que o SYNC cria ao aplicar um push
 * de outra réplica (linha de timeline, não edição do usuário — ver
 * docs/SYNC.md). Nunca lança: falha no histórico não pode derrubar o save.
 *
 * @returns true se a linha foi inserida.
 */
export async function appendVersionIfChanged(
  client: Client,
  snapshot: VersionSnapshot & { is_instance_snapshot?: boolean }
): Promise<boolean> {
  try {
    await ensureVersionColumns(client);
    const prev = await lastVersion(client, snapshot.note_id);
    if (!shouldAppendVersion(prev, snapshot)) return false;

    await client.execute({
      sql: `
        INSERT INTO note_versions
          (id, note_id, title, body, content_hash, is_instance_snapshot, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        crypto.randomUUID(),
        snapshot.note_id,
        snapshot.title ?? "",
        snapshot.body ?? "",
        snapshot.content_hash ?? null,
        snapshot.is_instance_snapshot ? 1 : 0,
        snapshot.created_at || Date.now(),
      ],
    });
    return true;
  } catch (err) {
    console.warn(`Falha ao gravar versão da nota ${snapshot.note_id}:`, err);
    return false;
  }
}
