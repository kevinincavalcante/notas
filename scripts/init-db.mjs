import { createClient } from "@libsql/client";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

// Load .env.local manually if running via node script
function loadEnv() {
  const envPath = resolve(process.cwd(), ".env.local");
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx !== -1) {
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim();
        if (!process.env[key]) {
          process.env[key] = val.replace(/^["']|["']$/g, "");
        }
      }
    }
  }
}

loadEnv();

const url = process.env.TURSO_URL || process.env.TURSO_LINK;
const authToken = process.env.TURSO_TOKEN || process.env.TURSO_AUTH_TOKEN;

if (!url || !authToken) {
  console.error("❌ TURSO_LINK / TURSO_URL ou TURSO_TOKEN não foram encontrados em .env.local!");
  process.exit(1);
}

console.log(`Conectando ao Turso em: ${url}...`);

const db = createClient({
  url,
  authToken,
});

const rebuildFts = process.argv.includes("--rebuild-fts");

/**
 * Reconstrói o índice FTS5 a partir da tabela de conteúdo.
 * Uso: npm run db:rebuild
 * Necessário se a busca começar a retornar vazio silenciosamente
 * (sinais de dessincronização entre notes e notes_fts).
 */
async function rebuildFtsIndex() {
  console.log("Verificando consistência notes vs notes_fts...");
  const drift = await db.execute(`
    SELECT (SELECT COUNT(*) FROM notes) AS notes_count,
           (SELECT COUNT(*) FROM notes_fts) AS fts_count
  `);
  const notesCount = Number(drift.rows[0].notes_count);
  const ftsCount = Number(drift.rows[0].fts_count);
  console.log(`Notas: ${notesCount} | Entradas no índice FTS: ${ftsCount}`);

  console.log("Reconstruindo índice FTS5 (INSERT INTO notes_fts(notes_fts) VALUES('rebuild'))...");
  await db.execute(`INSERT INTO notes_fts(notes_fts) VALUES('rebuild')`);

  const after = await db.execute(`SELECT COUNT(*) AS total FROM notes_fts`);
  console.log(`✅ Índice reconstruído. Entradas após rebuild: ${Number(after.rows[0].total)}`);
  console.log("🔍 Teste rápido de busca ('teste')...");
  const probe = await db.execute(`SELECT COUNT(*) AS total FROM notes_fts WHERE notes_fts MATCH 'teste'`);
  console.log(`Resultados para 'teste': ${Number(probe.rows[0].total)}`);
}

async function main() {
  if (rebuildFts) {
    try {
      await rebuildFtsIndex();
      process.exit(0);
    } catch (err) {
      console.error("❌ Erro ao reconstruir índice FTS5:", err);
      process.exit(1);
    }
  }

  try {
    console.log("Criando tabela 'notes'...");
    await db.execute(`
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        color TEXT NOT NULL DEFAULT 'default',
        is_pinned INTEGER NOT NULL DEFAULT 0,
        is_archived INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    console.log("Criando índices para 'notes'...");
    await db.execute(`
      CREATE INDEX IF NOT EXISTS idx_notes_pinned_archived ON notes(is_pinned, is_archived, updated_at DESC);
    `);

    console.log("Criando tabela 'attachments'...");
    await db.execute(`
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        note_id TEXT NOT NULL,
        storage_key TEXT NOT NULL,
        file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        duration_seconds REAL DEFAULT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
      );
    `);

    // Migração idempotente: renomeia a coluna legada do antigo driver Box
    console.log("Verificando migração box_file_id -> storage_key...");
    const attachmentCols = await db.execute(`PRAGMA table_info(attachments)`);
    const hasLegacyColumn = attachmentCols.rows.some((row) => row.name === "box_file_id");
    if (hasLegacyColumn) {
      await db.execute(`ALTER TABLE attachments RENAME COLUMN box_file_id TO storage_key`);
      console.log("✅ Coluna renomeada: box_file_id -> storage_key");
    } else {
      console.log("Nada a migrar (coluna já atualizada).");
    }

    console.log("Criando índice para 'attachments'...");
    await db.execute(`
      CREATE INDEX IF NOT EXISTS idx_attachments_note_id ON attachments(note_id);
    `);

    console.log("Criando tabela 'note_versions' para histórico...");
    await db.execute(`
      CREATE TABLE IF NOT EXISTS note_versions (
        id TEXT PRIMARY KEY,
        note_id TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
      );
    `);

    console.log("Criando índice para 'note_versions'...");
    await db.execute(`
      CREATE INDEX IF NOT EXISTS idx_note_versions_note_id ON note_versions(note_id, created_at DESC);
    `);

    console.log("Criando tabela virtual FTS5 'notes_fts'...");
    await db.execute(`
      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
        title,
        body,
        content='notes',
        content_rowid='rowid'
      );
    `);

    console.log("Criando triggers de sincronização FTS5...");
    await db.execute(`
      CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
        INSERT INTO notes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
      END;
    `);

    await db.execute(`
      CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES('delete', old.rowid, old.title, old.body);
      END;
    `);

    await db.execute(`
      CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES('delete', old.rowid, old.title, old.body);
        INSERT INTO notes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
      END;
    `);

    console.log("✅ Migração executada com sucesso!");
    const testResult = await db.execute("SELECT count(*) as total FROM notes");
    console.log(`Total de notas existentes: ${testResult.rows[0].total}`);
    console.log("🎉 Conexão e tabelas no Turso 100% operacionais!");
  } catch (err) {
    console.error("❌ Erro ao inicializar banco de dados:", err);
    process.exit(1);
  }
}

main();
