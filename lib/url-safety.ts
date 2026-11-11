/**
 * Proteção contra SSRF: rotas que buscam URLs informadas pelo usuário no lado
 * do servidor (metadados, auto-tags) devem garantir que o destino é público —
 * nunca a própria máquina, rede interna ou serviços de metadados de nuvem
 * (169.254.169.254).
 */
export function isAllowedPublicUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  // Apenas HTTP(S); bloqueia file:, ftp:, gopher: etc.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, ""); // remove colchetes de IPv6
  if (!host) return false;

  // Nomes de host internos/locais
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return false;
  }

  // Bloqueia IPv6 com destino interno (loopback, ULA fc00::/7, link-local fe80::/10)
  if (host.includes(":")) {
    if (host === "::1" || host === "::") return false;
    const v6 = host.split(":")[0];
    if (/^f[cd]/.test(v6) || /^fe[89ab]/.test(v6)) return false;
    return true;
  }

  // Bloqueia IP literal em faixas privadas (IPv4 dotted quad)
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((o) => o > 255)) return false;
    const [a, b] = octets;
    if (a === 0 || a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) || (a === 169 && b === 254)) {
      return false;
    }
    return true;
  }

  return true;
}

/** Headers padrão de um navegador para fetches de páginas externas. */
export const BROWSER_FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml",
};
