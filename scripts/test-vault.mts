/**
 * Teste E2E do COFRE (modelo B — criptografia 100% no cliente).
 * Valida:
 *   1. Gravação/leitura de vault_meta (material embrulhado)
 *   2. Rejeição de senha errada
 *   3. Criação de nota cifrada (o banco nunca vê o texto original)
 *   4. FTS5 propositalmente NÃO indexa notas do cofre
 *   5. Versões salvas já cifradas
 *   6. Troca de senha re-embrulha a mesma DEK (sem re-cifrar nada)
 *   7. Transição: tira do cofre → descriptografa campos
 *
 * Uso: npx tsx scripts/test-vault.mts (precisa do next start :3000)
 */

import { SignJWT } from "jose";
import { readFileSync } from "fs";
import { resolve } from "path";
import { createClient } from "@libsql/client";
import {
  createVaultMaterial,
  openVaultMaterial,
  rewrapDek,
  encryptString,
  decryptString,
} from "../lib/vault-crypto";

for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf-8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  if (i !== -1 && !process.env[t.slice(0, i)]) process.env[t.slice(0, i)] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

const BASE = "http://127.0.0.1:3000";
const secret = new TextEncoder().encode(process.env.JWT_SECRET!.trim());
const token = await new SignJWT({ username: process.env.APP_USER })
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setExpirationTime("1h")
  .sign(secret);
const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

let ok = 0;
let fail = 0;
const noteIds: string[] = [];

