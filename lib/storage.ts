import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import fs from "fs";
import path from "path";

let r2ClientInstance: S3Client | null = null;

function getR2Client(): S3Client | null {
  if (r2ClientInstance) return r2ClientInstance;

  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (endpoint && accessKeyId && secretAccessKey) {
    r2ClientInstance = new S3Client({
      region: "auto",
      endpoint,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });
    return r2ClientInstance;
  }

  return null;
}

function getR2Bucket(): string {
  return process.env.R2_BUCKET_NAME || "notas";
}

export function isR2Configured(): boolean {
  return Boolean(getR2Client());
}

export interface UploadResult {
  /** Key do objeto no R2 (ou `local:<arquivo>` no fallback de desenvolvimento) */
  fileId: string;
  fileSize: number;
}

export async function uploadAttachmentFile(
  fileName: string,
  buffer: Buffer,
  mimeType: string
): Promise<UploadResult> {
  const r2 = getR2Client();

  // Cloudflare R2 (driver principal)
  if (r2) {
    const key = `${Date.now()}_${fileName}`;
    await r2.send(
      new PutObjectCommand({
        Bucket: getR2Bucket(),
        Key: key,
        Body: buffer,
        ContentType: mimeType,
      })
    );
    return { fileId: key, fileSize: buffer.length };
  }

  // Fallback de desenvolvimento: disco local (pasta uploads/)
  const uploadDir = path.join(process.cwd(), "uploads");
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
  const localFileName = `${Date.now()}_${fileName}`;
  const localFilePath = path.join(uploadDir, localFileName);
  fs.writeFileSync(localFilePath, buffer);
  return { fileId: `local:${localFileName}`, fileSize: buffer.length };
}

export async function getAttachmentStream(
  fileId: string,
  range?: string
): Promise<{
  stream: ReadableStream | NodeJS.ReadableStream | Buffer;
  contentLength?: number;
  contentRange?: string;
  isPartial: boolean;
}> {
  const r2 = getR2Client();

  // Cloudflare R2
  if (r2 && !fileId.startsWith("local:")) {
    const command = new GetObjectCommand({
      Bucket: getR2Bucket(),
      Key: fileId,
      Range: range,
    });
    const res = await r2.send(command);
    return {
      stream: res.Body as any,
      contentLength: res.ContentLength,
      contentRange: res.ContentRange,
      isPartial: Boolean(res.ContentRange),
    };
  }

  // Fallback Local (chaves com prefixo local:, ou R2 não configurado)
  if (fileId.startsWith("local:")) {
    const localName = fileId.replace("local:", "");
    const filePath = path.join(process.cwd(), "uploads", localName);
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;
      const nodeStream = fs.createReadStream(filePath, { start, end });
      return {
        stream: nodeStream,
        contentLength: chunkSize,
        contentRange: `bytes ${start}-${end}/${fileSize}`,
        isPartial: true,
      };
    }

    const nodeStream = fs.createReadStream(filePath);
    return {
      stream: nodeStream,
      contentLength: fileSize,
      isPartial: false,
    };
  }

  throw new Error("Nenhum driver de armazenamento configurado");
}

export async function deleteAttachmentFile(fileId: string): Promise<void> {
  const r2 = getR2Client();

  if (r2 && !fileId.startsWith("local:")) {
    await r2.send(
      new DeleteObjectCommand({
        Bucket: getR2Bucket(),
        Key: fileId,
      })
    );
    return;
  }

  if (fileId.startsWith("local:")) {
    const localName = fileId.replace("local:", "");
    const filePath = path.join(process.cwd(), "uploads", localName);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return;
  }

  throw new Error("Nenhum driver de armazenamento configurado");
}
