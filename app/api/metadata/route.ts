import { NextRequest, NextResponse } from "next/server";
import { isAllowedPublicUrl } from "@/lib/url-safety";

function decodeHtml(html: string): string {
  return html
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–");
}

/**
 * Proteção contra SSRF: implementada em lib/url-safety.ts (compartilhada
 * com a detecção de auto-tags por URL).
 */

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const targetUrl = searchParams.get("url");

    if (!targetUrl || !isAllowedPublicUrl(targetUrl)) {
      return NextResponse.json({ error: "URL inválida" }, { status: 400 });
    }

    const parsedUrl = new URL(targetUrl);
    const hostname = parsedUrl.hostname.replace(/^www\./, "");

    // 1. Tratamento Especial para YouTube (usando API oficial oEmbed sem chave)
    if (hostname.includes("youtube.com") || hostname.includes("youtu.be")) {
      try {
        const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(targetUrl)}&format=json`;
        const ytRes = await fetch(oembedUrl, {
          signal: AbortSignal.timeout(4000),
        });
        if (ytRes.ok) {
          const ytData = await ytRes.json();
          return NextResponse.json(
            {
              url: targetUrl,
              title: ytData.title || "Vídeo no YouTube",
              description: `Canal: ${ytData.author_name || "YouTube"}`,
              image: ytData.thumbnail_url || null,
              siteName: "YouTube",
              favicon: "https://www.youtube.com/s/desktop/f6c4bbbf/img/favicon.ico",
            },
            {
              headers: {
                "Cache-Control": "public, max-age=86400, s-maxage=86400",
              },
            }
          );
        }
      } catch (ytErr) {
        console.warn("Falha no oembed do YouTube, tentando parser padrão:", ytErr);
      }
    }

    // 2. Parser Genérico OpenGraph / HTML
    const response = await fetch(targetUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return NextResponse.json(
        {
          url: targetUrl,
          title: hostname,
          description: null,
          image: null,
          siteName: hostname,
          favicon: `https://www.google.com/s2/favicons?domain=${hostname}&sz=32`,
        },
        { status: 200 }
      );
    }

    const html = await response.text();

    const getMeta = (prop: string): string | null => {
      const regex1 = new RegExp(
        `<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`,
        "i"
      );
      const regex2 = new RegExp(
        `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`,
        "i"
      );
      const match = html.match(regex1) || html.match(regex2);
      return match ? decodeHtml(match[1].trim()) : null;
    };

    const rawTitle =
      getMeta("og:title") ||
      getMeta("twitter:title") ||
      html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] ||
      hostname;

    const rawDesc =
      getMeta("og:description") ||
      getMeta("twitter:description") ||
      getMeta("description") ||
      "";

    let rawImage =
      getMeta("og:image") ||
      getMeta("twitter:image") ||
      getMeta("twitter:image:src");

    // Resolve URL relativa de imagem se necessário
    if (rawImage && !rawImage.startsWith("http")) {
      try {
        rawImage = new URL(rawImage, targetUrl).href;
      } catch {
        rawImage = null;
      }
    }

    const siteName =
      getMeta("og:site_name") ||
      hostname;

    return NextResponse.json(
      {
        url: targetUrl,
        title: decodeHtml(rawTitle.slice(0, 150)),
        description: rawDesc ? decodeHtml(rawDesc.slice(0, 220)) : null,
        image: rawImage,
        siteName,
        favicon: `https://www.google.com/s2/favicons?domain=${hostname}&sz=32`,
      },
      {
        headers: {
          "Cache-Control": "public, max-age=86400, s-maxage=86400",
        },
      }
    );
  } catch (error) {
    console.error("Erro ao obter metadados do link:", error);
    return NextResponse.json(
      { error: "Não foi possível carregar prévia do link" },
      { status: 500 }
    );
  }
}
