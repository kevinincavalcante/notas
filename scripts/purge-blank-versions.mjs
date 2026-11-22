import { createClient } from "@libsql/client";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

/**
 * Limpeza pontual do histórico: apaga as versões VAZIAS que os bugs anteriores
 * gravaram (notas novas do cofre e snapshots de estado vazio).
 *
 *   npm run db:purge-blank-versions              # só mostra quantas
 *   npm run db:purge-blank-versions -- --apply    # apaga de verdade
 */

function loadEnv() {
  const envPath = resolve(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    if (!process.env[key]) process.env[key] = val.replace(/^["']|["']$/g, "");
  }
}

loadEnv();

const url = process.env.TURSO_URL || process.env.TURSO_LINK;
const authToken = process.env.TURSO_TOKEN || process.env.TURSO_AUTH_TOKEN;
const apply = process.argv.includes("--apply");

if (!url || !authToken) {
  console.error("❌ TURSO_LINK / TURSO_URL ou TURSO_TOKEN não encontrados em .env.local!");
  process.exit(1);
}

const db = createClient({ url, authToken });

// Garante as colunas novas antes de filtrar por content_hash
const cols = await db.execute(`PRAGMA table_info(note_versions)`);
if (!cols.rows.some((r) => r.name === "content_hash")) {
  await db.execute(`ALTER TABLE note_versions ADD COLUMN content_hash TEXT DEFAULT NULL`);
  console.log("✅ Coluna 'content_hash' criada.");
}
if (!cols.rows.some((r) => r.name === "is_instance_snapshot")) {
  await db.execute(
    `ALTER TABLE note_versions ADD COLUMN is_instance_snapshot INTEGER NOT NULL DEFAULT 0`
  );
  console.log("✅ Coluna 'is_instance_snapshot' criada.");
}

const countRes = await db.execute({
  sql: `
    SELECT COUNT(*) AS n FROM note_versions
    WHERE COALESCE(TRIM(title), '') = ''
      AND COALESCE(TRIM(body), '') = ''
  `,
  args: [],
});
const total = Number(countRes.rows[0]?.n ?? 0);

console.log(`Versões vazias no histórico: ${total}`);

// Notas do cofre realmente vazias: título e corpo são ciphertext de "" (só a
// tag de 16 bytes) e não há anexo. São as "notas novas" abandonadas.
const emptyNotes = await db.execute({
  sql: `
    SELECT n.id, n.created_at
    FROM notes n
    WHERE n.is_vault = 1
      AND (SELECT COUNT(*) FROM attachments a WHERE a.note_id = n.id) = 0
      AND n.title LIKE 'enc1:%'
      AND n.body LIKE 'enc1:%'
  `,
  args: [],
});
const emptyList = emptyNotes.rows.filter((r) => {
  const ctLen = (value) => {
    const parts = String(value).slice(5).split(":");
    if (parts.length !== 2) return -1;
    const b64 = parts[1].replace(/=+$/, "");
    return Math.floor((b64.length * 3) / 4);
  };
  return ctLen(r.title) === 16 && ctLen(r.body) === 16;
});

console.log(`Notas vazias no cofre: ${emptyList.length}`);
for (const row of emptyList) {
  console.log(`  • ${row.id} (${new Date(Number(row.created_at)).toLocaleString()})`);
}

if (!apply) {
  console.log("\nDry-run. Rode com --apply para apagar versões vazias e notas vazias.");
  process.exit(0);
}

const res = await db.execute({
  sql: `
    DELETE FROM note_versions
    WHERE COALESCE(TRIM(title), '') = ''
      AND COALESCE(TRIM(body), '') = ''
      AND content_hash IS NULL
  `,
  args: [],
});
console.log(`🗑  ${res.rowsAffected} versão(ões) vazia(s) removida(s).`);

let removedNotes = 0;
for (const row of emptyList) {
  const id = String(row.id);
  await db.execute({ sql: `DELETE FROM note_versions WHERE note_id = ?`, args: [id] });
  await db.execute({ sql: `DELETE FROM note_tags WHERE note_id = ?`, args: [id] });
  const del = await db.execute({ sql: `DELETE FROM notes WHERE id = ?`, args: [id] });
  removedNotes += del.rowsAffected;
  // Tombstone: sem ele outra réplica (celular/desktop) ressuscitaria a nota
  await db.execute({
    sql: `INSERT INTO tombstones (id, entity, deleted_at) VALUES (?, 'note', ?)
          ON CONFLICT(id) DO UPDATE SET deleted_at = MAX(deleted_at, excluded.deleted_at)`,
    args: [id, Date.now()],
  });
  await db.execute({
    sql: `INSERT INTO change_log (entity, entity_id, op, at) VALUES ('tombstone', ?, 'delete', ?)`,
    args: [id, Date.now()],
  });
}
console.log(`🗑  ${removedNotes} nota(s) vazia(s) removida(s) do cofre.`);
