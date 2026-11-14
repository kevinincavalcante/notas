/**
 * E2E do fluxo de IMAGEM no cofre: cria cofre + nota cifrada, sobe imagem
 * cifrada (como o cliente faz), baixa e descriptografa — os bytes têm que
 * bater com a imagem original (valid WebP).
 * Uso: npx tsx scripts/test-vault-image.mts (precisa de next start :3000)
 */
import { SignJWT } from "jose";
import { readFileSync } from "fs";
import { resolve } from "path";
import sharp from "sharp";
import {
  createVaultMaterial,
  openVaultMaterial,
  encryptBytes,
  decryptBytes,
  encryptString,
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
const H = { Authorization: `Bearer ${token}` };

let ok = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) { ok++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}`, extra !== undefined ? JSON.stringify(extra).slice(0, 200) : ""); }
}

const { createClient } = await import("@libsql/client");
const db = createClient({ url: process.env.TURSO_URL || process.env.TURSO_LINK, authToken: process.env.TURSO_TOKEN || process.env.TURSO_AUTH_TOKEN });

// Preserva o material original do cofre do usuário para não destruí-lo no teste
const existingMetaRes = await db.execute({ sql: "SELECT * FROM vault_meta WHERE id = 'default'", args: [] }).catch(() => ({ rows: [] }));
const prevMeta = existingMetaRes.rows[0];

try {
  // imagem de teste 64x64 WebP
  const plainImg = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 255, g: 0, b: 0 } },
  }).webp().toBuffer();
  check("imagem de teste gerada (WebP)", plainImg.length > 0 && plainImg[0] === 0x52 && plainImg[1] === 0x49);

  // 1. cofre
  const material = createVaultMaterial("img-test-pw");
  await fetch(`${BASE}/api/vault`, { method: "PUT", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ ...material, updated_at: Date.now() }) });
  const dek = openVaultMaterial("img-test-pw", material)!.dek;

  // 2. nota cifrada
  const noteRes = await fetch(`${BASE}/api/notes`, {
    method: "POST",
    headers: { ...H, "Content-Type": "application/json" },
    body: JSON.stringify({
      title: encryptString(dek, "Nota com imagem"),
      body: encryptString(dek, "corpo"),
      is_vault: true,
    }),
  });
  const note = (await noteRes.json()).note;

  // 3. upload cifrado (exatamente como o cliente web faz)
  const encrypted = encryptBytes(dek, new Uint8Array(plainImg));
  const nameEnc = encryptString(dek, "foto-teste.webp");
  const mimeEnc = encryptString(dek, "image/webp");
  const form = new FormData();
  form.append("file", new Blob([encrypted as unknown as BlobPart], { type: "application/octet-stream" }), "vault.enc");
  form.append("noteId", note.id);
  form.append("fileName", nameEnc);
  form.append("mime", mimeEnc);
  form.append("encrypted", "1");
  const upRes = await fetch(`${BASE}/api/attachments/upload`, { method: "POST", headers: H, body: form });
  const upData = await upRes.json();
  check("upload cifrado aceito", upRes.ok && Boolean(upData.attachment?.id));
  const attId = upData.attachment.id;

  // 4. storage key neutra (sem nome real vazando)
  check("storage key neutra (sem nome real)", !String(upData.attachment.storage_key).includes("foto"));

  // 5. metadados no Turso estão cifrados
  const row = await db.execute({ sql: "SELECT file_name, mime_type, storage_key FROM attachments WHERE id = ?", args: [attId] });
  check("file_name cifrado no banco", String(row.rows[0].file_name).startsWith("enc1:"));
  check("mime_type cifrado no banco", String(row.rows[0].mime_type).startsWith("enc1:"));

  // 6. baixa via rota de streaming → descriptografa → imagem válida
  const binRes = await fetch(`${BASE}/api/attachments/${attId}`, { headers: H });
  const cipherBytes = new Uint8Array(await binRes.arrayBuffer());
  check("bytes servidos são ciphertext (≠ original)", binRes.ok && cipherBytes.length === plainImg.length + 28 && !cipherBytes.slice(0, 4).every((b, i) => b === plainImg[i]));
  const dec = decryptBytes(dek, cipherBytes);
  check("descriptografia devolve a imagem original", Buffer.from(dec).equals(plainImg));

  // 7. R2 key sem vazamento do nome
  const skey = String(row.rows[0].storage_key);
  check("key no R2 não contém o nome da imagem", !skey.includes("foto"));

  // limpeza da nota de teste
  await fetch(`${BASE}/api/notes/${note.id}`, { method: "DELETE", headers: H });
} finally {
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
