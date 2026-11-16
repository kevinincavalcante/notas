/**
 * Fallback NO CLIENTE para links que o servidor não consegue resolver:
 * o TikTok corta title/thumbnail do oEmbed por reputação de IP (bloqueia
 * datacenter, não UA). O dispositivo do usuário está em rede residencial/
 * 4G-5G (ASN legítimo) — lá o oEmbed responde completo.
 *
 * - oEmbed do TikTok manda `access-control-allow-origin: *` → funciona no
 *   navegador (web/desktop) e no React Native (que nem tem CORS)
 * - Sem persistência de propósito: previews são re-buscados por sessão,
 *   então a URL da CDN (que expira em horas) chega sempre fresca — o
 *   re-fetch É o self-healing, sem precisar copiar thumbnail pro R2
 * - Falha silenciosa: se o dispositivo também for bloqueado, o card fica
 *   degradado como já era (título + favicon + play)
 */
export interface ClientOEmbedMeta {
  title: string | null;
  description: string | null;
  image: string | null;
}

function isTikTokUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    return host === "tiktok.com" || host.endsWith(".tiktok.com");
  } catch {
    return false;
  }
}

export async function fetchClientOEmbed(url: string): Promise<ClientOEmbedMeta | null> {
  if (!isTikTokUrl(url)) return null;
  try {
    const res = await fetch(
      `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`,
      { signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    const title = typeof data.title === "string" ? data.title : null;
    const image = typeof data.thumbnail_url === "string" ? data.thumbnail_url : null;
    // Sem título E sem capa não há nada a melhorar no card do servidor
    if (!title && !image) return null;
    const author = typeof data.author_name === "string" ? data.author_name : null;
    return {
      title,
      description: author ? `@${author} no TikTok` : null,
      image,
    };
  } catch {
    return null;
  }
}

/** Mescla o resultado do oEmbed do cliente sobre os metadados do servidor. */
export function mergeClientOEmbed<T extends { title: string; description?: string | null; image?: string | null }>(
  serverMeta: T,
  direct: ClientOEmbedMeta | null
): T {
  if (!direct) return serverMeta;
  return {
    ...serverMeta,
    title: direct.title || serverMeta.title,
    description: direct.description || serverMeta.description,
    image: direct.image || serverMeta.image,
  };
}
