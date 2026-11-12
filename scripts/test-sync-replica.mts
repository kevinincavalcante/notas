/**
 * Teste ponta a ponta do cliente de sync de réplica (lib/sync-replica.ts):
 * uma réplica local (SQLite em arquivo) sincronizando DIRETO com o Turso —
 * sem servidor web no meio, como o Electron fará.
 *
 * Cria notas de teste próprias e limpa no final (tombstones). Nada seu é tocado.
 * Uso: npm run test:sync:replica
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

const remote = createClient({
  url: process.env.TURSO_URL || process.env.TURSO_LINK,
  authToken: process.env.TURSO_TOKEN,
});

// Réplica local em arquivo descartável
const dir = join(tmpdir(), `sync-replica-test-${randomUUID()}`);
mkdirSync(dir, { recursive: true });
const localPath = join(dir, "notas.db");
const local = createClient({ url: `file:${localPath}` });
await ensureSchema(local);
console.log(`Réplica local: ${localPath}\n`);

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

// ---- 1. Bootstrap: primeira sync puxa tudo do remoto ----
const boot = await syncOnce(local, remote);
const localCount = await local.execute(`SELECT COUNT(*) AS c FROM notes`);
check("bootstrap puxa as notas do remoto", Number(localCount.rows[0].c) > 0, {
  local: Number(localCount.rows[0].c),
});
const metaCursor = await local.execute(`SELECT value FROM sync_meta WHERE key = 'sync_cursor'`);
check("cursor salvo na réplica", Number(metaCursor.rows[0]?.value) > 0);
const logAfterBoot = await local.execute(`SELECT COUNT(*) AS c FROM change_log`);
check("pull não polui o change_log local", Number(logAfterBoot.rows[0].c) === 0);

// ---- 2. Escrita local → push pro remoto ----
const localNoteId = randomUUID();
const now = Date.now();
await local.execute({
  sql: `INSERT INTO notes (id, title, body, color, is_pinned, is_archived, created_at, updated_at)
        VALUES (?, ?, ?, 'default', 0, 0, ?, ?)`,
  args: [localNoteId, "REPLICA TEST local", "criada na réplica", now, now],
});
await logChange("note", localNoteId, "upsert", local);

const s2 = await syncOnce(local, remote);
check("push da nota local sem conflitos", s2.pushedNotes === 1 && s2.conflicts.length === 0, s2);
const noRemoto = await remote.execute({
  sql: `SELECT title FROM notes WHERE id = ?`,
  args: [localNoteId],
});
check("nota local chegou no remoto", noRemoto.rows[0]?.title === "REPLICA TEST local");

// Segunda sync sem mudanças: idempotente (nada a pushar)
const s2b = await syncOnce(local, remote);
check("sync sem mudanças é idempotente", s2b.pushedNotes === 0 && s2b.pulledNotes === 0, s2b);

// ---- 3. Conflito LWW: update local velho perde pro estado do remoto ----
await local.execute({
  sql: `UPDATE notes SET title = ?, updated_at = ? WHERE id = ?`,
  args: ["REPLICA TEST velho", now - 5000, localNoteId],
});
await logChange("note", localNoteId, "upsert", local);
const s3 = await syncOnce(local, remote);
check("update velho reportado como conflito", s3.conflicts.includes(localNoteId), s3.conflicts);
const tituloRemoto = await remote.execute({
  sql: `SELECT title FROM notes WHERE id = ?`,
  args: [localNoteId],
});
check("remoto preservou o título vencedor", tituloRemoto.rows[0]?.title === "REPLICA TEST local", tituloRemoto.rows[0]?.title);

// ---- 4. Update local NOVO vence e reflete no remoto ----
await local.execute({
  sql: `UPDATE notes SET title = ?, updated_at = ? WHERE id = ?`,
  args: ["REPLICA TEST venceu", now + 5000, localNoteId],
});
await logChange("note", localNoteId, "upsert", local);
const s4 = await syncOnce(local, remote);
check("update novo aplicado", s4.conflicts.length === 0, s4);
const tituloFinal = await remote.execute({
  sql: `SELECT title FROM notes WHERE id = ?`,
  args: [localNoteId],
});
check("remoto recebeu o update novo", tituloFinal.rows[0]?.title === "REPLICA TEST venceu", tituloFinal.rows[0]?.title);

// ---- 5. Mudança criada no REMOTO → pull pra réplica ----
const remoteNoteId = randomUUID();
const now5 = Date.now();
await remote.execute({
  sql: `INSERT INTO notes (id, title, body, color, is_pinned, is_archived, created_at, updated_at)
        VALUES (?, ?, ?, 'default', 0, 0, ?, ?)`,
  args: [remoteNoteId, "REPLICA TEST remota", "criada direto no remoto", now5, now5],
});
await logChange("note", remoteNoteId, "upsert", remote);

const s5 = await syncOnce(local, remote);
const noLocal = await local.execute({
  sql: `SELECT title FROM notes WHERE id = ?`,
  args: [remoteNoteId],
});
check("nota remota puxada pra réplica", noLocal.rows[0]?.title === "REPLICA TEST remota", s5);

// ---- 6. Exclusão no REMOTO → tombstone chega na réplica ----
await remote.execute({
  sql: `DELETE FROM notes WHERE id = ?`,
  args: [remoteNoteId],
});
await remote.execute({
  sql: `INSERT INTO tombstones (id, entity, deleted_at) VALUES (?, 'note', ?)`,
  args: [remoteNoteId, Date.now()],
});
await logChange("tombstone", remoteNoteId, "delete", remote);

await syncOnce(local, remote);
const localAposTombo = await local.execute({
  sql: `SELECT 1 AS x FROM notes WHERE id = ?`,
  args: [remoteNoteId],
});
check("tombstone do remoto apagou a nota local", localAposTombo.rows.length === 0);

// ---- 7. Exclusão na RÉPLICA → tombstone apaga no remoto ----
await local.execute({
  sql: `DELETE FROM notes WHERE id = ?`,
  args: [localNoteId],
});
await local.execute({
  sql: `INSERT INTO tombstones (id, entity, deleted_at) VALUES (?, 'note', ?)`,
  args: [localNoteId, Date.now()],
});
await logChange("tombstone", localNoteId, "delete", local);

await syncOnce(local, remote);
const remotoAposTombo = await remote.execute({
  sql: `SELECT 1 AS x FROM notes WHERE id = ?`,
  args: [localNoteId],
});
check("tombstone da réplica apagou no remoto", remotoAposTombo.rows.length === 0);

// ---- 8. Histórico de versões: bootstrap backfilla versões antigas do remoto ----
const vNoteId = randomUUID();
const nowV = Date.now();
await remote.execute({
  sql: `INSERT INTO notes (id, title, body, color, is_pinned, is_archived, created_at, updated_at)
        VALUES (?, ?, ?, 'default', 0, 0, ?, ?)`,
  args: [vNoteId, "REPLICA TEST versoes", "nota com histórico", nowV, nowV],
});
await logChange("note", vNoteId, "upsert", remote);
const vOldId = randomUUID();
await remote.execute({
  sql: `INSERT INTO note_versions (id, note_id, title, body, created_at) VALUES (?, ?, ?, ?, ?)`,
  args: [vOldId, vNoteId, "REPLICA TEST versoes", "estado antigo da nota", nowV - 1000],
});

// réplica NOVA (watermark 0): o bootstrap tem que trazer o histórico inteiro,
// inclusive versões criadas antes do sync de versões existir (backfill)
const dir2 = join(tmpdir(), `sync-replica-test-${randomUUID()}`);
mkdirSync(dir2, { recursive: true });
const local2 = createClient({ url: `file:${join(dir2, "notas.db")}` });
await ensureSchema(local2);
const s8 = await syncOnce(local2, remote);
const versaoLocal = await local2.execute({
  sql: `SELECT body FROM note_versions WHERE id = ?`,
  args: [vOldId],
});
check("bootstrap backfilla versão antiga do remoto", versaoLocal.rows[0]?.body === "estado antigo da nota", s8);

// ---- 9. Versão criada na réplica → chega no remoto ----
const vLocalId = randomUUID();
await local2.execute({
  sql: `INSERT INTO note_versions (id, note_id, title, body, created_at) VALUES (?, ?, ?, ?, ?)`,
  args: [vLocalId, vNoteId, "REPLICA TEST versoes", "estado salvo na réplica", nowV + 500],
});
const s9 = await syncOnce(local2, remote);
const versaoRemota = await remote.execute({
  sql: `SELECT body FROM note_versions WHERE id = ?`,
  args: [vLocalId],
});
check("versão criada na réplica chegou no remoto", versaoRemota.rows[0]?.body === "estado salvo na réplica", s9);

// Sync de novo sem mudanças: nada novo. A versão exatamente na fronteira da
// marca d'água pode ser re-enviada (>=), mas INSERT OR IGNORE no destino
// garante que ela não duplica — nunca se perde uma versão, no máximo re-envia
const s9b = await syncOnce(local2, remote);
const countRemotoApos = await remote.execute({
  sql: `SELECT COUNT(*) AS c FROM note_versions WHERE note_id = ?`,
  args: [vNoteId],
});
check(
  "re-sync idempotente (re-envio de fronteira não duplica)",
  s9b.pulledVersions === 0 && Number(countRemotoApos.rows[0].c) === 2,
  { s9b, remoto: Number(countRemotoApos.rows[0].c) }
);

// ---- 10. Versão criada direto no remoto depois → pull incremental ----
const vRemoteId = randomUUID();
await remote.execute({
  sql: `INSERT INTO note_versions (id, note_id, title, body, created_at) VALUES (?, ?, ?, ?, ?)`,
  args: [vRemoteId, vNoteId, "REPLICA TEST versoes", "versao nova do remoto", nowV + 1000],
});
const s10 = await syncOnce(local2, remote);
const versaoPuxada = await local2.execute({
  sql: `SELECT body FROM note_versions WHERE id = ?`,
  args: [vRemoteId],
});
check("versão nova do remoto puxada incrementalmente", versaoPuxada.rows[0]?.body === "versao nova do remoto", s10);

// limpeza: nota de versões + segunda réplica
await remote.execute({ sql: `DELETE FROM notes WHERE id = ?`, args: [vNoteId] });
await remote.execute({
  sql: `INSERT INTO tombstones (id, entity, deleted_at) VALUES (?, 'note', ?)`,
  args: [vNoteId, Date.now()],
});
await logChange("tombstone", vNoteId, "delete", remote);
await syncOnce(local2, remote);
rmSync(dir2, { recursive: true, force: true });

// limpeza
rmSync(dir, { recursive: true, force: true });

console.log(`\nResultado: ${pass} ok / ${fail} falha`);
process.exit(fail > 0 ? 1 : 0);
