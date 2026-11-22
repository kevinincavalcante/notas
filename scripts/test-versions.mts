/**
 * Teste das regras do histórico de versões (lib/note-versions.ts) e do sync.
 *
 * Cobre o bug relatado: nota criada no cofre gerava versões no histórico
 * (inclusive de conteúdo vazio) porque a deduplicação comparava ciphertext,
 * que muda a cada cifração por causa do IV aleatório.
 *
 * Roda 100% em SQLite local descartável — não toca no Turso nem no seu banco.
 * Uso: npm run test:versions
 */
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

const { createClient } = await import("@libsql/client");
const { ensureSchema } = await import("../lib/db-schema.js");
const { appendVersionIfChanged, isBlankVersion, shouldSnapshotInstance } = await import(
  "../lib/note-versions.js"
);
const { versionContentHash, encryptString, EMPTY_CONTENT_HASH } = await import(
  "../lib/vault-crypto.js"
);
const { applyPull } = await import("../lib/sync-core.js");

const dir = join(tmpdir(), `vers-test-${randomUUID()}`);
mkdirSync(dir, { recursive: true });
const db = createClient({ url: `file:${join(dir, "notas.db")}` });
await ensureSchema(db);

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  if (ok) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}`, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : "");
  }
}

const dek = new Uint8Array(32).fill(7);
const noteId = "note-cofre-1";
const now = Date.now();

await db.execute({
  sql: `INSERT INTO notes (id, title, body, color, is_pinned, is_archived, is_vault, created_at, updated_at)
        VALUES (?, ?, ?, 'default', 0, 0, 1, ?, ?)`,
  args: [noteId, encryptString(dek, ""), encryptString(dek, ""), now, now],
});

// ---- 1. Nota vazia criada no cofre não gera versão ----
const inserted1 = await appendVersionIfChanged(db, {
  note_id: noteId,
  title: encryptString(dek, ""),
  body: encryptString(dek, ""),
  content_hash: EMPTY_CONTENT_HASH,
  created_at: now,
});
check("estado vazio no cofre NÃO vira versão", inserted1 === false);

// ---- 2. Ciphertext de vazio SEM hash também é barrado ----
// (ciphertext de "" = 16 bytes de tag; o servidor detecta sem decifrar)
const inserted2 = await appendVersionIfChanged(db, {
  note_id: noteId,
  title: encryptString(dek, ""),
  body: encryptString(dek, ""),
  created_at: now,
});
check("ciphertext de vazio (sem hash) também não vira versão", inserted2 === false);

// ---- 3. Primeiro conteúdo real gera exatamente uma versão ----
const v1 = await appendVersionIfChanged(db, {
  note_id: noteId,
  title: encryptString(dek, "Título"),
  body: encryptString(dek, "corpo"),
  content_hash: versionContentHash("Título", "corpo"),
  created_at: now,
});
check("primeira versão real é gravada", v1 === true);

// ---- 4. Mesmo conteúdo regravado (ciphertext novo = IV novo) não duplica ----
const v2 = await appendVersionIfChanged(db, {
  note_id: noteId,
  title: encryptString(dek, "Título"),
  body: encryptString(dek, "corpo"),
  content_hash: versionContentHash("Título", "corpo"),
  created_at: now + 1000,
});
check("mesmo conteúdo com ciphertext diferente NÃO duplica", v2 === false);

// ---- 5. Conteúdo diferente gera versão nova ----
const v3 = await appendVersionIfChanged(db, {
  note_id: noteId,
  title: encryptString(dek, "Título"),
  body: encryptString(dek, "corpo editado"),
  content_hash: versionContentHash("Título", "corpo editado"),
  created_at: now + 2000,
});
check("conteúdo diferente gera versão", v3 === true);

const total = await db.execute({
  sql: `SELECT COUNT(*) AS c FROM note_versions WHERE note_id = ?`,
  args: [noteId],
});
check("histórico tem exatamente 2 versões", Number(total.rows[0].c) === 2, total.rows[0]);

// ---- 6. Push de outra réplica: cofre NÃO cria snapshot de timeline ----
check("sync não cria snapshot para nota do cofre", shouldSnapshotInstance({ is_vault: 1 }) === false);
check("sync cria snapshot para nota normal", shouldSnapshotInstance({ is_vault: 0 }) === true);

// ---- 7. Pull: versão vazia vinda do remoto não entra no banco local ----
const pulledId = "note-pull-1";
await db.execute({
  sql: `INSERT INTO notes (id, title, body, color, is_pinned, is_archived, is_vault, created_at, updated_at)
        VALUES (?, ?, ?, 'default', 0, 0, 1, ?, ?)`,
  args: [pulledId, encryptString(dek, "a"), encryptString(dek, "b"), now, now],
});
await applyPull(db, {
  versions: [
    {
      id: "ver-vazia",
      note_id: pulledId,
      title: encryptString(dek, ""),
      body: encryptString(dek, ""),
      created_at: now,
    },
    {
      id: "ver-real",
      note_id: pulledId,
      title: encryptString(dek, "antigo"),
      body: encryptString(dek, "texto"),
      content_hash: versionContentHash("antigo", "texto"),
      created_at: now + 10,
    },
  ],
});
const pulled = await db.execute({
  sql: `SELECT id FROM note_versions WHERE note_id = ?`,
  args: [pulledId],
});
check(
  "pull descarta versão vazia e mantém a real",
  pulled.rows.length === 1 && String(pulled.rows[0].id) === "ver-real",
  pulled.rows
);

// ---- 8. Barreira de vazio reconhece os três formatos ----
check("isBlankVersion reconhece hash do vazio", isBlankVersion({ content_hash: EMPTY_CONTENT_HASH }));
check("isBlankVersion reconhece strings vazias", isBlankVersion({ title: "", body: "  " }));
check(
  "isBlankVersion reconhece ciphertext de vazio",
  isBlankVersion({
    title: encryptString(dek, ""),
    body: encryptString(dek, ""),
  })
);
check("isBlankVersion aceita conteúdo real", !isBlankVersion({ title: "a", body: "" }));

// ---- 9. applyPush (motor do servidor): cofre não gera snapshot vazio ----
// NOTES_DB_PATH evita que o import de lib/sync toque no Turso.
process.env.NOTES_DB_PATH = join(dir, "server-side.db");
const { applyPush } = await import("../lib/sync.js");

const pushNoteId = "note-sync-cofre";
await db.execute({
  sql: `INSERT INTO notes (id, title, body, color, is_pinned, is_archived, is_vault, created_at, updated_at)
        VALUES (?, ?, ?, 'default', 0, 0, 1, ?, ?)`,
  args: [pushNoteId, encryptString(dek, ""), encryptString(dek, ""), now, now],
});
await applyPush(db, {
  notes: [
    {
      id: pushNoteId,
      title: encryptString(dek, "novo"),
      body: encryptString(dek, "conteúdo novo"),
      color: "default",
      is_pinned: 0,
      is_archived: 0,
      is_vault: 1,
      created_at: now,
      updated_at: now + 5000,
    },
  ],
});
const syncVers = await db.execute({
  sql: `SELECT COUNT(*) AS c FROM note_versions WHERE note_id = ?`,
  args: [pushNoteId],
});
check(
  "applyPush NÃO cria versão para nota do cofre",
  Number(syncVers.rows[0].c) === 0,
  syncVers.rows[0]
);

const normalId = "note-normal-1";
await db.execute({
  sql: `INSERT INTO notes (id, title, body, color, is_pinned, is_archived, is_vault, created_at, updated_at)
        VALUES (?, 'antes', 'texto antigo', 'default', 0, 0, 0, ?, ?)`,
  args: [normalId, now, now],
});
await applyPush(db, {
  notes: [
    {
      id: normalId,
      title: "depois",
      body: "texto novo",
      color: "default",
      is_pinned: 0,
      is_archived: 0,
      is_vault: 0,
      created_at: now,
      updated_at: now + 6000,
    },
  ],
});
const normalVers = await db.execute({
  sql: `SELECT title, body FROM note_versions WHERE note_id = ?`,
  args: [normalId],
});
check(
  "applyPush guarda o estado anterior da nota normal",
  normalVers.rows.length === 1 &&
    String(normalVers.rows[0].title) === "antes" &&
    String(normalVers.rows[0].body) === "texto antigo",
  normalVers.rows
);

rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail === 0 ? 0 : 1);
