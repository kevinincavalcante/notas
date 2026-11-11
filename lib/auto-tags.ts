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

/**
 * Fonte 3: corpo da nota — detecção de código.
 * Conservador: só considera "código" quando o corpo é claramente um programa
 * ou dado estruturado (blocos cercados, JSON multi-linha, HTML/XML, SQL ou
 * script). Snippet inline de uma linha não conta — nota que só menciona
 * `code` no meio do texto não ganha o marcador.
 */
export function isCodeBody(body: string): boolean {
  const trimmed = body.trim();
  if (!trimmed) return false;

  // 1) Blocos cercados ``` / ~~~ (com ou sem linguagem): bloco com >= 2 linhas
  //    de código conta (1 linha só é caso de inline). Aceita fence aberto no
  //    fim (sem fechar) — rascunho de código.
  const fenceRegex = /(?:^|\n)[ \t]*(?:```|~~~)[^\n]*\n([\s\S]*?)(?:\n[ \t]*(?:```|~~~)|$)/g;
  let fencedLines = 0;
  for (const match of trimmed.matchAll(fenceRegex)) {
    fencedLines += match[1].split("\n").length;
  }
  if (fencedLines >= 2) return true;

  // 2) Corpo inteiro parece código sem fences (mesmo espírito do detector do preview)
  const lines = trimmed.split("\n");
  if (lines.length < 3) return false;

  // JSON multi-linha válido
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      JSON.parse(trimmed);
      return true;
    } catch {
      // cai nos detectores abaixo
    }
  }

  // HTML / XML / SVG
  if (trimmed.startsWith("<") && /^<(?:!doctype|script|template|style|html|svg|div)\b/i.test(trimmed)) {
    return true;
  }

  // SQL
  if (/^(?:select\s[\s\S]+from|insert\s+into|create\s+(?:table|view)|alter\s+table|update\s+\w+\s+set)\b/i.test(trimmed)) {
    return true;
  }

  // Scripts (JS/TS, Python, Go, Java, etc.) — início típico de arquivo
  if (/^(?:import\s|export\s|const\s|let\s|var\s|function\s|class\s|def\s|package\s|using\s|#!\/)/.test(trimmed)) {
    return true;
  }

  return false;
}
