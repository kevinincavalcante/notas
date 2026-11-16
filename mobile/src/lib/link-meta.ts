import { getSyncApi } from "./api";

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
    cache.set(url, data);
    return data;
  } catch (e) {
    console.warn("Metadados do link falharam:", e);
    return null;
  }
}
