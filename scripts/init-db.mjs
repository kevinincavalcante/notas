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

async function main() {
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
        box_file_id TEXT NOT NULL,
        file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        duration_seconds REAL DEFAULT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
      );
    `);

    console.log("Criando índice para 'attachments'...");
    await db.execute(`
      CREATE INDEX IF NOT EXISTS idx_attachments_note_id ON attachments(note_id);
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

    console.log("✅ Migração executada com sucesso! Testando consulta...");
    const testResult = await db.execute("SELECT count(*) as total FROM notes");
    console.log(`Total de notas existentes: ${testResult.rows[0].total}`);
    console.log("🎉 Conexão e tabelas no Turso 100% operacionais!");
  } catch (err) {
    console.error("❌ Erro ao inicializar banco de dados:", err);
    process.exit(1);
  }
}

main();
