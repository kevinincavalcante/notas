import { SignJWT } from "jose";
import { readFileSync } from "fs";
import { resolve } from "path";
import sharp from "sharp";
import { createVaultMaterial, openVaultMaterial, encryptBytes, encryptString, base64ToBytes } from "../lib/vault-crypto";

for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf-8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  if (i !== -1 && !process.env[t.slice(0, i)]) process.env[t.slice(0, i)] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

const BASE = "http://127.0.0.1:3000";
const secret = new TextEncoder().encode(process.env.JWT_SECRET!.trim());
const token = await new SignJWT({ username: process.env.APP_USER }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("1h").sign(secret);
const H = { Authorization: `Bearer ${token}` };

const plainImg = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 255, g: 0, b: 0 } } }).webp().toBuffer();
const material = createVaultMaterial("img-test-pw2");
await fetch(`${BASE}/api/vault`, { method: "PUT", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ ...material, updated_at: Date.now() }) });
const dek = openVaultMaterial("img-test-pw2", material)!.dek;

const noteRes = await fetch(`${BASE}/api/notes`, {
  method: "POST",
  headers: { ...H, "Content-Type": "application/json" },
  body: JSON.stringify({ title: encryptString(dek, "t"), body: encryptString(dek, "b"), is_vault: true }),
});
const note = (await noteRes.json()).note;

const encrypted = encryptBytes(dek, new Uint8Array(plainImg));
console.log("tamanhos: plain =", plainImg.length, "| encrypted =", encrypted.length);

const form = new FormData();
form.append("file", new Blob([encrypted as unknown as BlobPart], { type: "application/octet-stream" }), "vault.enc");
form.append("noteId", note.id);
form.append("fileName", encryptString(dek, "foto.webp"));
form.append("encrypted", "1");
const upRes = await fetch(`${BASE}/api/attachments/upload`, { method: "POST", headers: H, body: form });
const upData = await upRes.json();
console.log("upload file_size:", upData.attachment?.file_size);

const binRes = await fetch(`${BASE}/api/attachments/${upData.attachment.id}`, { headers: H });
console.log("GET status:", binRes.status, "| content-length:", binRes.headers.get("content-length"));
const cipherBytes = new Uint8Array(await binRes.arrayBuffer());
console.log("bytes baixados:", cipherBytes.length, "| primeiros:", Array.from(cipherBytes.slice(0, 6)));
console.log("iv esperado:", Array.from(encrypted.slice(0, 6)));

await fetch(`${BASE}/api/notes/${note.id}`, { method: "DELETE", headers: H });