function check(name: string, cond: boolean) {
  if (cond) { ok++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}`); }
}

const db = createClient({
  url: process.env.TURSO_URL || process.env.TURSO_LINK,
  authToken: process.env.TURSO_TOKEN || process.env.TURSO_AUTH_TOKEN,
});

// Preserva o material original do cofre do usuário para não destruí-lo no teste
const existingMetaRes = await db.execute({ sql: "SELECT * FROM vault_meta WHERE id = 'default'", args: [] }).catch(() => ({ rows: [] }));
const prevMeta = existingMetaRes.rows[0];

async function cleanup() {
  for (const id of noteIds) {
    await fetch(`${BASE}/api/notes/${id}`, { method: "DELETE", headers: H }).catch(() => {});
  }
}

try {
  // ---- 1. Material do cofre: PUT + GET -------------------------------------
  const pw = "teste-cofre-123";
  const material = createVaultMaterial(pw);
  const putRes = await fetch(`${BASE}/api/vault`, {
    method: "PUT",
    headers: H,
    body: JSON.stringify({ ...material, updated_at: Date.now(), dek: undefined }),
  });
  check("PUT /api/vault salva material", putRes.ok);

  const getRes = await fetch(`${BASE}/api/vault`, { headers: H });
  const meta = (await getRes.json()).vault_meta;
  check("GET /api/vault devolve salt + wrapped_dek", Boolean(meta?.salt && meta?.wrapped_dek));

  // ---- 2. Destravar com a senha certa / errada -----------------------------
  const opened = openVaultMaterial(pw, meta);
  check("senha certa abre o cofre (recupera a DEK)", Boolean(opened?.dek));
  const bad = openVaultMaterial("senha-errada", meta);
  check("senha errada rejeita (retorna null)", bad === null);

  const dek = opened!.dek;

  // ---- 3. Cria nota cifrada: o banco guarda TEXT puro com enc1:... --------
  const plainTitle = "Minha senha do banco secreto";
  const plainBody = "Conta 1234-5 / Agência 0001 — Token X9Z";
  const createRes = await fetch(`${BASE}/api/notes`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      title: encryptString(dek, plainTitle),
      body: encryptString(dek, plainBody),
      color: "default",
      is_vault: true,
    }),
  });
  check("POST /api/notes com is_vault=true", createRes.ok);
  const created = (await createRes.json()).note;
  noteIds.push(created.id);

  // Lê direto do SQLite: confirma que NADA do texto original está no banco
  const dbRow = await db.execute({
    sql: `SELECT title, body, is_vault FROM notes WHERE id = ?`,
    args: [created.id],
  });
  const row = dbRow.rows[0];
  check("banco tem ciphertext no title", String(row.title).startsWith("enc1:"));
  check("banco tem ciphertext no body", String(row.body).startsWith("enc1:"));
  check("texto original NÃO aparece no banco", !String(row.body).includes("Token X9Z"));
  check("is_vault = 1 no banco", Number(row.is_vault) === 1);

  // ---- 4. FTS5 não indexa notas do cofre -----------------------------------
  const ftsRow = await db.execute({
    sql: `SELECT * FROM notes_fts WHERE notes_fts MATCH 'secreto'`,
  });
  check("FTS5 não indexa notas do cofre", ftsRow.rows.length === 0);

  // Busca da API exclui o cofre
  const searchRes = await fetch(`${BASE}/api/notes/search?q=secreto`, { headers: H });
  const searchResults = (await searchRes.json()).notes as { id: string }[];
  check("GET /api/notes/search exclui notas do cofre", !searchResults.some((n) => n.id === created.id));

  // ---- 5. Versões são gravadas cifradas ------------------------------------
  await fetch(`${BASE}/api/notes/${created.id}`, {
    method: "PATCH",
    headers: H,
    body: JSON.stringify({
      body: encryptString(dek, plainBody + " (v2 editada)"),
    }),
  });
  const versionsRes = await fetch(`${BASE}/api/notes/${created.id}/versions`, { headers: H });
  const versions = (await versionsRes.json()).versions as { title: string; body: string }[];
  check("versão criada", versions.length > 0);
  check("versão guardada é ciphertext", String(versions[0]?.body).startsWith("enc1:"));

  // ---- 6. Troca de senha: a MESMA DEK continua válida ----------------------
  const newPw = "nova-senha-456";
  const rewrapped = rewrapDek(dek, newPw);
  const rewrapRes = await fetch(`${BASE}/api/vault`, {
    method: "PUT",
    headers: H,
    body: JSON.stringify({ ...rewrapped, kdf: "PBKDF2-SHA256", updated_at: Date.now() }),
  });
  check("PUT com senha trocada aceito", rewrapRes.ok);

  const getRes2 = await fetch(`${BASE}/api/vault`, { headers: H });
  const meta2 = (await getRes2.json()).vault_meta;
  const openedNew = openVaultMaterial(newPw, meta2);
  check("nova senha abre o cofre", Boolean(openedNew?.dek));
  const openedOld = openVaultMaterial(pw, meta2);
  check("senha antiga agora é rejeitada", openedOld === null);

  // A DEK recuperada com a nova senha AINDA decifra a nota antiga!
  const decryptedBody = decryptString(openedNew!.dek, String(row.body));
  check("mesma DEK descriptografa nota criada com a senha anterior", decryptedBody === plainBody);

  // ---- 7. Transição: tirar do cofre descriptografa campos -------------------
  const leaveRes = await fetch(`${BASE}/api/notes/${created.id}`, {
    method: "PATCH",
    headers: H,
    body: JSON.stringify({
      title: plainTitle,
      body: plainBody,
      is_vault: false,
    }),
  });
  check("PATCH is_vault=0 aceito", leaveRes.ok);
  const listRes2 = await fetch(`${BASE}/api/notes`, { headers: H });
  const all2 = (await listRes2.json()).notes as { id: string }[];
  check("nota volta pra listagem normal", all2.some((n) => n.id === created.id));

  // ---- 8. reencrypt endpoint ------------------------------------------------
  const reencRes = await fetch(`${BASE}/api/notes/${created.id}/versions/reencrypt`, {
    method: "POST", headers: H,
    body: JSON.stringify({ versions: versions.map((v, i) => ({ id: "nada-" + i, title: "x", body: "y" })) }),
  });
  check("reencrypt endpoint responde", reencRes.ok);
} catch (err) {
  console.error("💥 erro:", err);
  fail++;
} finally {
  await cleanup();
  // Restaura o cofre original se existia
  if (prevMeta) {
    await db.execute({
      sql: `INSERT OR REPLACE INTO vault_meta (id, salt, iterations, kdf, wrapped_dek, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [prevMeta.id, prevMeta.salt, prevMeta.iterations, prevMeta.kdf, prevMeta.wrapped_dek, prevMeta.updated_at],
    }).catch(() => {});
  }
}

console.log(`\nResultado: ${ok} ok / ${fail} falha`);
process.exit(fail > 0 ? 1 : 0);
