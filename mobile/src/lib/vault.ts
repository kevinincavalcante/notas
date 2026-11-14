import * as ExpoCrypto from "expo-crypto";
import * as LocalAuthentication from "expo-local-authentication";
import * as SecureStore from "expo-secure-store";
import { AppState } from "react-native";
import { getSyncApi } from "./api";
import { getDb, type AttachmentRow, type NoteRow } from "./db";
import type { NoteVersionItem } from "./versions";
import {
  base64ToBytes,
  bytesToBase64,
  createVaultMaterialAsync,
  decryptBytes,
  decryptString,
  encryptString,
  isEncrypted,
  openVaultMaterialAsync,
  rewrapDekAsync,
  setVaultRandomSource,
  DEFAULT_ITERATIONS,
} from "../../../lib/vault-crypto";

/**
 * Estado do COFRE no celular: a DEK (chave de conteúdo) vive SÓ em memória
 * aqui — o SQLite guarda title/body/anexos já cifrados (vêm do sync) e o
 * SecureStore guarda a DEK exportada só quando o usuário liga biometria.
 *
 * Toda a criptografia mora na lib compartilhada (lib/vault-crypto) — a mesma
 * peça que web e desktop usam. O mobile só injeta a fonte de aleatoriedade
 * (expo-crypto, já que o Hermes não garante crypto.getRandomValues).
 */
setVaultRandomSource((n) => ExpoCrypto.getRandomValues(new Uint8Array(n)));

export interface VaultMeta {
  id: string;
  salt: string;
  iterations: number;
  kdf: string;
  wrapped_dek: string;
  updated_at: number;
}

export interface VaultMaterial {
  salt: string;
  iterations: number;
  kdf: string;
  wrapped_dek: string;
  updated_at: number;
}

// ---- DEK em memória + pub/sub (mesmo padrão do onSynced de ./sync) ----

let dek: Uint8Array | null = null;

const subs = new Set<() => void>();

