/**
 * Criptografia do Cofre — AES-256-GCM com chave derivada da senha.
 *
 * Modelo (envelope):
 *   - A senha do cofre NUNCA sai do dispositivo e NUNCA é armazenada.
 *   - O cliente deriva uma KEK (Key Encryption Key) da senha via PBKDF2-SHA256.
 *   - Uma DEK aleatória (32 bytes) cifra de fato todo o conteúdo
 *     (título, corpo, versões, anexos).
 *   - A DEK trafega "embrulhada" (wrapped) pela KEK em vault_meta — trocar a
 *     senha do cofre re-embrulha a mesma DEK, sem re-criptografar nada.
 *
 * Formato dos campos cifrados (strings em TEXT no banco): `enc1:<iv_b64>:<ct_b64>`
 * O prefixo `enc1:` identifica ciphertext — útil pra saber se um campo já está cifrado.
 *
 * Arquivo PURO: compartilhado entre web, desktop (Electron) e mobile (Expo/RN)
 * — não importa nada de servidor. A fonte de aleatoriedade é injetável
 * (web usa crypto.getRandomValues; o celular injeta expo-crypto).
 */

import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { gcm } from "@noble/ciphers/aes.js";

// ---------------------------------------------------------------------------
// Aleatoriedade (injetável: RN usa expo-crypto; web/desktop usam crypto nativo)
// ---------------------------------------------------------------------------

export type RandomBytesFn = (length: number) => Uint8Array;

function defaultRandomBytes(length: number): Uint8Array {
  const g = globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } };
  if (typeof g.crypto?.getRandomValues === "function") {
    return g.crypto.getRandomValues(new Uint8Array(length));
  }
  throw new Error("Sem fonte de aleatoriedade — injete com setVaultRandomSource (expo-crypto)");
}

let randomBytesFn: RandomBytesFn = defaultRandomBytes;

/** Registra a fonte de aleatoriedade (o app mobile injeta expo-crypto no boot). */
export function setVaultRandomSource(fn: RandomBytesFn): void {
  randomBytesFn = fn;
}

function randomBytes(length: number): Uint8Array {
  return randomBytesFn(length);
}

// ---------------------------------------------------------------------------
// Base64 puro (sem btoa/atob — Hermes/RN não garante)
// ---------------------------------------------------------------------------

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let chunk = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    chunk += B64_ALPHABET[(n >> 18) & 63] + B64_ALPHABET[(n >> 12) & 63] + B64_ALPHABET[(n >> 6) & 63] + B64_ALPHABET[n & 63];
    if (chunk.length >= 8192) {
      parts.push(chunk);
      chunk = "";
    }
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    chunk += B64_ALPHABET[(n >> 18) & 63] + B64_ALPHABET[(n >> 12) & 63] + "==";
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    chunk += B64_ALPHABET[(n >> 18) & 63] + B64_ALPHABET[(n >> 12) & 63] + B64_ALPHABET[(n >> 6) & 63] + "=";
  }
  if (chunk) parts.push(chunk);
  return parts.join("");
}

const B64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i++) table[B64_ALPHABET.charCodeAt(i)] = i;
  // variantes url-safe
  table["-".charCodeAt(0)] = 62;
  table["_".charCodeAt(0)] = 63;
  return table;
})();

export function base64ToBytes(b64: string): Uint8Array {
  // Limpa espaços em branco e novas linhas (\n / \r\n emitidos pelo Base64 nativo do Android)
  const clean = b64
    .replace(/[\s\r\n]+/g, "")
    .replace(/=+$/, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const len = clean.length;
  if (len % 4 === 1) throw new Error("base64 inválido");
  const outLen = Math.floor((len * 3) / 4);
  const out = new Uint8Array(outLen);
  let p = 0;
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < len; i++) {
    const code = clean.charCodeAt(i);
    const v = code < 128 ? B64_LOOKUP[code] : -1;
    if (v < 0) throw new Error("base64 inválido");
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[p++] = (buffer >> bits) & 0xff;
    }
  }
  return p === outLen ? out : out.slice(0, p);
}

// ---------------------------------------------------------------------------
// Formato dos campos cifrados
// ---------------------------------------------------------------------------

export const CIPHER_PREFIX = "enc1:";

/** Já é ciphertext reconhecível do cofre? */
export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(CIPHER_PREFIX);
}

