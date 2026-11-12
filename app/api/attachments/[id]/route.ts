import { NextRequest, NextResponse } from "next/server";
import { getAttachmentStream, deleteAttachmentFile } from "@/lib/storage";
import { db } from "@/lib/turso";
import { logChange } from "@/lib/sync-log";
import { isDesktopLocalMode, isR2Configured, getDesktopApiUrl, getDesktopSessionToken } from "@/lib/desktop-session";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Desktop sem R2: streaming via proxy da API remota (Range incluso,
    // pausar/avançar áudio continua funcionando igual)
    if (isDesktopLocalMode() && !isR2Configured()) {
      return proxyAttachmentStream(request, id);
    }

    // Busca metadados no Turso
    const result = await db.execute({
      sql: `SELECT * FROM attachments WHERE id = ?`,
      args: [id],
    });

    if (result.rows.length === 0) {
      return NextResponse.json({ error: "Anexo não encontrado" }, { status: 404 });
    }

    const attachment = result.rows[0];
    const fileId = attachment.storage_key as string;
    const mimeType = (attachment.mime_type as string) || "application/octet-stream";
    const fileSize = attachment.file_size as number;

    const rangeHeader = request.headers.get("range") || undefined;

    const { stream, contentLength, contentRange, isPartial } =
      await getAttachmentStream(fileId, rangeHeader);

    // Converte stream em web response stream
    const webStream =
      stream instanceof ReadableStream
        ? stream
        : typeof (stream as any)?.pipe === "function"
        ? new ReadableStream({
            start(controller) {
              (stream as any).on("data", (chunk: Buffer) => controller.enqueue(chunk));
              (stream as any).on("end", () => controller.close());
              (stream as any).on("error", (err: any) => controller.error(err));
            },
          })
        : (stream as any);

    const headers: Record<string, string> = {
      "Content-Type": mimeType,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=31536000, immutable",
    };

    if (contentLength) {
      headers["Content-Length"] = contentLength.toString();
    } else if (fileSize && !isPartial) {
      headers["Content-Length"] = fileSize.toString();
    }

    if (contentRange) {
      headers["Content-Range"] = contentRange;
    }

    return new Response(webStream, {
      status: isPartial ? 206 : 200,
      headers,
    });
  } catch (error) {
    console.error("Erro ao fazer stream de anexo:", error);
    return NextResponse.json({ error: "Erro ao carregar anexo" }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const result = await db.execute({
      sql: `SELECT storage_key FROM attachments WHERE id = ?`,
      args: [id],
    });

    if (result.rows.length === 0) {
      return NextResponse.json({ error: "Anexo não encontrado" }, { status: 404 });
    }

    // Desktop sem R2: o binário vive no remoto — delete lá (o local só
    // guarda o registro)
    if (isDesktopLocalMode() && !isR2Configured()) {
      const token = await getDesktopSessionToken();
      const apiUrl = getDesktopApiUrl();
      if (token && apiUrl) {
        await fetch(`${apiUrl}/api/attachments/${id}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        }).catch((err) =>
          console.warn("Falha ao deletar anexo no remoto (segue o baile local):", err)
        );
      }
    } else {
      const fileId = result.rows[0].storage_key as string;
      try {
        await deleteAttachmentFile(fileId);
      } catch (err) {
        console.warn("Aviso ao deletar arquivo de mídia do storage:", err);
      }
    }

    // Remove do banco local
    await db.execute({
      sql: `DELETE FROM attachments WHERE id = ?`,
      args: [id],
    });
    await logChange("attachment", id, "delete");

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Erro ao deletar anexo:", error);
    return NextResponse.json({ error: "Erro ao excluir anexo" }, { status: 500 });
  }
}

/** Desktop sem R2: stream do remoto com Range/206 preservados. */
async function proxyAttachmentStream(request: NextRequest, id: string) {
  const token = await getDesktopSessionToken();
  const apiUrl = getDesktopApiUrl();
  if (!token || !apiUrl) {
    return NextResponse.json(
      { error: "Sessão não configurada — faça login novamente" },
      { status: 401 }
    );
  }

  const range = request.headers.get("range");
  const upstream = await fetch(`${apiUrl}/api/attachments/${id}`, {
    headers: {
      ...(range ? { Range: range } : {}),
      Authorization: `Bearer ${token}`,
    },
  });

  if (!upstream.ok && upstream.status !== 206) {
    return NextResponse.json(
      { error: "Falha ao carregar anexo do servidor" },
      { status: upstream.status === 401 ? 401 : 502 }
    );
  }

  const headers: Record<string, string> = {
    "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=31536000, immutable",
  };
  const contentLength = upstream.headers.get("content-length");
  const contentRange = upstream.headers.get("content-range");
  if (contentLength) headers["Content-Length"] = contentLength;
  if (contentRange) headers["Content-Range"] = contentRange;

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}
