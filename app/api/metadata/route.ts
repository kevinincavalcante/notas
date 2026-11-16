import { NextRequest, NextResponse } from "next/server";
import { isAllowedPublicUrl, BROWSER_FETCH_HEADERS } from "@/lib/url-safety";
import { getStoredPreview, storePreview } from "@/lib/link-previews";

function decodeHtml(html: string): string {
  return html
    // Entidades numéricas primeiro (&#xa0;, &#8212; — Facebook usa bastante);
    // rodar antes das nomeadas evita dupla decodificação de "&amp;#..."
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
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
 * UA do crawler de preview do Meta. O Facebook só entrega os metadados de
 * reels/vídeos (thumbnail em HD + "X visualizações · Y reações") para esse
 * UA — com UA de navegador comum a requisição leva HTTP 400. É o mesmo
 * mecanismo que faz o WhatsApp montar o preview de links do Facebook.
 */
const CRAWLER_UA =
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";

const CACHE_HEADERS = { "Cache-Control": "public, max-age=86400, s-maxage=86400" };

function metaResponse(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, { status, headers: CACHE_HEADERS });
}

function faviconFor(hostname: string) {
  return `https://www.google.com/s2/favicons?domain=${hostname}&sz=32`;
}

function fallbackMeta(targetUrl: string, hostname: string) {
  return {
    url: targetUrl,
    title: hostname,
    description: null as string | null,
    image: null as string | null,
    siteName: hostname,
    favicon: faviconFor(hostname),
    isVideo: false,
  };
}

const isYouTube = (h: string) => h.includes("youtube.com") || h.includes("youtu.be");
const isFacebook = (h: string) => /(^|\.)(facebook\.com|fb\.watch|fb\.me)$/.test(h);
const isInstagram = (h: string) => /(^|\.)(instagram\.com|instagr\.am)$/.test(h);
const isTikTok = (h: string) => /(^|\.)tiktok\.com$/.test(h);
const isVimeo = (h: string) => /(^|\.)vimeo\.com$/.test(h);

/**
 * Encurtadores que valem um hop extra: 1 requisição HEAD com redirect
 * manual, só para ler o header Location — barato, quase nunca bloqueado
 * (mesmo em IP de datacenter) e dá a URL canônica (@usuario/video/id).
 * Revalida SSRF a cada hop: o destino do redirect é arbitrário.
 */
const SHORTENER_HOSTS = new Set([
  "vt.tiktok.com",
  "vm.tiktok.com",
  "fb.watch",
  "fb.me",
  "t.co",
  "redd.it",
]);

async function resolveShortLink(url: string, maxHops = 3): Promise<string> {
  let current = url;
  try {
    for (let hop = 0; hop < maxHops; hop++) {
      const host = new URL(current).hostname.toLowerCase();
      if (!SHORTENER_HOSTS.has(host)) break;
      const res = await fetch(current, {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.timeout(4000),
        headers: { "User-Agent": BROWSER_FETCH_HEADERS["User-Agent"] },
      });
      const location = res.headers.get("location");
      if (!location) break;
      const next = new URL(location, current).href;
      if (!isAllowedPublicUrl(next)) break; // redirect p/ rede interna etc.
      current = next;
    }
  } catch {
    // HEAD falhou (rede/bloqueio): seguimos com a URL como está
  }
  return current;
}

/** Link é de vídeo social? (o card ganha botão play estilo WhatsApp) */
function isSocialVideo(hostname: string, pathname: string): boolean {
  const h = hostname.replace(/^www\./, "");
  if (isYouTube(h) || isTikTok(h) || isVimeo(h)) return true;
  if (isFacebook(h)) {
    return (
      h === "fb.watch" ||
      /^\/(reel|reels|watch|video|videos)\b/.test(pathname) ||
      /^\/share\/[vr]\//.test(pathname)
    );
  }
  if (isInstagram(h)) return /^\/(reel|reels|tv)\//.test(pathname);
  return false;
}

