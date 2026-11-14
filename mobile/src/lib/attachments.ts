import * as FileSystem from "expo-file-system/legacy";
import { AppState } from "react-native";
import { getSyncApi } from "./api";
import { getDb, type AttachmentRow } from "./db";
import { notifyLocalChange, onSynced, scheduleQuietSync, syncQuiet } from "./sync";
import { getVaultDek } from "./vault";
import {
  base64ToBytes,
  bytesToBase64,
  decryptBytes,
  encryptBytes,
  encryptString,
  isEncrypted,
} from "../../../lib/vault-crypto";
import type { Client } from "@libsql/client";

/**
 * Anexos Offline-First (Local-First):
 * 1. Gravação LOCAL IMEDIATA: foto ou áudio é salvo no cache/disco local e
 *    registrado no SQLite em milissegundos. A nota fica pronta na hora sem travar a UI.
 * 2. Fila Assíncrona em Segundo Plano (pending_attachments):
 *    - O app envia aos poucos para a API remota (/api/attachments/upload).
 *    - Antes de subir o anexo, garante que a nota pai foi sincronizada para evitar 404.
 *    - Se faltar internet ou o Android suspender o processo, os arquivos continuam
 *      salvos localmente e a fila é retomada automaticamente no retorno do app.
 */

export interface UploadInput {
  uri: string;
  fileName: string;
  mimeType: string;
  noteId: string;
  durationSeconds?: number | null;
  /** Anexo de nota do cofre: bytes + nome + mime saem cifrados (AES-256-GCM). */
  encrypted?: boolean;
}

interface PendingAttachmentRow {
  id: string;
  note_id: string;
  file_path: string;
  file_name: string;
  mime_type: string;
  file_size: number;
  duration_seconds: number | null;
  created_at: number;
  retries: number;
  last_error: string | null;
  encrypted?: number;
}

function generateUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** Caminho do cache local (sob demanda ou persistido localmente). */
export function cachePath(att: { id: string; file_name?: string }): string {
  const safeName = (att.file_name || "arquivo").replace(/[^\w.\-]+/g, "_");
  return `${FileSystem.cacheDirectory}att-${att.id}-${safeName}`;
}

let queueTableEnsured = false;
async function ensureQueueTable(client: Client): Promise<void> {
  if (queueTableEnsured) return;
  await client.execute(`
    CREATE TABLE IF NOT EXISTS pending_attachments (\n      id TEXT PRIMARY KEY,\n      note_id TEXT NOT NULL,\n      file_path TEXT NOT NULL,\n      file_name TEXT NOT NULL,\n      mime_type TEXT NOT NULL,\n      file_size INTEGER NOT NULL,\n      duration_seconds REAL DEFAULT NULL,\n      created_at INTEGER NOT NULL,\n      retries INTEGER NOT NULL DEFAULT 0,\n      last_error TEXT,\n      encrypted INTEGER NOT NULL DEFAULT 0\n    )\n  `);
  // Migração idempotente: bancos antigos não têm a coluna "encrypted"
  const cols = await client.execute(`PRAGMA table_info(pending_attachments)`);
  if (!cols.rows.some((r) => r.name === "encrypted")) {
    await client.execute(
      `ALTER TABLE pending_attachments ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0`
    );
  }
  queueTableEnsured = true;
}

/**
 * Salva o anexo LOCALMENTE de forma instantânea (offline-first).
 * Insere na tabela attachments como pendente e enfileira para upload em segundo plano.
 */