/**
 * O campo é ciphertext de uma string VAZIA?
 *
 * O GCM sempre adiciona 16 bytes de tag: ciphertext de "" tem exatamente 16
 * bytes. Isso permite ao servidor (que nunca decifra) reconhecer uma versão
 * de conteúdo vazio sem a chave — era o que deixava passar versões vazias do
 * cofre, já que o ciphertext de "" é uma string "não vazia".
 */
export function isEncryptedEmpty(value: string | null | undefined): boolean {
  if (!isEncrypted(value)) return false;
  const parts = String(value).slice(CIPHER_PREFIX.length).split(":");
  if (parts.length !== 2) return false;
  try {
    return base64ToBytes(parts[1]).length === 16;
  } catch {
    return false;
  }
}

/** Cifra um texto com a DEK → "enc1:<iv>:<ct>" (iv de 12 bytes aleatório). */
export function encryptString(dek: Uint8Array, plaintext: string): string {
  const iv = randomBytes(12);
  const ct = gcm(dek, iv).encrypt(utf8ToBytes(plaintext));
  return `${CIPHER_PREFIX}${bytesToBase64(iv)}:${bytesToBase64(ct)}`;
}

/** Decifra um campo "enc1:...". Lança erro se a chave estiver errada. */
export function decryptString(dek: Uint8Array, token: string): string {
  if (!isEncrypted(token)) return token; // plaintext legado: passa direto
  const parts = token.slice(CIPHER_PREFIX.length).split(":");
  if (parts.length !== 2) throw new Error("Ciphertext malformado");
  const iv = base64ToBytes(parts[0]);
  const ct = base64ToBytes(parts[1]);
  const plain = gcm(dek, iv).decrypt(ct);
  return new TextDecoder().decode(plain);
}

/** Cifra bytes binários (anexos) → { iv, ct }. */
export function encryptBytes(dek: Uint8Array, data: Uint8Array): Uint8Array {
  const iv = randomBytes(12);
  const ct = gcm(dek, iv).encrypt(data);
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return out; // iv (12) ‖ ciphertext — o decodificador fatia de volta
}

/** Decifra bytes no formato iv ‖ ct. */
export function decryptBytes(dek: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length <= 12) throw new Error("Binário cifrado malformado");
  const iv = data.slice(0, 12);
  const ct = data.slice(12);
  return gcm(dek, iv).decrypt(ct);
}

/**
 * Hash determinístico (SHA-256 hex) do CONTEÚDO EM CLARO de uma versão.
 *
 * O ciphertext do cofre muda a cada cifração (IV aleatório), então comparar
 * title/body cifrados nunca detecta "mesmo conteúdo". O cliente calcula este
 * hash antes de cifrar e manda junto no PATCH → `note_versions.content_hash`,
 * que é o que a deduplicação do histórico compara. Formato estável entre web,
 * desktop e mobile: sha256(<título>\x1f<corpo>) em UTF-8.
 */
export function versionContentHash(title: string, body: string): string {
  const input = utf8ToBytes(`${title || ""}\u001f${body || ""}`);
  return bytesToHex(sha256(input));
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] & 0xff).toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Hash do conteúdo VAZIO (título e corpo em branco). O servidor não consegue
 * decifrar o cofre, mas comparando o hash que o cliente manda com esta
 * constante ele sabe que a versão é de estado vazio — e não grava.
 */
export const EMPTY_CONTENT_HASH = versionContentHash("", "");

// ---------------------------------------------------------------------------
// KDF / envelope da DEK
// ---------------------------------------------------------------------------

export const DEFAULT_KDF = "PBKDF2-SHA256";
export const DEFAULT_ITERATIONS = 100_000;

export interface VaultKek {
  kek: Uint8Array;
  salt: Uint8Array;
  iterations: number;
}

/**
 * Deriva a KEK de forma assíncrona.
 * Usa Web Crypto API nativa (crypto.subtle) quando disponível (executa em C++ multithread sem travar a UI).
 * Faz fallback suave para noble/hashes caso subtle não esteja acessível.
 */
export async function deriveKekAsync(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  if (iterations < 10_000) throw new Error("Iterações do KDF baixas demais");

  const g = globalThis as { crypto?: { subtle?: { importKey: Function; deriveBits: Function } } };
  if (g.crypto?.subtle?.importKey && g.crypto?.subtle?.deriveBits) {
    try {
      const keyMaterial = await g.crypto.subtle.importKey(
        "raw",
        utf8ToBytes(password),
        { name: "PBKDF2" },
        false,
        ["deriveBits"]
      );
      const derived = await g.crypto.subtle.deriveBits(
        {
          name: "PBKDF2",
          salt,
          iterations,
          hash: "SHA-256",
        },
        keyMaterial,
        256
      );
      return new Uint8Array(derived);
    } catch {
      // Fallback para JS se subtle falhar
    }
  }

  return pbkdf2(sha256, password, salt, { c: iterations, dkLen: 32 });
}