/** GET HTML externo com User-Agent específico; null em qualquer falha. */
async function fetchText(url: string, userAgent: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": userAgent, Accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** Parser OpenGraph/Twitter Card comum a todos os hosts. */
function parseOgFromHtml(html: string, targetUrl: string, hostname: string) {
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

  return {
    title: decodeHtml(rawTitle.slice(0, 150)),
    description: rawDesc ? decodeHtml(rawDesc.slice(0, 220)) : null,
    image: rawImage,
    siteName: getMeta("og:site_name") || hostname,
  };
}

async function fetchAndParse(targetUrl: string, userAgent: string) {
  const hostname = new URL(targetUrl).hostname.replace(/^www\./, "");
  const html = await fetchText(targetUrl, userAgent);
  if (!html) return fallbackMeta(targetUrl, hostname);
  return parseOgFromHtml(html, targetUrl, hostname);
}

/**
 * Última cartada do Instagram: a página de embed pública (o /reel/ direto
 * costuma devolver login wall para requisições de servidor).
 */
async function tryInstagramEmbed(
  targetUrl: string
): Promise<{ title: string | null; image: string | null } | null> {
  try {
    const parsed = new URL(targetUrl);
    const embedUrl = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}/embed/captioned/`;
    const html = await fetchText(embedUrl, BROWSER_FETCH_HEADERS["User-Agent"]);
    if (!html) return null;

    const image =
      html.match(/class="EmbeddedMediaImage"[^>]*src="([^"]+)"/)?.[1] || null;

    // Legenda do embed (best effort): primeiro bloco Caption, sem tags
    const captionHtml = html.match(/<div class="Caption"[^>]*>([\s\S]*?)<\/div>/)?.[1];
    const caption = captionHtml
      ? decodeHtml(captionHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).slice(0, 120)
      : null;

    if (!image && !caption) return null;
    return { title: caption, image };
  } catch {
    return null;
  }
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
    const favicon = faviconFor(hostname);
    const isVideo = isSocialVideo(hostname, parsedUrl.pathname);

    // 1. Tratamento Especial para YouTube (usando API oficial oEmbed sem chave)
    if (isYouTube(hostname)) {
      try {
        const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(targetUrl)}&format=json`;
        const ytRes = await fetch(oembedUrl, {
          signal: AbortSignal.timeout(4000),
        });
        if (ytRes.ok) {
          const ytData = await ytRes.json();
          return metaResponse({
            url: targetUrl,
            title: ytData.title || "Vídeo no YouTube",
            description: `Canal: ${ytData.author_name || "YouTube"}`,
            image: ytData.thumbnail_url || null,
            siteName: "YouTube",
            favicon: "https://www.youtube.com/s/desktop/f6c4bbbf/img/favicon.ico",
            isVideo: true,
          });
        }
      } catch (ytErr) {
        console.warn("Falha no oembed do YouTube, tentando parser padrão:", ytErr);
      }
    }

    // 2. TikTok (oEmbed público, sem chave). Link curto (vt/vm.tiktok.com)
    // é resolvido pra URL canônica antes — caminho oficial recomendado. O
    // TikTok corta title/thumbnail do oEmbed por reputação de IP (datacenter):
    // nesse caso o cache persistente (preenchido pelo CLIENTE, que resolve
    // na rede residencial/4G) entra antes do card degradado.
    if (isTikTok(hostname)) {
      const canonicalUrl = await resolveShortLink(targetUrl);
      const canonicalPath = new URL(canonicalUrl).pathname;
      const handle = canonicalPath.match(/^\/@([^/]+)/)?.[1] || null;
      try {
        const res = await fetch(
          `https://www.tiktok.com/oembed?url=${encodeURIComponent(canonicalUrl)}`,
          { signal: AbortSignal.timeout(5000) }
        );
        if (res.ok) {
          const data = await res.json();
          if (data.title) {
            return metaResponse({
              url: canonicalUrl,
              title: data.title,
              description: data.author_name ? `@${data.author_name} no TikTok` : null,
              image: data.thumbnail_url || null,
              siteName: "TikTok",
              favicon: "https://www.tiktok.com/favicon.ico",
              isVideo: true,
            });
          }
        }
      } catch (ttErr) {
        console.warn("Falha no oembed do TikTok:", ttErr);
      }
      // oEmbed esvaziado/bloqueado: cache preenchido pelo cliente
      const stored =
        (await getStoredPreview(canonicalUrl)) || (await getStoredPreview(targetUrl));
      if (stored) {
        return metaResponse({
          url: canonicalUrl,
          title: stored.title,
          description: stored.description || (handle ? `@${handle} no TikTok` : null),
          image: stored.image,
          siteName: stored.siteName || "TikTok",
          favicon: "https://www.tiktok.com/favicon.ico",
          isVideo: true,
        });
      }
      // Último recurso: card degradado com o handle da URL canônica
      return metaResponse({
        url: canonicalUrl,
        title: "Vídeo no TikTok",
        description: handle ? `@${handle} no TikTok` : null,
        image: null,
        siteName: "TikTok",
        favicon: "https://www.tiktok.com/favicon.ico",
        isVideo: true,
      });
    }

    // 3. Vimeo (oEmbed público, sem chave)
    if (isVimeo(hostname)) {
      try {
        const res = await fetch(
          `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(targetUrl)}`,
          { signal: AbortSignal.timeout(5000) }
        );
        if (res.ok) {
          const data = await res.json();
          return metaResponse({
            url: targetUrl,
            title: data.title || "Vídeo no Vimeo",
            description: data.author_name ? `Canal: ${data.author_name}` : null,
            image: data.thumbnail_url || null,
            siteName: "Vimeo",
            favicon,
            isVideo: true,
          });
        }
      } catch (vmErr) {
        console.warn("Falha no oembed do Vimeo, tentando parser padrão:", vmErr);
      }
    }

    // 4. Facebook: só serve metadados de vídeos/reels para o crawler de
    // preview do Meta (ver CRAWLER_UA) — com UA de navegador leva 400.
    if (isFacebook(hostname)) {
      const meta = await fetchAndParse(targetUrl, CRAWLER_UA);
      return metaResponse({ url: targetUrl, ...meta, favicon, isVideo });
    }

    // 5. Instagram: bloqueia servidores com login wall. Tenta o UA de
    // crawler, depois a página de embed pública; sem sucesso, devolve um
    // card degradado (o cliente mantém o link simples).
    if (isInstagram(hostname)) {
      const viaCrawler = await fetchAndParse(targetUrl, CRAWLER_UA);
      const logoPlaceholder = "static.cdninstagram.com";
      if (viaCrawler.image && !viaCrawler.image.includes(logoPlaceholder)) {
        return metaResponse({ url: targetUrl, ...viaCrawler, favicon, isVideo });
      }

      const viaEmbed = await tryInstagramEmbed(targetUrl);
      if (viaEmbed) {
        return metaResponse({
          url: targetUrl,
          title: viaEmbed.title || "Post do Instagram",
          description: null,
          image: viaEmbed.image,
          siteName: "Instagram",
          favicon,
          isVideo,
        });
      }

      return metaResponse({
        url: targetUrl,
        title: "Post do Instagram",
        description: null,
        image: null,
        siteName: "Instagram",
        favicon,
        isVideo,
      });
    }

    // 6. Parser Genérico OpenGraph / HTML
    const html = await fetchText(targetUrl, BROWSER_FETCH_HEADERS["User-Agent"]);

    if (!html) {
      return metaResponse(fallbackMeta(targetUrl, hostname));
    }

    const meta = parseOgFromHtml(html, targetUrl, hostname);

    // Servidor voltou sem capa (Instagram e cia bloqueiam por IP)? O cache
    // preenchido pelo CLIENTE (que resolve na rede residencial) completa
    if (!meta.image) {
      const stored = await getStoredPreview(targetUrl);
      if (stored) {
        meta.title = stored.title || meta.title;
        meta.description = stored.description || meta.description;
        meta.image = stored.image || meta.image;
        meta.siteName = stored.siteName || meta.siteName;
      }
    }

    return metaResponse({
      url: targetUrl,
      ...meta,
      favicon,
      isVideo,
    });
  } catch (error) {
    console.error("Erro ao obter metadados do link:", error);
    return NextResponse.json(
      { error: "Não foi possível carregar prévia do link" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/metadata — report de preview resolvido NO CLIENTE.
 * O TikTok/Instagram bloqueiam o fetch do servidor por IP, mas o dispositivo
 * do usuário (rede residencial/4G) resolve o oEmbed: o cliente reporta e o
 * cache persistente serve web/desktop e os outros aparelhos.
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      url?: unknown;
      title?: unknown;
      description?: unknown;
      image?: unknown;
      siteName?: unknown;
    };
    const ok = await storePreview(body);
    if (!ok) {
      return NextResponse.json({ error: "Preview inválido" }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Erro ao salvar preview reportado pelo cliente:", error);
    return NextResponse.json({ error: "Erro ao salvar preview" }, { status: 500 });
  }
}
