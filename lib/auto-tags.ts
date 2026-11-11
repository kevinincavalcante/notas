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
