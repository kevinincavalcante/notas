import { NextResponse } from "next/server";
import { uploadAttachmentFile } from "@/lib/storage";
import { db } from "@/lib/turso";
import { autoTagForFile } from "@/lib/auto-tags";
import { attachAutoTag } from "@/lib/tags";
import { logChange } from "@/lib/sync-log";
import { isDesktopLocalMode, isR2Configured, getDesktopApiUrl, getDesktopSessionToken } from "@/lib/desktop-session";
import sharp from "sharp";
import crypto from "crypto";

export async function POST(request: Request) {
  try {
    // Desktop thin-client: sem R2 local, o upload real acontece na API
    // remota (com o JWT do usuário) e o registro é espelhado localmente.
    if (isDesktopLocalMode() && !isR2Configured()) {
      return proxyUploadToApi(request);
    }

    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    // Aceita tanto note_id quanto noteId para garantir compatibilidade
    const noteId = (formData.get("noteId") || formData.get("note_id")) as string | null;
    const durationStr = (formData.get("duration") || formData.get("duration_seconds")) as string | null;
    const duration = durationStr ? parseFloat(durationStr) : null;
    const customFileName = (formData.get("fileName") || formData.get("file_name")) as string | null;

    if (!file || !noteId) {
      return NextResponse.json(
        { error: "Arquivo ou noteId não fornecido" },
        { status: 400 }
      );
    }

    // Valida se a nota existe
    const noteCheck = await db.execute({
      sql: `SELECT id FROM notes WHERE id = ?`,
      args: [noteId],
    });
    if (noteCheck.rows.length === 0) {
      return NextResponse.json({ error: "Nota não encontrada" }, { status: 404 });
    }

    const fileBuffer = Buffer.from(await file.arrayBuffer());
    let processedBuffer = fileBuffer;
    let finalMimeType = file.type || "application/octet-stream";
    let finalFileName = customFileName || file.name || "arquivo";

    // Otimização de Imagens com Sharp (WebP, max 1600px de largura)
    if (file.type.startsWith("image/")) {
      try {
        processedBuffer = await sharp(fileBuffer)
          .rotate() // respeita orientação EXIF da câmera
          .resize({ width: 1600, withoutEnlargement: true })
          .webp({ quality: 80 })
          .toBuffer();

        finalMimeType = "image/webp";
        const nameWithoutExt = finalFileName.substring(0, finalFileName.lastIndexOf(".")) || finalFileName;
        finalFileName = `${nameWithoutExt}.webp`;
      } catch (sharpErr) {
        console.warn("Falha ao otimizar imagem com sharp, enviando original:", sharpErr);
      }
    }

    // Upload via storage unificado (Cloudflare R2 / fallback local de dev)
    const { fileId, fileSize } = await uploadAttachmentFile(
      finalFileName,
      processedBuffer,
      finalMimeType
    );

    const attachmentId = crypto.randomUUID();
    const now = Date.now();

    // Salva o registro do anexo no Turso
    await db.execute({
      sql: `
        INSERT INTO attachments (id, note_id, storage_key, file_name, mime_type, file_size, duration_seconds, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        attachmentId,
        noteId,
        fileId,
        finalFileName,
        finalMimeType,
        fileSize,
        duration,
        now,
      ],
    });
    await logChange("attachment", attachmentId, "upsert");

    // Tag automática opcional baseada no tipo de arquivo
    const autoTag = autoTagForFile(finalMimeType, finalFileName);
    if (autoTag) {
      try {
        await attachAutoTag(noteId, autoTag);
      } catch (tagErr) {
        console.warn("Falha ao anexar tag automática:", tagErr);
      }
    }

    return NextResponse.json({
      success: true,
      attachment: {
        id: attachmentId,
        note_id: noteId,
        storage_key: fileId,
        file_name: finalFileName,
        mime_type: finalMimeType,
        file_size: fileSize,
        duration_seconds: duration,
        created_at: now,
      },
    });
  } catch (error) {
    console.error("Erro no upload do anexo:", error);
    return NextResponse.json(
      { error: "Erro interno no servidor ao processar o upload" },
      { status: 500 }
    );
  }
}

/**
 * Desktop sem R2: repassa o arquivo cru pra API remota (que processa com
 * sharp e sobe pro R2) e espelha o registro no banco local — a UI lista
 * o anexo e o sync deduplica (o remoto já tem a linha com o mesmo id).
 */
async function proxyUploadToApi(request: Request) {
  const apiUrl = getDesktopApiUrl();
  const token = await getDesktopSessionToken();
  if (!apiUrl || !token) {
    return NextResponse.json(
      { error: "Sessão não configurada — faça login novamente" },
      { status: 401 }
    );
  }

  const noteId = await formDataNoteId(request);
  if (!noteId) {
    return NextResponse.json({ error: "Arquivo ou noteId não fornecido" }, { status: 400 });
  }

  const noteCheck = await db.execute({
    sql: `SELECT id FROM notes WHERE id = ?`,
    args: [noteId],
  });
  if (noteCheck.rows.length === 0) {
    return NextResponse.json({ error: "Nota não encontrada" }, { status: 404 });
  }

  const upstream = await fetch(`${apiUrl}/api/attachments/upload`, {
    method: "POST",
    headers: {
      "Content-Type": request.headers.get("content-type") || "application/octet-stream",
      Authorization: `Bearer ${token}`,
    },
    body: await request.arrayBuffer(),
  });

  const data = (await upstream.json().catch(() => ({}))) as {
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

  if (!upstream.ok || !data.attachment) {
    return NextResponse.json(
      { error: data.error || "Falha no upload remoto" },
      { status: upstream.status || 502 }
    );
  }

  const att = data.attachment;
  await db.execute({
    sql: `
      INSERT INTO attachments (id, note_id, storage_key, file_name, mime_type, file_size, duration_seconds, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      att.id,
      noteId,
      att.storage_key,
      att.file_name,
      att.mime_type,
      att.file_size || 0,
      att.duration_seconds ?? null,
      att.created_at || Date.now(),
    ],
  });
  await logChange("attachment", att.id, "upsert");

  return NextResponse.json({ success: true, attachment: { ...att, note_id: noteId } });
}

async function formDataNoteId(request: Request): Promise<string | null> {
  try {
    const form = await request.formData();
    return ((form.get("noteId") || form.get("note_id")) as string | null) || null;
  } catch {
    return null;
  }
}