/** Chama `fn` quando a DEK entra/sai da memória (destravar, travar, trocar). */
export function subscribeVault(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

function notifyVaultChanged(): void {
  subs.forEach((fn) => fn());
}

/** DEK atual (null = cofre travado). */
export function getVaultDek(): Uint8Array | null {
  return dek;
}

// ---- Material do cofre (local e remoto) ----

/**
 * Lê o material do cofre: prioriza o SQLite local para acesso instantâneo e offline.
 * Se não houver localmente, busca da API remota e salva no SQLite.
 */
export async function getVaultMeta(): Promise<VaultMeta | null> {
  // 1. Tenta carregar do SQLite local primeiro (offline-first)
  try {
    const { client } = await getDb();
    const local = await client.execute({
      sql: `SELECT id, salt, iterations, kdf, wrapped_dek, updated_at FROM vault_meta WHERE id = 'default'`,
      args: [],
    });
    if (local.rows.length > 0) {
      const row = local.rows[0] as unknown as VaultMeta;
      if (row.salt && row.wrapped_dek) {
        // Tenta sincronizar silenciosamente em background se houver rede
        void refreshVaultMetaFromRemote().catch(() => {});
        return row;
      }
    }
  } catch (e) {
    console.warn("Erro ao ler vault_meta do banco local:", e);
  }

  // 2. Se não tinha no SQLite local, busca na API
  return await refreshVaultMetaFromRemote();
}

/** Busca da API e salva na réplica local se for mais recente */
async function refreshVaultMetaFromRemote(): Promise<VaultMeta | null> {
  try {
    const api = await getSyncApi();
    if (!api) return null;
    const res = await fetch(`${api.baseUrl}/api/vault`, {
      headers: { Authorization: `Bearer ${api.token}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { setup?: boolean; vault_meta?: VaultMeta };
    if (data.setup || !data.vault_meta) return null;

    const remoteMeta = data.vault_meta;
    // Grava no SQLite local para acessos futuros
    try {
      const { client } = await getDb();
      await client.execute({
        sql: `
          INSERT INTO vault_meta (id, salt, iterations, kdf, wrapped_dek, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            salt = excluded.salt,
            iterations = excluded.iterations,
            kdf = excluded.kdf,
            wrapped_dek = excluded.wrapped_dek,
            updated_at = excluded.updated_at
          WHERE excluded.updated_at > vault_meta.updated_at OR vault_meta.updated_at IS NULL
        `,
        args: [
          remoteMeta.id || "default",
          remoteMeta.salt,
          remoteMeta.iterations,
          remoteMeta.kdf || "PBKDF2-SHA256",
          remoteMeta.wrapped_dek,
          remoteMeta.updated_at || Date.now(),
        ],
      });
    } catch (saveErr) {
      console.warn("Falha ao salvar vault_meta recebido da API no SQLite local:", saveErr);
    }

    return remoteMeta;
  } catch {
    return null;
  }
}

/** Grava o material do cofre tanto no SQLite local quanto no servidor remoto. */
export async function saveVaultMeta(material: VaultMaterial): Promise<void> {
  const { client } = await getDb();
  await client.execute({
    sql: `
      INSERT INTO vault_meta (id, salt, iterations, kdf, wrapped_dek, updated_at)
      VALUES ('default', ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        salt = excluded.salt,
        iterations = excluded.iterations,
        kdf = excluded.kdf,
        wrapped_dek = excluded.wrapped_dek,
        updated_at = excluded.updated_at
    `,
    args: [
      material.salt,
      material.iterations,
      material.kdf,
      material.wrapped_dek,
      material.updated_at,
    ],
  });

  const api = await getSyncApi();
  if (api) {
    const res = await fetch(`${api.baseUrl}/api/vault`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${api.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        salt: material.salt,
        iterations: material.iterations,
        kdf: material.kdf,
        wrapped_dek: material.wrapped_dek,
        updated_at: material.updated_at,
      }),
    });
    if (res.status === 409) throw new Error("conflict");
    if (!res.ok) throw new Error(`Falha ao salvar o cofre (${res.status})`);
  }
}

// ---- Destravar / travar / setup ----

/** Abre o cofre com a senha. false = senha errada (ou sem cofre criado). */
export async function unlockVault(password: string): Promise<boolean> {
  let meta = await getVaultMeta();
  if (!meta) {
    // Se não há meta em lugar nenhum, inicializa o cofre com esta senha
    return await setupVault(password);
  }
  const opened = await openVaultMaterialAsync(password, meta);
  if (!opened) return false;
  dek = opened.dek;
  notifyVaultChanged();

  // Com biometria ligada, regrava a DEK no SecureStore — o material pode ter
  // mudado (troca de senha em outro device) e a cópia antiga fica inválida.
  if (await isBiometricEnabled()) {
    await SecureStore.setItemAsync(DEK_KEY, bytesToBase64(dek));
  }
  return true;
}

/** Cria o cofre (primeira vez): material novo + PUT + destrava na hora. */
export async function setupVault(password: string): Promise<boolean> {
  const material = await createVaultMaterialAsync(password);
  await saveVaultMeta({
    salt: material.salt,
    iterations: material.iterations,
    kdf: material.kdf,
    wrapped_dek: material.wrapped_dek,
    updated_at: Date.now(),
  });
  dek = material.dek;
  notifyVaultChanged();
  return true;
}

/** Zera a DEK da memória — nada mais é legível até destravar de novo. */
export function lockVault(): void {
  dek = null;
  notifyVaultChanged();
}

/**
 * Troca de senha do cofre: re-embrulha a MESMA DEK com a senha nova
 * (nada é re-criptografado) e grava o material novo no servidor.
 * false = senha atual errada.
 */
export async function changeVaultPassword(
  currentPassword: string,
  newPassword: string,
  iterations?: number
): Promise<boolean> {
  if (!dek) return false;
  const meta = await getVaultMeta();
  if (!meta) return false;
  const check = await openVaultMaterialAsync(currentPassword, meta);
  if (!check) return false;
  const rewrapped = await rewrapDekAsync(
    dek,
    newPassword,
    iterations ?? meta.iterations ?? DEFAULT_ITERATIONS
  );
  await saveVaultMeta({ ...rewrapped, kdf: meta.kdf || "PBKDF2-SHA256", updated_at: Date.now() });
  // Biometria: a DEK não mudou, então a cópia do SecureStore continua válida.
  return true;
}

// ---- Biometria ----

const DEK_KEY = "notas_vault_dek";
const BIOMETRIC_KEY = "notas_vault_biometric";

/** Hardware suportado + digital cadastrada no aparelho. */
export async function biometricSupported(): Promise<boolean> {
  try {
    if (!(await LocalAuthentication.hasHardwareAsync())) return false;
    if (!(await LocalAuthentication.isEnrolledAsync())) return false;
    const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
    return types.length > 0;
  } catch {
    return false;
  }
}

/** Liga a biometria: valida o hardware e salva a DEK atual no SecureStore. */
export async function enableBiometric(): Promise<boolean> {
  if (!dek) return false; // precisa estar destravado por senha primeiro
  if (!(await biometricSupported())) return false;
  await SecureStore.setItemAsync(DEK_KEY, bytesToBase64(dek));
  await SecureStore.setItemAsync(BIOMETRIC_KEY, "1");
  return true;
}

/** Desliga a biometria e apaga a DEK do SecureStore. */
export async function disableBiometric(): Promise<void> {
  await SecureStore.deleteItemAsync(DEK_KEY);
  await SecureStore.deleteItemAsync(BIOMETRIC_KEY);
}

export async function isBiometricEnabled(): Promise<boolean> {
  return (await SecureStore.getItemAsync(BIOMETRIC_KEY)) === "1";
}

/**
 * Destrava via biometria: lê a DEK exportada do SecureStore e põe em memória.
 * Sem fallback de senha aqui (a tela tem botão próprio pra senha).
 * Se a leitura falhar (ex.: material mudou por troca de senha em outro
 * device), apaga o SecureStore — a próxima entrada é por senha.
 */
export async function unlockWithBiometric(): Promise<boolean> {
  if (!(await isBiometricEnabled())) return false;
  const auth = await LocalAuthentication.authenticateAsync({
    promptMessage: "Destravar o cofre",
    cancelLabel: "Usar senha",
  });
  if (!auth.success) return false;
  const stored = await SecureStore.getItemAsync(DEK_KEY);
  if (!stored) return false;
  try {
    const restored = base64ToBytes(stored);
    if (restored.length !== 32) throw new Error("DEK inválida");
    dek = restored;
    notifyVaultChanged();
    return true;
  } catch {
    await disableBiometric();
    return false;
  }
}

// ---- Auto-lock: background > 5 minutos trava o cofre ----

const AUTO_LOCK_MS = 5 * 60 * 1000;

let backgroundedAt = 0;

if (typeof AppState !== "undefined" && AppState.addEventListener) {
  AppState.addEventListener("change", (state) => {
    if (state === "background" || state === "inactive") {
      backgroundedAt = Date.now();
    } else if (state === "active" && backgroundedAt) {
      const away = Date.now() - backgroundedAt;
      backgroundedAt = 0;
      if (away > AUTO_LOCK_MS && dek) lockVault();
    }
  });
}

// ---- Helpers de decrypt pra UI ----

/** Decifra sem estourar a tela: falha (chave errada) devolve o texto cru. */
function safeDecrypt(dek: Uint8Array, value: string): string {
  try {
    return decryptString(dek, value);
  } catch {
    return value;
  }
}

/** Linha de nota com title/body legíveis (plaintext legado passa direto). */
export function decryptNoteRow(dek: Uint8Array, row: NoteRow): NoteRow {
  return {
    ...row,
    title: safeDecrypt(dek, row.title),
    body: safeDecrypt(dek, row.body),
  };
}

/** Linha de anexo com file_name/mime legíveis quando vierem cifrados. */
export function decryptAttachmentRow(dek: Uint8Array, att: AttachmentRow): AttachmentRow {
  return {
    ...att,
    file_name: isEncrypted(att.file_name) ? safeDecrypt(dek, att.file_name) : att.file_name,
    mime_type: isEncrypted(att.mime_type) ? safeDecrypt(dek, att.mime_type) : att.mime_type,
  };
}

/** Versões do histórico com title/body legíveis. */
export function decryptVersionRows(
  dek: Uint8Array,
  versions: NoteVersionItem[]
): NoteVersionItem[] {
  return versions.map((v) => ({
    ...v,
    title: safeDecrypt(dek, v.title),
    body: safeDecrypt(dek, v.body),
  }));
}
