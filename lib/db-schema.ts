import type { Client } from "@libsql/client";

/**
 * Schema completo de uma réplica local (desktop/SQLite em arquivo).
 * Espelha o schema de scripts/init-db.mjs — ao alterar lá, alterar aqui
 * (e vice-versa). Idempotente: CREATE IF NOT EXISTS em tudo.
 *
 * Extras da réplica local: `sync_meta` guarda cursores do sync
 * (sync_cursor = último seq aplicado do remoto; sync_pushed_seq = último
 * seq local já enviado).
 */
export const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT 'default',
    is_pinned INTEGER NOT NULL DEFAULT 0,
    is_archived INTEGER NOT NULL DEFAULT 0,
    is_vault INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_notes_pinned_archived ON notes(is_pinned, is_archived, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    duration_seconds REAL DEFAULT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_attachments_note_id ON attachments(note_id)`,
  `CREATE TABLE IF NOT EXISTS note_versions (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_note_versions_note_id ON note_versions(note_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL DEFAULT 'user',
    source TEXT NOT NULL DEFAULT 'file',
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS note_tags (
    note_id TEXT NOT NULL,
    tag_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (note_id, tag_id),
    FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_note_tags_tag_id ON note_tags(tag_id)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    title,
    body,
    content='notes',
    content_rowid='rowid'
  )`,
  `CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
  END`,
  `CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES('delete', old.rowid, old.title, old.body);
  END`,
  `CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES('delete', old.rowid, old.title, old.body);
    INSERT INTO notes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
  END`,
  `CREATE TABLE IF NOT EXISTS change_log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    entity TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    op TEXT NOT NULL,
    at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS tombstones (
    id TEXT PRIMARY KEY,
    entity TEXT NOT NULL DEFAULT 'note',
    deleted_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sync_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS vault_meta (
    id TEXT PRIMARY KEY,
    salt TEXT NOT NULL,
    iterations INTEGER NOT NULL,
    kdf TEXT NOT NULL DEFAULT 'PBKDF2-SHA256',
    wrapped_dek TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
];

/**
 * Triggers FTS5 com exclusão do cofre: notas is_vault=1 ficam FORA do índice
 * (o corpo delas é ciphertext — indexar seria lixo inútil e a busca do cofre
 * é client-side em memória).
 *
 * IMPORTANTE: o 'delete' do FTS5 external-content ERRA ("database disk image
 * is malformed") se a linha nunca foi indexada. Por isso o delete do estado
 * antigo só roda quando old.is_vault = 0 (ou seja, a linha ESTAVA indexada):
 *   normal→normal: delete + insert          normal→cofre: delete, sem insert
 *   cofre→cofre: nada                       cofre→normal: só insert
 */
export const FTS_TRIGGER_STATEMENTS: string[] = [
  `CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes
    WHEN new.is_vault = 0 BEGIN
    INSERT INTO notes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
  END`,
  `CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, body)
      SELECT 'delete', old.rowid, old.title, old.body WHERE old.is_vault = 0;
  END`,
  `CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, body)
      SELECT 'delete', old.rowid, old.title, old.body WHERE old.is_vault = 0;
    INSERT INTO notes_fts(rowid, title, body)
      SELECT new.rowid, new.title, new.body WHERE new.is_vault = 0;
  END`,
];

/** Aplica o schema idempotente numa réplica local. */
export async function ensureSchema(client: Client): Promise<void> {
  for (const statement of SCHEMA_STATEMENTS) {
    await client.execute(statement);
  }
  await migrateVaultColumns(client);
  await refreshFtsTriggers(client);
}

/**
 * Migrações idempotentes que o CREATE IF NOT EXISTS não cobre:
 *  - coluna is_vault em bancos antigos (ALTER TABLE é one-shot);
 *  - triggers FTS5 recriadas com o filtro do cofre (triggers antigos não
 *    mudam com CREATE IF NOT EXISTS).
 */
export async function migrateVaultColumns(client: Client): Promise<void> {
  const cols = await client.execute({ sql: `PRAGMA table_info(notes)`, args: [] });
  const hasVault = cols.rows.some((r) => r.name === "is_vault");
  if (!hasVault) {
    await client.execute(`ALTER TABLE notes ADD COLUMN is_vault INTEGER NOT NULL DEFAULT 0`);
  }
}

export async function refreshFtsTriggers(client: Client): Promise<void> {
  // Trigger antigo (sem filtro de cofre)? Se existir, o índice pode ter
  // entradas inconsistentes → reconstrói depois de recriar os triggers.
  const oldTrigger = await client.execute({
    sql: `SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'notes_ai'`,
    args: [],
  });
  const needsRebuild = !String(oldTrigger.rows[0]?.sql || "").includes("is_vault");

  for (const name of ["notes_ai", "notes_au", "notes_ad"]) {
    await client.execute(`DROP TRIGGER IF EXISTS ${name}`);
  }
  for (const statement of FTS_TRIGGER_STATEMENTS) {
    await client.execute(statement);
  }
  if (needsRebuild) {
    await client.execute(`INSERT INTO notes_fts(notes_fts) VALUES('rebuild')`);
  }
}
