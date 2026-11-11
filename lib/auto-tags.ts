/**
 * Marcadores automáticos — nomes no plural, sem emoji.
 *
 * Fonte 1: arquivos (mime type / extensão) — usado na rota de upload.
 * Fonte 2: URLs (JSON-LD / og:type) — será implementado na fase de URLs;
 *          o mapeamento de @type entrará aqui no mesmo formato.
 */

const MIME_TAG_RULES: Array<{ match: (mime: string) => boolean; tag: string }> = [
  { match: (mime) => mime.startsWith("audio/"), tag: "Gravações" },
  { match: (mime) => mime.startsWith("image/"), tag: "Imagens" },
  { match: (mime) => mime.startsWith("video/"), tag: "Vídeos" },
];

// Extensões têm precedência sobre o mime genérico (ex: .key pode chegar
// como application/octet-stream, mas queremos "Chaves")
const EXTENSION_TAG_RULES: Record<string, string> = {
  key: "Chaves",
  pdf: "Documentos",
  doc: "Documentos",
  docx: "Documentos",
  ppt: "Documentos",
  pptx: "Documentos",
  xls: "Documentos",
  xlsx: "Documentos",
  csv: "Documentos",
  odt: "Documentos",
  ods: "Documentos",
  odp: "Documentos",
  rtf: "Documentos",
};

/**
 * Fonte 2: URLs — tipos schema.org do JSON-LD (lowercase) → marcador.
 * Detectado em <script type="application/ld+json"> da página.
 */
const JSONLD_TYPE_TAG_RULES: Record<string, string> = {
  // Produtos / e-commerce
  product: "Compras",
  offer: "Compras",
  productgroup: "Compras",
  productcollection: "Compras",
  // Vídeo
  videoobject: "Vídeos",
  movie: "Vídeos",
  clip: "Vídeos",
  broadcastevent: "Vídeos",
  // Notícias
  newsarticle: "Notícias",
  reportagenewsarticle: "Notícias",
  // Artigos em geral
  article: "Artigos",
  blogposting: "Artigos",
  techarticle: "Artigos",
  scholarlyarticle: "Artigos",
  // Extras comuns
  recipe: "Receitas",
  event: "Eventos",
};

/**
 * Fallback pelo og:type do OpenGraph quando a página não tem JSON-LD útil.
 */
const OG_TYPE_TAG_RULES: Array<{ match: RegExp; tag: string }> = [
  { match: /^product/, tag: "Compras" },
  { match: /^video/, tag: "Vídeos" },
  { match: /^article$/, tag: "Artigos" },
];

/** Retorna os marcadores automáticos de uma página, a partir dos tipos JSON-LD e og:type. */
export function autoTagsFromPage(jsonLdTypes: string[], ogType: string | null): string[] {
  const tags = new Set<string>();
  for (const rawType of jsonLdTypes) {
    const tag = JSONLD_TYPE_TAG_RULES[rawType.toLowerCase().trim()];
    if (tag) tags.add(tag);
  }
  if (tags.size === 0 && ogType) {
    for (const rule of OG_TYPE_TAG_RULES) {
      if (rule.match.test(ogType.toLowerCase().trim())) {
        tags.add(rule.tag);
        break;
      }
    }
  }
  return Array.from(tags);
}

/** Retorna o nome do marcador automático para um arquivo, ou null se não houver regra. */
export function autoTagForFile(mimeType: string, fileName: string): string | null {
  const ext = fileName.includes(".") ? fileName.split(".").pop()!.toLowerCase() : "";
  if (ext && EXTENSION_TAG_RULES[ext]) {
    return EXTENSION_TAG_RULES[ext];
  }

  const mime = (mimeType || "").toLowerCase();
  const rule = MIME_TAG_RULES.find((r) => r.match(mime));
  return rule ? rule.tag : null;
}