export async function saveAttachmentLocally(input: UploadInput): Promise<AttachmentRow> {
  const attachmentId = generateUuid();

  let fileSize = 0;
  let storedName = input.fileName;
  let storedMime = input.mimeType;
  // No cofre o nome guardado é CIFRADO — o arquivo local precisa morar no
  // MESMO caminho que a exibição vai procurar (cachePath com o nome cifrado),
  // senão a pré-visualização da foto nova fica em spinner até o upload subir.
  let dest: string;
  if (input.encrypted) {
    const dek = getVaultDek();
    if (!dek) throw new Error("Cofre travado — destrave para anexar arquivos.");
    storedName = encryptString(dek, input.fileName);
    storedMime = encryptString(dek, input.mimeType);
    dest = cachePath({ id: attachmentId, file_name: storedName });
    // Salva referência do arquivo local já disponível para exibição instantânea
    plainUris.set(attachmentId, input.uri);
  } else {
    dest = cachePath({ id: attachmentId, file_name: input.fileName });
  }

  if (input.encrypted) {
    // Anexo de nota do COFRE: nada trafega em claro — os bytes viram
    // iv‖ciphertext (AES-256-GCM) e nome/mime são cifrados como texto.
    const dek = getVaultDek();
    if (!dek) throw new Error("Cofre travado — destrave para anexar arquivos.");
    const b64 = await FileSystem.readAsStringAsync(input.uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const enc = encryptBytes(dek, base64ToBytes(b64));
    await FileSystem.writeAsStringAsync(dest, bytesToBase64(enc), {
      encoding: FileSystem.EncodingType.Base64,
    });
    fileSize = enc.length;
  } else {
    // Fluxo de sempre: copia o arquivo pro cache e mede o tamanho
    try {
      await FileSystem.copyAsync({ from: input.uri, to: dest });
    } catch (copyErr) {
      console.warn("Falha ao copiar anexo para armazenamento local:", copyErr);
    }

    try {
      const info = await FileSystem.getInfoAsync(dest);
      if (info.exists && typeof (info as { size?: number }).size === "number") {
        fileSize = (info as { size: number }).size;
      }
    } catch {
      // fallback
    }
  }

  const now = Date.now();
  const duration = input.durationSeconds ?? null;
  const storageKey = `pending:${attachmentId}`;

  const { client } = await getDb();
  await ensureQueueTable(client);

  // 2. Registra o anexo no SQLite local para a nota já poder exibi-lo
  await client.execute({
    sql: `
      INSERT OR REPLACE INTO attachments
        (id, note_id, storage_key, file_name, mime_type, file_size, duration_seconds, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      attachmentId,
      input.noteId,
      storageKey,
      storedName,
      storedMime,
      fileSize,
      duration,
      now,
    ],
  });

  // 3. Registra na fila de uploads pendentes
  await client.execute({
    sql: `
      INSERT OR REPLACE INTO pending_attachments
        (id, note_id, file_path, file_name, mime_type, file_size, duration_seconds, created_at, retries, last_error, encrypted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
    `,
    args: [
      attachmentId,
      input.noteId,
      dest,
      storedName,
      storedMime,
      fileSize,
      duration,
      now,
      input.encrypted ? 1 : 0,
    ],
  });

  notifyLocalChange();

  // 4. Dispara o envio em segundo plano sem travar a interface
  triggerPendingUploads(500);

  return {
    id: attachmentId,
    note_id: input.noteId,
    storage_key: storageKey,
    file_name: storedName,
    mime_type: storedMime,
    file_size: fileSize,
    duration_seconds: duration,
    created_at: now,
  };
}

/**
 * Ponto de entrada chamado pela interface para anexar arquivos/fotos/áudio.
 * Agora é 100% offline-first: persiste localmente e envia em segundo plano.
 */
export async function uploadAttachment(input: UploadInput): Promise<AttachmentRow | null> {
  return await saveAttachmentLocally(input);
}

let isProcessingQueue = false;
let queueTimer: ReturnType<typeof setTimeout> | null = null;

/** Tentativas por item antes de desistir (e deixar a fila seguir). */
const MAX_ITEM_RETRIES = 10;

/** Agenda um processamento da fila de anexos pendentes com debounce */
export function triggerPendingUploads(delayMs = 300): void {
  if (queueTimer) clearTimeout(queueTimer);
  queueTimer = setTimeout(() => {
    queueTimer = null;
    void processPendingUploads();
  }, delayMs);
}

/**
 * Processador em segundo plano dos anexos pendentes.
 * - Garante que as notas pai subiram pro servidor antes dos anexos (evita 404).
 * - Envia um arquivo por vez com calma.
 * - Suporta falhas transitórias de conexão com retry automático.
 */
export async function processPendingUploads(): Promise<void> {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  try {
    const api = await getSyncApi();
    if (!api) return;

    const { client } = await getDb();
    await ensureQueueTable(client);

    const pendingRes = await client.execute({
      sql: `SELECT * FROM pending_attachments ORDER BY created_at ASC LIMIT 10`,
      args: [],
    });

    const items = pendingRes.rows as unknown as PendingAttachmentRow[];
    if (items.length === 0) return;

    // Antes de subir os anexos, roda um sync para garantir que a nota pai
    // já existe no servidor remoto (elimina erros 404 "Nota não encontrada")
    await syncQuiet(api);

    const uploadUrl = `${api.baseUrl.replace(/\/+$/, "")}/api/attachments/upload`;

    for (const item of items) {
      // Checa se a nota ainda existe localmente (não foi deletada)
      const noteCheck = await client.execute({
        sql: `SELECT id FROM notes WHERE id = ?`,
        args: [item.note_id],
      });
      if (noteCheck.rows.length === 0) {
        // Nota deletada: limpa pendência e arquivo
        await client.execute({ sql: `DELETE FROM pending_attachments WHERE id = ?`, args: [item.id] });
        void cacheExists.deleteCache(item.file_path);
        continue;
      }

      // Checa se o arquivo local ainda existe
      const fileExists = await cacheExists.has(item.id, item.file_path);
      if (!fileExists) {
        await client.execute({ sql: `DELETE FROM pending_attachments WHERE id = ?`, args: [item.id] });
        continue;
      }

      try {
        const res = await FileSystem.uploadAsync(uploadUrl, item.file_path, {
          fieldName: "file",
          httpMethod: "POST",
          uploadType: FileSystem.FileSystemUploadType.MULTIPART,
          headers: {
            Authorization: `Bearer ${api.token}`,
          },
          parameters: {
            id: item.id, // Envia o mesmo ID gerado localmente
            noteId: item.note_id,
            fileName: item.file_name,
            // Anexo do cofre: o servidor pula o sharp e trata como opaco —
            // o mime REAL vai CIFRADO no campo mime (o do multipart é neutro)
            ...(Number(item.encrypted) === 1
              ? { encrypted: "1", mime: item.mime_type }
              : {}),
            ...(item.duration_seconds != null
              ? { duration: String(Math.round(item.duration_seconds)) }
              : {}),
          },
          // Ciphertext no corpo do multipart: mime neutro (o mime REAL vai
          // cifrado no campo mime_type; o servidor trata como opaco)
          mimeType: Number(item.encrypted) === 1 ? "application/octet-stream" : item.mime_type,
        });

        let data: {
          error?: string;
          attachment?: {
            id: string;
            storage_key: string;
            file_name: string;
            mime_type: string;
            file_size: number;
            duration_seconds: number | null;
            created_at: number;
          };
        } = {};

        try {
          data = JSON.parse(res.body);
        } catch {
          // corpo não é JSON válido
        }

        if (res.status >= 200 && res.status < 300 && data.attachment) {
          const remoteAtt = data.attachment;
          // Upload concluído com sucesso: atualiza storage_key real do R2
          await client.execute({
            sql: `UPDATE attachments SET storage_key = ?, file_size = ? WHERE id = ?`,
            args: [remoteAtt.storage_key, remoteAtt.file_size || item.file_size, item.id],
          });
          await client.execute({
            sql: `DELETE FROM pending_attachments WHERE id = ?`,
            args: [item.id],
          });
          await client.execute({
            sql: `INSERT INTO change_log (entity, entity_id, op, at) VALUES ('attachment', ?, 'upsert', ?)`,
            args: [item.id, Date.now()],
          });
          notifyLocalChange();
        } else {
          const err = data.error || `Upload falhou status ${res.status}`;
          console.warn(`[Sync Anexos] Falha no upload de ${item.id}:`, err);
          const retries = (item.retries || 0) + 1;
          await client.execute({
            sql: `UPDATE pending_attachments SET retries = ?, last_error = ? WHERE id = ?`,
            args: [retries, err, item.id],
          });
          if (retries >= MAX_ITEM_RETRIES) {
            // Item envenenado (falha determinística, ex.: anexo do cofre velho
            // ou nota apagada): SAI DA FILA pra não travar as mídias novas.
            // O anexo fica no SQLite (chip some da nota — o binário não subiu).
            await client.execute({ sql: `DELETE FROM pending_attachments WHERE id = ?`, args: [item.id] });
            console.warn(`[Sync Anexos] ${item.id} desistido após ${retries} tentativas — fila segue.`);
            continue;
          }
          // Erro temporário (ex: 404 porque nota ainda está sincronizando): reagenda
          triggerPendingUploads(3000);
          break;
        }
      } catch (uploadErr) {
        const msg = uploadErr instanceof Error ? uploadErr.message : String(uploadErr);
        console.warn(`[Sync Anexos] Erro de rede no upload de ${item.id}:`, msg);
        const retries = (item.retries || 0) + 1;
        await client.execute({
          sql: `UPDATE pending_attachments SET retries = ?, last_error = ? WHERE id = ?`,
          args: [retries, msg, item.id],
        });
        if (retries >= MAX_ITEM_RETRIES) {
          // Mesmo erro de rede por muitas rodadas: desiste do item e segue a
          // fila (o app recria a pendência se o arquivo ainda existir).
          await client.execute({ sql: `DELETE FROM pending_attachments WHERE id = ?`, args: [item.id] });
          console.warn(`[Sync Anexos] ${item.id} desistido após ${retries} tentativas de rede — fila segue.`);
          continue;
        }
        // Erro de rede: para a fila e agenda retry com backoff
        triggerPendingUploads(8000);
        break;
      }
    }
  } catch (err) {
    console.warn("[Sync Anexos] Erro geral na fila de pendências:", err);
  } finally {
    isProcessingQueue = false;
  }
}

// Escuta término de sincronizações de notas para enviar anexos pendentes
onSynced(() => {
  triggerPendingUploads(600);
});

// Quando o app volta ao primeiro plano (foreground), retoma uploads pendentes
if (typeof AppState !== "undefined" && AppState.addEventListener) {
  AppState.addEventListener("change", (state) => {
    if (state === "active") {
      triggerPendingUploads(800);
    }
  });
}

/** Remove anexo (deleta no remoto + local) — igual o DELETE do desktop. */
export async function deleteAttachment(att: AttachmentRow): Promise<void> {
  const api = await getSyncApi();
  const { client } = await getDb();
  await ensureQueueTable(client);

  // Se o anexo ainda estiver na fila de pendentes, cancela a pendência
  await client.execute({
    sql: `DELETE FROM pending_attachments WHERE id = ?`,
    args: [att.id],
  });

  // Se já tinha subido pro servidor remoto (storage_key não-pendente), deleta na API
  if (api && att.storage_key && !att.storage_key.startsWith("pending:")) {
    await fetch(`${api.baseUrl}/api/attachments/${att.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${api.token}` },
    }).catch((e) => console.warn("Falha ao deletar no remoto:", e));
  }

  await client.execute({ sql: `DELETE FROM attachments WHERE id = ?`, args: [att.id] });
  await client.execute({
    sql: `INSERT INTO change_log (entity, entity_id, op, at) VALUES ('attachment', ?, 'delete', ?)`,
    args: [att.id, Date.now()],
  });
  void cacheExists.deleteCache(cachePath(att));
  notifyLocalChange();
  if (api) scheduleQuietSync(api);
}

/** Lista os anexos de uma nota (banco local). */
export async function listAttachments(noteId: string): Promise<AttachmentRow[]> {
  const { client } = await getDb();
  const res = await client.execute({
    sql: `SELECT * FROM attachments WHERE note_id = ? ORDER BY created_at ASC`,
    args: [noteId],
  });
  return res.rows as unknown as AttachmentRow[];
}

const downloading = new Map<string, Promise<string | null>>();

/** Baixa o binário pro cache (com JWT). Idempotente — chamadas em paralelo dividem o download. */
export function cacheAttachment(att: AttachmentRow): Promise<string | null> {
  const dest = cachePath(att);
  const existing = downloading.get(att.id);
  if (existing) return existing;

  const task = (async () => {
    if (await cacheExists.has(att.id, dest)) return dest;
    // Se o anexo for local pendente de upload, ele já deveria estar no cache;
    // se por algum motivo sumiu, não adianta tentar baixar da API remota ainda
    if (att.storage_key && att.storage_key.startsWith("pending:")) {
      return null;
    }

    const api = await getSyncApi();
    if (!api) return null;
    const res = await FileSystem.downloadAsync(
      `${api.baseUrl}/api/attachments/${att.id}`,
      dest,
      { headers: { Authorization: `Bearer ${api.token}` } }
    );
    return res.status === 200 ? res.uri : null;
  })().finally(() => {
    downloading.delete(att.id);
  });
  downloading.set(att.id, task);
  return task;
}

/** Checa se o binário já está no cache. */
export const cacheExists = {
  async has(_id: string, path: string): Promise<boolean> {
    try {
      const info = await FileSystem.getInfoAsync(path);
      return info.exists;
    } catch {
      return false;
    }
  },
  async deleteCache(path: string): Promise<void> {
    try {
      await FileSystem.deleteAsync(path, { idempotent: true });
    } catch {
      // arquivo nem existia — tudo certo
    }
  },
};

// ---- Exibição de anexos (decifra na hora quando for do cofre) ----

/** Cache em memória att.id → uri do plaintext. O arquivo decifrado mora no
 * cache do app (sandbox do sistema) e sobrevive ao lock — não invalidamos,
 * o conteúdo já se mostrou na tela e a sandbox é do próprio app. */
const plainUris = new Map<string, string>();

/** Detecta extensão adequada pelos primeiros bytes para o decoder do Android/RN reconhecer */
function detectExtensionFromBytes(bytes: Uint8Array, fallback = ".webp"): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return ".png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return ".jpg";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return ".webp";
  }
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return ".gif";
  }
  if (bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    return ".m4a";
  }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return ".webm";
  }
  return fallback;
}

/** Uri exibível pro anexo. Não-cifrado delega ao fluxo de sempre
 * (cacheAttachment); cifrado baixa o ciphertext, decifra e grava o plaintext
 * num arquivo com extensão própria para visualização confiável. */
export async function getDisplayUri(
  att: AttachmentRow,
  dek: Uint8Array
): Promise<string | null> {
  const cached = plainUris.get(att.id);
  if (cached) return cached;

  // Anexo comum: nada de cofre aqui
  if (!isEncrypted(att.file_name)) return cacheAttachment(att);

  // Ciphertext já baixado? (cacheAttachment também divide downloads paralelos)
  const cipherUri = await cacheAttachment(att);
  if (!cipherUri) return null;

  try {
    const b64 = await FileSystem.readAsStringAsync(cipherUri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const plain = decryptBytes(dek, base64ToBytes(b64));
    const ext = detectExtensionFromBytes(plain, ".webp");
    const dest = `${FileSystem.cacheDirectory}att-${att.id}-plain${ext}`;
    await FileSystem.writeAsStringAsync(dest, bytesToBase64(plain), {
      encoding: FileSystem.EncodingType.Base64,
    });
    plainUris.set(att.id, dest);
    return dest;
  } catch (e) {
    console.warn("Falha ao decifrar anexo para exibição:", e);
    return null;
  }
}

/** Atalho pra UI: resolve o dek da memória; sem dek só anexo comum aparece. */
export async function displayUriFor(att: AttachmentRow): Promise<string | null> {
  const dek = getVaultDek();
  if (!isEncrypted(att.file_name)) return cacheAttachment(att);
  if (!dek) return null; // cofre travado — placeholder na tela
  return getDisplayUri(att, dek);
}

/** Sincroniza silenciosamente (helper de conveniência após mutações). */
export async function syncAfterChange(): Promise<void> {
  const api = await getSyncApi();
  if (api) void syncQuiet(api);
}
