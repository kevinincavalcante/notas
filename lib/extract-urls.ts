/**
 * Extrai URLs únicas e válidas de um texto.
 * Puro (sem DOM/fetch) — usado no cliente (LinkPreview) e no servidor (auto-tags).
 */
export function extractUrls(text: string): string[] {
  if (!text) return [];
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const matches = text.match(urlRegex);
  if (!matches) return [];
  // Retorna URLs únicas e válidas
  return Array.from(new Set(matches)).filter((u) => {
    try {
      new URL(u);
      return true;
    } catch {
      return false;
    }
  });
}
