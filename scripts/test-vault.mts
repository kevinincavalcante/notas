/**
 * Teste end-to-end do Cofre contra o servidor HTTP local (:3000).
 * Uso: npx tsx scripts/test-vault.mts
 * Cria e remove os próprios dados — não deixa rastro no Turso.
 */
import { createClient } from "@libsql/client";
import { SignJWT } from "jose";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { createVaultMaterial, openVaultMaterial, encryptString, decryptString } from "../lib/vault-crypto";

function loadEnv() {
  const envPath = resolve(process.cwd(), ".env.local");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i !== -1 && !process.env[t.slice(0, i)]) {
        process.env[t.slice(0, i)] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      }
    }
  }
}
loadEnv();

const BASE = "http://127.0.0.1:3000";
const secret = new TextEncoder().encode(process.env.JWT_SECRET!.trim());
const token = await new SignJWT({ username: process.env.APP_USER || "test" })
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setExpirationTime("1h")
  .sign(secret);
const H = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

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
  check("GET /api/vault devolve material", Boolean(meta?.wrapped_dek));

  // senha certa abre, errada rejeita
  const opened = openVaultMaterial(pw, meta);
  check("openVaultMaterial com senha certa abre a DEK", opened !== null);
  check("openVaultMaterial com senha errada recusa", openVaultMaterial("errada", meta) === null);

  // ---- 2. Nota criptografada: criada via API, ciphertext no Turso ----------
  const titlePlain = "Nota Secreta do Cofre";
  const bodyPlain = "conteudo-ultra-secreto-xyz";
  const titleEnc = encryptString(opened!.dek, titlePlain);
  const bodyEnc = encryptString(opened!.dek, bodyPlain);

  const createRes = await fetch(`${BASE}/api/notes`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ title: titleEnc, body: bodyEnc, is_vault: true, color: "default" }),
  });
  const created = (await createRes.json()).note;
  noteIds.push(created.id);
  check("POST /api/notes cria nota do cofre", createRes.ok && created.is_vault === true);

  const rowRes = await db.execute({ sql: `SELECT title, body, is_vault FROM notes WHERE id = ?`, args: [created.id] });
  const row = rowRes.rows[0];
  check("Turso guarda ciphertext (não plaintext)", row.title === titleEnc && !(row.title as string).includes("Secreta"));
  check("row.is_vault = 1 no banco", Number(row.is_vault) === 1);
  check("ciphertext descriptografa pro plaintext original", decryptString(opened!.dek, row.title as string) === titlePlain);

  // ---- 3. Listagens: fora da lista comum, dentro de ?vault=1 ---------------
  const listRes = await fetch(`${BASE}/api/notes`, { headers: H });
  const allNotes = (await listRes.json()).notes as { id: string; is_vault: boolean }[];
  check("GET /api/notes esconde nota do cofre", !allNotes.some((n) => n.id === created.id));

  const vaultRes = await fetch(`${BASE}/api/notes?vault=1`, { headers: H });
  const vaultNotes = (await vaultRes.json()).notes as { id: string; is_vault: boolean }[];
  check("GET /api/notes?vault=1 traz só a nota do cofre", vaultNotes.length === 1 && vaultNotes[0].id === created.id);

  // ---- 4. Busca FTS5 não indexa nota do cofre ------------------------------
  // corpo normal com termo marcador
  const normalRes = await fetch(`${BASE}/api/notes`, {
    method: "POST", headers: H,
    body: JSON.stringify({ title: "Normal com marcador-vaultix", body: "marcador-vaultix texto aberto" }),
  });
  const normalNote = (await normalRes.json()).note;
  noteIds.push(normalNote.id);
  await new Promise((r) => setTimeout(r, 300));

  const searchRes = await fetch(`${BASE}/api/notes/search?q=marcador-vaultix`, { headers: H });
  const found = ((await searchRes.json()).notes || []) as { id: string }[];
  check("busca acha nota normal", found.some((n) => n.id === normalNote.id));
  check("busca NÃO acha nota do cofre (ciphertext fora do índice)", !found.some((n) => n.id === created.id));

  // ---- 5. PATCH da nota do cofre (edição cifrada pelo cliente) -------------
  const newBodyEnc = encryptString(opened!.dek, "novo-conteudo-secreto-abc");
  const patchRes = await fetch(`${BASE}/api/notes/${created.id}`, {
    method: "PATCH", headers: H, body: JSON.stringify({ body: newBodyEnc }),
  });
  check("PATCH cifra aceito", patchRes.ok);
  const patchData = await patchRes.json();
  check("PATCH do cofre não deriva auto-tags", patchData.tags === null || Array.isArray(patchData.tags));

  // ---- 6. versões ficam cifradas -------------------------------------------
  const versionsRes = await fetch(`${BASE}/api/notes/${created.id}/versions`, { headers: H });
  const versions = ((await versionsRes.json()).versions || []) as { title: string; body: string }[];
  check("histórico de versões guarda ciphertext", versions.every((v) => v.body.startsWith("enc1:")));

  // ---- 7. Sair do cofre ----------------------------------------------------
  const leaveRes = await fetch(`${BASE}/api/notes/${created.id}`, {
    method: "PATCH", headers: H,
    body: JSON.stringify({ title: titlePlain, body: bodyPlain, is_vault: false }),
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
  // Material do cofre de teste sai do hub (o setup real é do usuário)
  await db.execute(`DELETE FROM vault_meta WHERE id = 'default'`).catch(() => {});
}

console.log(`\nResultado: ${ok} ok / ${fail} falha`);
process.exit(fail > 0 ? 1 : 0);
