import { getSyncApi } from "./api";
import { fetchClientOEmbed, mergeClientOEmbed } from "../../../lib/link-oembed-client";

/**
 * Metadados de link (OpenGraph via /api/metadata) para os cards estilo
 * WhatsApp no modo leitura. Cache em memória: cada URL é buscada uma vez
 * por sessão do app — reabrir a mesma nota não dispara fetch de novo.
 *
 * Notas do COFRE não buscam metadados: a URL do corpo jamais pode ser
 * revelada ao servidor (o preview exigiria enviá-la em claro).
 */
export interface LinkMeta {
  url: string;
  title: string;
  description?: string | null;
  image?: string | null;
  siteName: string;
  favicon?: string;
  /** Link de vídeo social (Reels, TikTok, YouTube...) → botão play na capa */
  isVideo?: boolean;
}

const cache = new Map<string, LinkMeta>();

export function getCachedLinkMeta(url: string): LinkMeta | null {
  return cache.get(url) || null;
}

/**
 * Card só vale a pena com thumbnail ou descrição — falha total do parser
 * (título = hostname, sem nada) mantém o link puro, sem card vazio.
 */
export function isCardWorthy(meta: LinkMeta): boolean {
  return Boolean(meta.image || meta.description);
}

export async function fetchLinkMeta(url: string): Promise<LinkMeta | null> {
  const cached = cache.get(url);
  if (cached) return cached;
  try {
    const api = await getSyncApi();
    if (!api) return null;
    const res = await fetch(
      `${api.baseUrl}/api/metadata?url=${encodeURIComponent(url)}`,
      { headers: { Authorization: `Bearer ${api.token}` } }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as LinkMeta;
    if (!data || typeof data.title !== "string" || !data.title) return null;
    let meta: LinkMeta = { ...data };
    // Servidor voltou sem capa (TikTok bloqueia por IP de datacenter)?
    // O dispositivo tenta o oEmbed direto — rede residencial/4G não é bloqueada
    if (!meta.image) {
      const direct = await fetchClientOEmbed(url);
      if (direct) {
        meta = mergeClientOEmbed(meta, direct);
        if (meta.image) {
          // Reporta ao servidor o que o DISPOSITIVO resolveu: o cache
          // persistente serve web/desktop e os outros aparelhos (o servidor
          // sozinho nunca conseguiria essa capa). Fire-and-forget.
          void fetch(`${api.baseUrl}/api/metadata`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${api.token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              url,
              title: meta.title,
              description: meta.description,
              image: meta.image,
              siteName: meta.siteName,
            }),
          }).catch(() => {});
        }
      }
    }
    cache.set(url, meta);
    return meta;
  } catch (e) {
    console.warn("Metadados do link falharam:", e);
    return null;
  }
}
