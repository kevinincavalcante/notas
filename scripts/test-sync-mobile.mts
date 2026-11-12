/**
 * Teste ponta a ponta do sync MOBILE: uma réplica expo-sqlite (adaptador
 * mobile/src/lib/sqlite-client.ts + shim de node:sqlite) sincronizando com
 * o servidor via POST /api/sync + Bearer JWT — exatamente o fluxo do app
 * Android, incluindo login e rotas CRUD da API.
 *
 * Cria notas de teste próprias e limpa no final (tombstones). Nada seu é tocado.
 *
 * Uso: npm run test:sync:mobile  (precisa do `npm run dev` de pé na 3000)
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

const BASE = process.env.MOBILE_SYNC_TEST_URL || "http://localhost:3000";

// Servidor de pé?
const ping = await fetch(`${BASE}/api/health`, { method: "GET" }).catch(() => null);
if (!ping) {
  console.error(`\n❌ Servidor não responde em ${BASE}. Suba o npm run dev antes.\n`);
  process.exit(1);
}
await ping.body?.cancel().catch(() => {});

const { createToken } = await import("../lib/jwt.js");
const { createClient } = await import("@libsql/client");
const { DatabaseSync } = await import("node:sqlite");
const { ensureSchema } = await import("../lib/db-schema.js");
const { logChange } = await import("../lib/sync-log.js");
const { createExpoClient } = await import("../mobile/src/lib/sqlite-client.js");
const { syncOnceHttp } = await import("../mobile/src/lib/sync.js");

const token = await createToken({ username: process.env.APP_USER || "sync-test" });
const auth = { Authorization: `Bearer ${token}` };

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...auth, ...(init?.headers || {}) },
  });
  return res;
}

// Réplica "expo-sqlite": shim de node:sqlite com a MESMA API do expo-sqlite
class ExpoSqliteShim {
  private db: InstanceType<typeof DatabaseSync>;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON");
  }
  async execAsync(sql: string) {
    this.db.exec(sql);
  }
  async runAsync(sql: string, ...params: unknown[]) {
    const info = this.db.prepare(sql).run(...(params as never[]));
    return { changes: Number(info.changes), lastInsertRowid: Number(info.lastInsertRowid) };
  }
  async getAllAsync(sql: string, ...params: unknown[]) {
    return this.db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
  }
}

// Remoto (só pra VERIFICAR o resultado — o app nunca fala com o Turso direto)
const remote = createClient({
  url: process.env.TURSO_URL || process.env.TURSO_LINK,
  authToken: process.env.TURSO_TOKEN,
});

// Réplica local em arquivo descartável
const dir = join(tmpdir(), `sync-mobile-test-${randomUUID()}`);
mkdirSync(dir, { recursive: true });
const localPath = join(dir, "notas.db");
const sqlite = new ExpoSqliteShim(localPath);
const local = createExpoClient(sqlite);
await ensureSchema(local);
console.log(`Réplica mobile: ${localPath}\n`);

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

try {
  // ---- 1. Bootstrap via API: primeira sync puxa tudo por HTTP + Bearer ----
  const boot = await syncOnceHttp(local, { baseUrl: BASE, token });
  const localCount = await local.execute(`SELECT COUNT(*) AS c FROM notes`);
  check("bootstrap via POST /api/sync (Bearer) puxa as notas", Number(localCount.rows[0].c) > 0, {
    local: Number(localCount.rows[0].c),
  });
  const metaCursor = await local.execute(`SELECT value FROM sync_meta WHERE key = 'sync_cursor'`);
  check("cursor salvo na réplica mobile", Number(metaCursor.rows[0]?.value) > 0);
  const logAfterBoot = await local.execute(`SELECT COUNT(*) AS c FROM change_log`);
  check("pull não polui o change_log local", Number(logAfterBoot.rows[0].c) === 0);

  // ---- 2. Escrita local → push via API → chega no Turso ----
  const localNoteId = randomUUID();
  const now = Date.now();
  await local.execute({
    sql: `INSERT INTO notes (id, title, body, color, is_pinned, is_archived, created_at, updated_at)
          VALUES (?, ?, ?, 'default', 0, 0, ?, ?)`,
    args: [localNoteId, "MOBILE TEST local", "criada no celular", now, now],
  });
  await logChange("note", localNoteId, "upsert", local);

  const s2 = await syncOnceHttp(local, { baseUrl: BASE, token });
  check("push local→remoto reporta 1 nota", s2.pushedNotes === 1, { pushed: s2.pushedNotes });
  const remota = await remote.execute({
    sql: `SELECT title, body FROM notes WHERE id = ?`,
    args: [localNoteId],
  });
  check("nota local chegou no remoto", remota.rows.length === 1 && remota.rows[0].title === "MOBILE TEST local");

  // ---- 3. Nota criada na API (route + change_log) → puxada pelo celular ----
  const resPost = await api("/api/notes", {
    method: "POST",
    body: JSON.stringify({ title: "MOBILE TEST remote", body: "criada na API pro celular" }),
  });
  const postData = (await resPost.json()) as { note?: { id?: string } };
  const remoteNoteId = postData.note?.id;
  check("POST /api/notes com Bearer cria nota", resPost.ok && Boolean(remoteNoteId), {
    status: resPost.status,
  });

  const s3 = await syncOnceHttp(local, { baseUrl: BASE, token });
  const puxada = await local.execute({
    sql: `SELECT title FROM notes WHERE id = ?`,
    args: [remoteNoteId as string],
  });
  check("nota da API chegou no celular", puxada.rows.length === 1 && puxada.rows[0].title === "MOBILE TEST remote");
  void s3;

  // ---- 4. Edição na API (LWW) → celular atualiza ----
  await api(`/api/notes/${remoteNoteId}`, {
    method: "PATCH",
    body: JSON.stringify({ body: "editada na API" }),
  });
  await syncOnceHttp(local, { baseUrl: BASE, token });
  const editada = await local.execute({
    sql: `SELECT body FROM notes WHERE id = ?`,
    args: [remoteNoteId as string],
  });
  check("edição remota atualizou o celular (LWW)", editada.rows[0]?.body === "editada na API", {
    body: editada.rows[0]?.body,
  });

  // ---- 5. Exclusão na API → tombstone chega e apaga local ----
  await api(`/api/notes/${remoteNoteId}`, { method: "DELETE" });
  const s5 = await syncOnceHttp(local, { baseUrl: BASE, token });
  const aposDelete = await local.execute({
    sql: `SELECT 1 AS x FROM notes WHERE id = ?`,
    args: [remoteNoteId as string],
  });
  check("exclusão remota apagou a nota no celular", aposDelete.rows.length === 0);
  check("túmulo contabilizado no pull", s5.appliedTombstones >= 1, { applied: s5.appliedTombstones });

  // ---- 6. Exclusão local → tombstone chega no remoto ----
  await local.execute({
    sql: `INSERT INTO tombstones (id, entity, deleted_at) VALUES (?, 'note', ?)`,
    args: [localNoteId, Date.now()],
  });
  await logChange("tombstone", localNoteId, "delete", local);
  await syncOnceHttp(local, { baseUrl: BASE, token });
  const remotaAposTombo = await remote.execute({
    sql: `SELECT 1 AS x FROM notes WHERE id = ?`,
    args: [localNoteId],
  });
  check("exclusão local apagou a nota no remoto", remotaAposTombo.rows.length === 0);

  // ---- 7. Re-sync idempotente: nada a fazer ----
  const s7 = await syncOnceHttp(local, { baseUrl: BASE, token });
  check(
    "re-sync sem mudanças é vazia",
    s7.pushedNotes === 0 && s7.pulledNotes === 0 && s7.pulledVersions === 0 && s7.appliedTombstones === 0,
    { s7 }
  );
} finally {
  // Limpeza: tombstone local se sobrou algo
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}

console.log(`\nResultado: ${pass} ok / ${fail} falha\n`);
if (fail > 0) process.exit(1);
