import * as FileSystem from "expo-file-system/legacy";
import { getSyncApi } from "./api";
import { getDb, type AttachmentRow } from "./db";
import { notifyLocalChange, scheduleQuietSync, syncQuiet } from "./sync";

/**
 * Anexos no celular: captura → upload direto pra API (JWT, igual desktop
 * thin-client) → registro espelhado no SQLite local → sync leva o resto.
 * Download é SOB DEMANDA com cache local (Bearer no header).
 */

export interface UploadInput {
  uri: string;
  fileName: string;
  mimeType: string;
  noteId: string;
  durationSeconds?: number | null;
}

/** Sobe o arquivo pra API real e espelha o registro no banco local. */
export async function uploadAttachment(input: UploadInput): Promise<AttachmentRow | null> {
  const api = await getSyncApi();
  if (!api) throw new Error("Sem sessão — faça login novamente");

  const form = new FormData();
  // @ts-expect-error — FormData do RN aceita {uri, name, type}
  form.append("file", {
    uri: input.uri,
    name: input.fileName,
    type: input.mimeType,
  });
  form.append("noteId", input.noteId);
  if (input.durationSeconds != null) {
    form.append("duration", String(Math.round(input.durationSeconds)));
  }

  const res = await fetch(`${api.baseUrl}/api/attachments/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${api.token}` },
    body: form,
  });
  const data = (await res.json().catch(() => ({}))) as {
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
  };
  if (!res.ok || !data.attachment) {
    throw new Error(data.error || `Upload falhou (${res.status})`);
  }

  const att = data.attachment;
  const { client } = await getDb();
  await client.execute({
    sql: `
      INSERT OR IGNORE INTO attachments
        (id, note_id, storage_key, file_name, mime_type, file_size, duration_seconds, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      att.id,
      input.noteId,
      att.storage_key,
      att.file_name,
      att.mime_type,
      att.file_size || 0,
      att.duration_seconds ?? input.durationSeconds ?? null,
      att.created_at || Date.now(),
    ],
  });
  await client.execute({
    sql: `INSERT INTO change_log (entity, entity_id, op, at) VALUES ('attachment', ?, 'upsert', ?)`,
    args: [att.id, Date.now()],
  });
  notifyLocalChange();
  scheduleQuietSync(api);
  return att as unknown as AttachmentRow;
}

/** Remove anexo (deleta no remoto + local) — igual o DELETE do desktop. */
export async function deleteAttachment(att: AttachmentRow): Promise<void> {
  const api = await getSyncApi();
  const { client } = await getDb();
  if (api) {
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

/** Caminho do cache local (sob demanda — só baixa quando alguém pede). */
export function cachePath(att: AttachmentRow): string {
  const safeName = (att.file_name || "arquivo").replace(/[^\w.\-]+/g, "_");
  return `${FileSystem.cacheDirectory}att-${att.id}-${safeName}`;
}

const downloading = new Map<string, Promise<string | null>>();

/** Baixa o binário pro cache (com JWT). Idempotente — chamadas em paralelo dividem o download. */
export function cacheAttachment(att: AttachmentRow): Promise<string | null> {
  const dest = cachePath(att);
  const existing = downloading.get(att.id);
  if (existing) return existing;

  const task = (async () => {
    if (await cacheExists.has(att.id, dest)) return dest;
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

/** Sincroniza silenciosamente (helper de conveniência após mutações). */
export async function syncAfterChange(): Promise<void> {
  const api = await getSyncApi();
  if (api) void syncQuiet(api);
}