/** Versão síncrona mantida para compatibilidade direta. */
export function deriveKek(password: string, salt: Uint8Array, iterations: number): Uint8Array {
  if (iterations < 10_000) throw new Error("Iterações do KDF baixas demais");
  return pbkdf2(sha256, password, salt, { c: iterations, dkLen: 32 });
}

/** Embrulha a DEK com a KEK → string "enc1:iv:ct" (mesmo formato dos campos). */
export function wrapDek(kek: Uint8Array, dek: Uint8Array): string {
  return encryptString(kek, bytesToBase64(dek));
}

/** Desembrulha a DEK. Falha (throws) = senha errada. */
export function unwrapDek(kek: Uint8Array, wrapped: string): Uint8Array {
  const inner = decryptString(kek, wrapped);
  const dek = base64ToBytes(inner);
  if (dek.length !== 32) throw new Error("DEK com tamanho inválido");
  return dek;
}

/** Cria um cofre novo (assíncrono, não trava a tela): DEK aleatória + salt + parâmetros, já embrulhada. */
export async function createVaultMaterialAsync(
  password: string,
  iterations: number = DEFAULT_ITERATIONS
): Promise<{
  salt: string;
  iterations: number;
  kdf: string;
  wrapped_dek: string;
  dek: Uint8Array;
}> {
  const salt = randomBytes(16);
  const dek = randomBytes(32);
  const kek = await deriveKekAsync(password, salt, iterations);
  return {
    salt: bytesToBase64(salt),
    iterations,
    kdf: DEFAULT_KDF,
    wrapped_dek: wrapDek(kek, dek),
    dek,
  };
}

/** Cria um cofre novo (síncrono legado). */
export function createVaultMaterial(
  password: string,
  iterations: number = DEFAULT_ITERATIONS
): {
  salt: string;
  iterations: number;
  kdf: string;
  wrapped_dek: string;
  dek: Uint8Array;
} {
  const salt = randomBytes(16);
  const dek = randomBytes(32);
  const kek = deriveKek(password, salt, iterations);
  return {
    salt: bytesToBase64(salt),
    iterations,
    kdf: DEFAULT_KDF,
    wrapped_dek: wrapDek(kek, dek),
    dek,
  };
}

/** Abre a DEK com a senha de forma assíncrona — null quando a senha está errada. */
export async function openVaultMaterialAsync(
  password: string,
  meta: { salt: string; iterations: number; wrapped_dek: string }
): Promise<{ dek: Uint8Array } | null> {
  try {
    const kek = await deriveKekAsync(password, base64ToBytes(meta.salt), meta.iterations);
    return { dek: unwrapDek(kek, meta.wrapped_dek) };
  } catch {
    return null;
  }
}

/** Abre a DEK com a senha (síncrono legado) — null quando a senha está errada. */
export function openVaultMaterial(
  password: string,
  meta: { salt: string; iterations: number; wrapped_dek: string }
): { dek: Uint8Array } | null {
  try {
    const kek = deriveKek(password, base64ToBytes(meta.salt), meta.iterations);
    return { dek: unwrapDek(kek, meta.wrapped_dek) };
  } catch {
    return null;
  }
}

/** Re-embrulha a DEK com uma senha nova (assíncrono). */
export async function rewrapDekAsync(
  dek: Uint8Array,
  newPassword: string,
  iterations: number = DEFAULT_ITERATIONS
): Promise<{ salt: string; iterations: number; wrapped_dek: string }> {
  const salt = randomBytes(16);
  const kek = await deriveKekAsync(newPassword, salt, iterations);
  return {
    salt: bytesToBase64(salt),
    iterations,
    wrapped_dek: wrapDek(kek, dek),
  };
}

/** Re-embrulha a DEK com uma senha nova (troca de senha sem re-criptografar). */
export function rewrapDek(
  dek: Uint8Array,
  newPassword: string,
  iterations: number = DEFAULT_ITERATIONS
): { salt: string; iterations: number; wrapped_dek: string } {
  const salt = randomBytes(16);
  const kek = deriveKek(newPassword, salt, iterations);
  return {
    salt: bytesToBase64(salt),
    iterations,
    wrapped_dek: wrapDek(kek, dek),
  };
}
