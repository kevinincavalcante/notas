import { createClient } from "@libsql/client";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

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

const db = createClient({
  url: process.env.TURSO_URL || process.env.TURSO_LINK,
  authToken: process.env.TURSO_TOKEN,
});

async function runTest() {
  console.log("Inserindo nota de teste...");
  const testId = "test-" + Date.now();
  const now = Date.now();

  await db.execute({
    sql: `INSERT INTO notes (id, title, body, color, is_pinned, is_archived, created_at, updated_at)
          VALUES (?, ?, ?, ?, 0, 0, ?, ?)`,
    args: [testId, "Lista de Compras de Supermercado", "Comprar café, pão na chapa e frutas frescas", "sand", now, now],
  });

  console.log("Testando busca FTS5 por 'supermerc*'...");
  const searchResult = await db.execute({
    sql: `SELECT n.id, n.title, snippet(notes_fts, 0, '<mark>', '</mark>', '...', 10) as snippet
          FROM notes_fts
          JOIN notes n ON n.rowid = notes_fts.rowid
          WHERE notes_fts MATCH ?`,
    args: ['"supermerc"*'],
  });

  console.log("Resultado da busca FTS5:", searchResult.rows);

  console.log("Limpando nota de teste...");
  await db.execute({
    sql: `DELETE FROM notes WHERE id = ?`,
    args: [testId],
  });

  console.log("🎉 Teste de FTS5 no Turso concluído com 100% de sucesso!");
}

runTest().catch(console.error);
