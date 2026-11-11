import { NextResponse } from "next/server";
import { uploadAttachmentFile } from "@/lib/storage";
import { db } from "@/lib/turso";
import { autoTagForFile } from "@/lib/auto-tags";
import { attachAutoTag } from "@/lib/tags";
import sharp from "sharp";
import crypto from "crypto";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    // Aceita tanto note_id quanto noteId para garantir compatibilidade
    const noteId = (formData.get("noteId") || formData.get("note_id")) as string | null;
    const durationStr = (formData.get("duration") || formData.get("duration_seconds")) as string | null;
    const duration = durationStr ? parseFloat(durationStr) : null;

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
    let finalFileName = file.name || "arquivo";

    // Otimização de Imagens com Sharp (WebP, max 1600px de largura)
    if (file.type.startsWith("image/")) {
      try {
        processedBuffer = await sharp(fileBuffer)
          .rotate() // respeita orientação EXIF da câmera
          .resize({ width: 1600, withoutEnlargement: true })
          .webp({ quality: 80 })
          .toBuffer();

        finalMimeType = "image/webp";
        const nameWithoutExt = file.name.substring(0, file.name.lastIndexOf(".")) || file.name;
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
