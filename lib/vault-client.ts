"use client";

import type { Attachment, Note, NoteVersion } from "@/types/note";
import {
  decryptBytes,
  decryptString,
  encryptBytes,
  encryptString,
  isEncrypted,
} from "@/lib/vault-crypto";

/**
 * Helpers de CLIENTE (browser) do cofre — cifram/descifram notas, versões e
 * anexos com a DEK já destravada pelo VaultProvider. O servidor nunca vê
 * plaintext de nada que esteja no cofre.
 */

// Cache de blob URLs de anexos cifrados — evita baixar/descriptografar de novo
// a cada render. Revogado em lock() e troca de senha.
const mediaCache = new Map<string, { url: string; mime: string }>();

export function clearVaultMediaCache(): void {
  for (const entry of mediaCache.values()) {
    try {
      URL.revokeObjectURL(entry.url);
    } catch {
      // URL já revogada
    }
  }
  mediaCache.clear();
}

/** Baixa, descriptografa e gera blob URL do anexo (idempotente por id). */
export async function getVaultMediaUrl(
  dek: Uint8Array,
  attachmentId: string,
  mime = "application/octet-stream"
): Promise<string | null> {
  const cached = mediaCache.get(attachmentId);
  if (cached) return cached.url;

  try {
    const res = await fetch(`/api/attachments/${attachmentId}`);
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    const plain = decryptBytes(dek, buf);
    const blob = new Blob([plain as unknown as BlobPart], { type: mime });
    const url = URL.createObjectURL(blob);
    mediaCache.set(attachmentId, { url, mime });
    return url;
  } catch (err) {
    console.error("Falha ao descriptografar anexo do cofre:", err);
    return null;
  }
}

/** Descriptografa metadados do anexo (file_name e mime cifrados). */
export function decryptAttachment(dek: Uint8Array, att: Attachment): Attachment {
  if (!isEncrypted(att.file_name) && !isEncrypted(att.mime_type)) return att;
  try {
    return {
      ...att,
      file_name: isEncrypted(att.file_name) ? decryptString(dek, att.file_name) : att.file_name,
      mime_type: isEncrypted(att.mime_type) ? decryptString(dek, att.mime_type) : att.mime_type,
    };
  } catch {
    // chave errada/não destravada: mantém ciphertext (renderiza como "bloqueado")
    return att;
  }
}

/** Descriptografa os campos de uma nota do cofre (title/body + anexos). */
export function decryptNote(dek: Uint8Array, note: Note): Note {
  const attachments = (note.attachments || []).map((a) => decryptAttachment(dek, a));
  try {
    return {
      ...note,
      title: isEncrypted(note.title) ? decryptString(dek, note.title) : note.title,
      body: isEncrypted(note.body) ? decryptString(dek, note.body) : note.body,
      attachments,
    };
  } catch {
    // DEK errada (troca de senha em outro dispositivo?): deixa ciphertext visível
    return { ...note, attachments };
  }
}

/** Cifra title/body de um patch (só os campos presentes). */
export function encryptNoteFields(
  dek: Uint8Array,
  fields: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...fields };
  if (typeof out.title === "string") out.title = encryptString(dek, out.title);
  if (typeof out.body === "string") out.body = encryptString(dek, out.body);
  return out;
}

export function decryptVersions(dek: Uint8Array, versions: NoteVersion[]): NoteVersion[] {
  return versions.map((v) => ({
    ...v,
    title: isEncrypted(v.title) ? decryptString(dek, v.title) : v.title,
    body: isEncrypted(v.body) ? decryptString(dek, v.body) : v.body,
  }));
}

/** Valores cifrados de file_name/mime para o upload de anexo do cofre. */
export function encryptedAttachmentMeta(
  dek: Uint8Array,
  fileName: string,
  mimeType: string
): { fileNameEnc: string; mimeEnc: string } {
  return {
    fileNameEnc: encryptString(dek, fileName),
    mimeEnc: encryptString(dek, mimeType),
  };
}

/** Cifra os bytes de um arquivo (anexo do cofre) mantendo iv‖ct no binário. */
export function encryptFileBytes(dek: Uint8Array, data: Uint8Array): Uint8Array {
  return encryptBytes(dek, data);
}

/** Prepara FormData de upload de anexo do cofre (implementado em uploadEncryptedFile). */
export async function uploadEncryptedFile(
  dek: Uint8Array,
  file: Blob,
  opts: { noteId: string; fileName: string; mimeType: string; duration?: number | null; id?: string }
): Promise<Attachment | null> {
  const plain = new Uint8Array(await file.arrayBuffer());
  const encrypted = encryptFileBytes(dek, plain);
  const { fileNameEnc, mimeEnc } = encryptedAttachmentMeta(dek, opts.fileName, opts.mimeType);

  const form = new FormData();
  form.append("file", new Blob([encrypted as unknown as BlobPart], { type: "application/octet-stream" }), "vault.enc");
  form.append("noteId", opts.noteId);
  form.append("note_id", opts.noteId);
  form.append("fileName", fileNameEnc);
  form.append("file_name", fileNameEnc);
  form.append("mime", mimeEnc);
  form.append("mime_type", mimeEnc);
  form.append("encrypted", "1");
  if (opts.id) {
    form.append("id", opts.id);
    form.append("attachmentId", opts.id);
  }
  if (opts.duration != null) {
    form.append("duration", String(opts.duration));
    form.append("duration_seconds", String(opts.duration));
  }

  try {
    const res = await fetch("/api/attachments/upload", { method: "POST", body: form });
    const data = await res.json();
    if (res.ok && data.attachment) {
      // Metadados voltam cifrados: devolve já descriptografados pra UI
      return decryptAttachment(dek, data.attachment as Attachment);
    }
    console.error("Upload do cofre falhou:", data?.error || res.status);
    return null;
  } catch (err) {
    console.error("Upload do cofre falhou:", err);
    return null;
  }
}

