/**
 * Teste do material do cofre (vault_meta) no sync de réplica:
 * setup feito na réplica propaga pro hub e vice-versa (LWW por updated_at),
 * e notas is_vault trafegam ciphertext pelos dois sentidos.
 *
 * Cria dados de teste próprios e limpa no final. Uso: npx tsx scripts/test-vault-sync.mts
 */
import { readFileSync, existsSync, rmSync, mkdirSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

function loadEnv() {
  const envPath = resolve(process.cwd(), ".env.local");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i !== -1 && !process.env[t.slice(0, i).trim()]) {
        process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      }
    }
  }
}
loadEnv();

const { createClient } = await import("@libsql/client");
const { ensureSchema } = await import("../lib/db-schema.js");
const { syncOnce } = await import("../lib/sync-replica.js");
const { logChange } = await import("../lib/sync-log.js");
const { createVaultMaterial, isEncrypted } = await import("../lib/vault-crypto.js");

const remote = createClient({
  url: process.env.TURSO_URL || process.env.TURSO_LINK,
  authToken: process.env.TURSO_TOKEN,
});

const dir = join(tmpdir(), `vault-sync-test-${randomUUID()}`);
mkdirSync(dir, { recursive: true });
const local = createClient({ url: `file:${join(dir, "notas.db")}` });
await ensureSchema(local);
console.log(`Réplica local: ${join(dir, "notas.db")}\n`);

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  if (ok) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}`, extra !== undefined ? JSON.stringify(extra).substring(0, 300) : "");
  }
}

/**
 * syncOnce NÃO lança em falha de push/pull (ok:false silencioso) — nos testes
 * isso tem que estourar, senão a limpeza falha em silêncio e deixa lixo no hub.
 */
async function assertSync(local: Client, remote: Client): Promise<void> {
  const r = await syncOnce(local, remote);
  if (!r.ok) {
    throw new Error(`syncOnce falhou: ${r.error}`);
  }
}

const testId = randomUUID();

try {
  // Bootstrap limpo
  await assertSync(local, remote);

  // ---- 1. Nota do cofre criada na réplica → sobe cifrada ----
  const vaultNoteId = `vt-${testId}`;
  await local.execute({
    sql: `INSERT INTO notes (id, title, body, color, is_pinned, is_archived, is_vault, created_at, updated_at)
          VALUES (?, 'enc1:AAAA', 'enc1:BBBB', 'default', 0, 0, 1, ?, ?)`,
    args: [vaultNoteId, Date.now(), Date.now()],
  });
  await logChange("note", vaultNoteId, "upsert", local);

  await assertSync(local, remote);

  const remoteNote = await remote.execute({
    sql: `SELECT title, body, is_vault FROM notes WHERE id = ?`,
    args: [vaultNoteId],
  });
  check(
    "nota do cofre da réplica chega cifrada no hub",
    remoteNote.rows[0] &&
      remoteNote.rows[0].title === "enc1:AAAA" &&
      Number(remoteNote.rows[0].is_vault) === 1
  );

  // ---- 2. vault_meta: setup na réplica propaga pro hub ----
  const material = createVaultMaterial("senha-teste-sync", 100_000);
  await local.execute({
    sql: `INSERT INTO vault_meta (id, salt, iterations, kdf, wrapped_dek, updated_at)
          VALUES ('default', ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            salt = excluded.salt,
            iterations = excluded.iterations,
            kdf = excluded.kdf,
            wrapped_dek = excluded.wrapped_dek,
            updated_at = excluded.updated_at`,
    args: [material.salt, material.iterations, material.kdf, material.wrapped_dek, Date.now()],
  });
  await logChange("vault_meta", "default", "upsert", local);

  await assertSync(local, remote);

  const hubMeta = await remote.execute({ sql: `SELECT salt, wrapped_dek FROM vault_meta WHERE id = 'default'` });
  check(
    "vault_meta da réplica chega no hub",
    hubMeta.rows[0]?.salt === material.salt && hubMeta.rows[0]?.wrapped_dek === material.wrapped_dek
  );

  // ---- 3. vault_meta atualizada no hub → réplica nova recebe no bootstrap ----
  const replica2Dir = join(dir, "replica2.db");
  const local2 = createClient({ url: `file:${replica2Dir}` });
  await ensureSchema(local2);
  const boot = await syncOnce(local2, remote);
  check("bootstrap puxa vault_meta", boot.ok);
  const meta2 = await local2.execute({ sql: `SELECT wrapped_dek FROM vault_meta WHERE id = 'default'` });
  check(
    "réplica nova recebe o material do cofre",
    meta2.rows[0]?.wrapped_dek === material.wrapped_dek
  );

  // ---- 4. LWW do vault_meta: versão mais nova vence ----
  await local.execute({
    sql: `UPDATE vault_meta SET wrapped_dek = 'enc1:NEW', updated_at = ? WHERE id = 'default'`,
    args: [Date.now() + 50_000],
  });
  await logChange("vault_meta", "default", "upsert", local);
  await assertSync(local, remote);
  const hubMeta2 = await remote.execute({ sql: `SELECT wrapped_dek FROM vault_meta WHERE id = 'default'` });
  check("LWW: wrapped_dek mais novo vence no hub", hubMeta2.rows[0]?.wrapped_dek === "enc1:NEW");

  // ---- 5. ciphertext não entra no FTS local ----
  // ATENÇÃO: sem MATCH, o FTS5 external-content lê direto da tabela de
  // conteúdo (retorna tudo). Só MATCH prova o índice de verdade.
  const fts = await local.execute({
    sql: `SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?`,
    args: ['"AAAA"*'],
  });
  check("nota do cofre fora do índice FTS da réplica", fts.rows.length === 0);

  // Limpeza: tombstone da nota de teste + material
  await local.execute({
    sql: `INSERT INTO tombstones (id, entity, deleted_at) VALUES (?, 'note', ?)`,
    args: [vaultNoteId, Date.now()],
  });
  await logChange("tombstone", vaultNoteId, "delete", local);
  await assertSync(local, remote);
  const gone = await remote.execute({ sql: `SELECT 1 FROM notes WHERE id = ?`, args: [vaultNoteId] });
  check("nota de teste removida do hub", gone.rows.length === 0);
} catch (err) {
  console.error("💥 erro:", err);
  fail++;
} finally {
  // material de teste sai do hub
  await remote.execute({ sql: `DELETE FROM vault_meta WHERE id = 'default'` }).catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nResultado: ${pass} ok / ${fail} falha`);
process.exit(fail > 0 ? 1 : 0);