/**
 * Move uma nota normal PARA o cofre:
 * re-cifra versões, re-envia anexos cifrados e grava os campos cifrados.
 * O conteúdo em texto claro só existe no cliente durante a transição.
 */
export async function moveNoteToVault(dek: Uint8Array, noteId: string): Promise<boolean> {
  try {
    // 1. Nota + versões + anexos em texto claro
    const noteRes = await fetch(`/api/notes/${noteId}`);
    if (!noteRes.ok) return false;
    const noteData = await noteRes.json();
    const note: Note = noteData.note;
    const versionsRes = await fetch(`/api/notes/${noteId}/versions`);
    const versions: NoteVersion[] = versionsRes.ok ? (await versionsRes.json()).versions || [] : [];

    // 2. Versões → cifradas (mesmos ids)
    if (versions.length > 0) {
      await fetch(`/api/notes/${noteId}/versions/reencrypt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          versions: versions.map((v) => ({
            id: v.id,
            title: encryptString(dek, v.title || ""),
            body: encryptString(dek, v.body || ""),
          })),
        }),
      });
    }

    // 3. Anexos → bytes cifrados (mesmo id: o servidor só troca storage_key)
    for (const att of note.attachments || []) {
      const bytesRes = await fetch(`/api/attachments/${att.id}`);
      if (!bytesRes.ok) continue;
      const bytes = new Uint8Array(await bytesRes.arrayBuffer());
      const realName = att.file_name || "anexo";
      await uploadEncryptedFile(dek, new Blob([bytes as unknown as BlobPart]), {
        noteId,
        fileName: realName,
        mimeType: att.mime_type || "application/octet-stream",
        duration: att.duration_seconds ?? null,
        id: att.id,
      });
    }

    // 4. Campos da nota → cifrados + flag
    const patchRes = await fetch(`/api/notes/${noteId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: encryptString(dek, note.title || ""),
        body: encryptString(dek, note.body || ""),
        is_vault: true,
      }),
    });
    return patchRes.ok;
  } catch (err) {
    console.error("Falha ao mover nota para o cofre:", err);
    return false;
  }
}

/**
 * Tira uma nota do cofre: descriptografa campos + versões e re-envia os
 * anexos em texto claro (o PATCH volta a nota pro fluxo normal).
 */
export async function removeNoteFromVault(dek: Uint8Array, noteId: string): Promise<Note | null> {
  try {
    const noteRes = await fetch(`/api/notes/${noteId}`);
    if (!noteRes.ok) return null;
    const noteData = await noteRes.json();
    const cipherNote: Note = noteData.note;
    const plain = decryptNote(dek, cipherNote);

    const versionsRes = await fetch(`/api/notes/${noteId}/versions`);
    const cipherVersions: NoteVersion[] = versionsRes.ok ? (await versionsRes.json()).versions || [] : [];
    const plainVersions = decryptVersions(dek, cipherVersions);

    if (plainVersions.length > 0) {
      await fetch(`/api/notes/${noteId}/versions/reencrypt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          versions: plainVersions.map((v) => ({ id: v.id, title: v.title, body: v.body })),
        }),
      });
    }

    for (const att of plain.attachments || []) {
      const bytesRes = await fetch(`/api/attachments/${att.id}`);
      if (!bytesRes.ok) continue;
      const cipherBytes = new Uint8Array(await bytesRes.arrayBuffer());
      let plainBytes: Uint8Array;
      try {
        plainBytes = decryptBytes(dek, cipherBytes);
      } catch {
        continue; // binário não cifrado (anexo antigo): re-upload como está
      }
      const realName = att.file_name || "anexo";
      const realMime = att.mime_type || "application/octet-stream";
      const form = new FormData();
      form.append("file", new Blob([plainBytes as unknown as BlobPart], { type: realMime }), realName);
      form.append("noteId", noteId);
      form.append("note_id", noteId);
      form.append("fileName", realName);
      form.append("file_name", realName);
      if (att.duration_seconds != null) {
        form.append("duration", String(att.duration_seconds));
        form.append("duration_seconds", String(att.duration_seconds));
      }
      // mesmos ids: o servidor atualiza storage_key/mime/name da linha
      if (att.id) {
        form.append("id", att.id);
        form.append("attachmentId", att.id);
      }
      await fetch(`/api/attachments/upload`, {
        method: "POST",
        body: form,
      });
    }

    const patchRes = await fetch(`/api/notes/${noteId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: plain.title, body: plain.body, is_vault: false }),
    });
    if (!patchRes.ok) return null;
    return plain;
  } catch (err) {
    console.error("Falha ao remover nota do cofre:", err);
    return null;
  }
}
