import { marked } from "marked";
import { preprocessMarkdown } from "../../../lib/markdown-preprocess";
import { isCardWorthy, type LinkMeta } from "./link-meta";

/**
 * Markdown → HTML de leitura (modo preview, estilo desktop/Joplin).
 * Roda em RN (marked é JS puro) e alimenta a WebView do modo leitura —
 * que dá seleção/cópia de texto nativa de verdade.
 *
 * - GFM + quebra de linha simples = <br> (as notas são texto corrido)
 * - Listas numeradas do Keep ("33. item") viram <ol start=33>
 * - Tema escuro embutido; texto selecionável; sem JS (segurança)
 * - URLs de redes sociais/vídeos com metadados viram CARD estilo WhatsApp
 *   (thumbnail + play + título + site) — o card inteiro é o link
 */

marked.use({ gfm: true, breaks: true });

const IMAGE_HTML_EXT = new Set(["jpg", "jpeg", "png", "webp", "gif", "svg", "bmp"]);

/** Alt/src com extensão que não é de imagem = ARQUIVO anexado (.key, pdf...) */
function fileLikeText(text: string): boolean {
  const m = text.match(/\.([a-zA-Z0-9]{1,8})$/);
  return Boolean(m && !IMAGE_HTML_EXT.has(m[1].toLowerCase()));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Card de link estilo WhatsApp (thumbnail + play se vídeo + título + site). */
function linkCardHtml(url: string, meta: LinkMeta): string {
  let host = meta.siteName || "";
  try {
    host = host || new URL(url).hostname.replace(/^www\./, "");
  } catch {
    host = host || url;
  }
  const title = escapeHtml(meta.title || host);
  const thumb = meta.image
    ? `<span style="display:block;position:relative;height:200px;background:#000;">` +
      `<img src="${escapeHtml(meta.image)}" alt="" style="width:100%;height:200px;object-fit:cover;display:block;">` +
      (meta.isVideo
        ? `<span style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:52px;height:52px;border-radius:50%;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;">` +
          `<span style="width:0;height:0;border-left:17px solid #fff;border-top:10px solid transparent;border-bottom:10px solid transparent;margin-left:5px;"></span></span>`
        : "") +
      `</span>`
    : "";
  return (
    `<a href="${escapeHtml(url)}" style="display:block;margin:2px 0 14px;border:1px solid #2c2c31;border-radius:12px;overflow:hidden;background:#1c1c1f;text-decoration:none;">` +
    thumb +
    `<span style="display:block;padding:10px 12px;">` +
    `<span style="display:block;color:#fafafa;font-size:13.5px;font-weight:600;line-height:1.35;">${title}</span>` +
    `<span style="display:block;color:#a1a1aa;font-size:11px;margin-top:4px;text-transform:uppercase;letter-spacing:0.5px;">${escapeHtml(host)}</span>` +
    `</span></a>`
  );
}

/**
 * Substitui o <a> da URL pura pelo card; link com texto próprio do usuário
 * ganha o card ACIMA e mantém o texto. Sem metadados, o link fica como está.
 */
function injectLinkCards(html: string, linkMeta: Record<string, LinkMeta>): string {
  let content = html;
  for (const [url, meta] of Object.entries(linkMeta)) {
    if (!meta || !isCardWorthy(meta)) continue;
    // href no HTML chega com & escapado (&amp;) — aceita as duas formas
    const hrefPattern = escapeRegExp(url).replace(/&/g, "&amp;");
    const anchorRe = new RegExp(
      `<a href="(?:${hrefPattern}|${escapeRegExp(url)})">([\\s\\S]*?)</a>`,
      "g"
    );
    const card = linkCardHtml(url, meta);
    content = content.replace(anchorRe, (m, inner: string) => {
      const innerText = inner
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .trim();
      return innerText === url ? card : card + m;
    });
  }
  return content;
}

export function bodyToHtml(
  body: string,
  imgUris: Record<string, string> = {},
  linkMeta: Record<string, LinkMeta> = {}
): string {
  // Blocos .env/ini ganham fence automático (o markdown engolia `# =====`
  // como H1 e comentários como títulos) e "&nbsp;" vira espaço real —
  // igual ao preview do web/desktop
  let content = marked.parse(preprocessMarkdown(body || ""), { async: false }) as string;
  // Cards de link estilo WhatsApp (Facebook, Instagram, TikTok, YouTube...)
  content = injectLinkCards(content, linkMeta);
  // ARQUIVO anexado no corpo (.key, pdf, zip...): vira CHIP CLICÁVEL dentro
  // do corpo (efeito igual ao web) — o toque dispara notasfile://<id>, que
  // o editor intercepta no onShouldStartLoadWithRequest e abre o
  // compartilhar do Android com o arquivo decifrado.
  content = content.replace(
    /<img([^>]*?)src="(?:https?:\/\/[^"]*?)?\/api\/attachments\/([0-9a-fA-F-]+)"([^>]*?)>/g,
    (m, pre: string, id: string, pos: string) => {
      const altMatch = /alt="([^"]*)"/.exec(`${pre}${pos}`);
      const alt = altMatch ? altMatch[1] : "";
      if (!fileLikeText(alt) && !fileLikeText(m)) return m; // imagem de verdade
      return (
        `<a href="notasfile://${id}" style="display:inline-flex;align-items:center;gap:7px;margin:4px 0;` +
        `padding:7px 12px;background:rgba(251,191,36,0.12);border:1px solid rgba(251,191,36,0.4);` +
        `border-radius:10px;color:#fcd34d;text-decoration:none;font-size:13.5px;">` +
        `📎 ${alt || "arquivo"}` +
        `<span style="background:#fbbf24;color:#18181b;border-radius:7px;padding:2px 8px;font-size:11.5px;font-weight:700;">⬇ Baixar</span></a>`
      );
    }
  );
  // Imagens do corpo: resolve do cache LOCAL (file://). A WebView do modo
  // leitura não tem cookie nem header Bearer pra pedir /api/attachments na
  // API remota — o proxy devolvia 401 e a foto aparecia quebrada (alt text).
  // Captura tanto URL RELATIVA (mobile) quanto ABSOLUTA (nota criada no web:
  // marked gera src="https://host/api/attachments/<uuid>").
  if (Object.keys(imgUris).length > 0) {
    content = content.replace(
      /(<img[^>]+src=")(?:https?:\/\/[^"]*?)?\/api\/attachments\/([0-9a-fA-F-]+)(")/g,
      (m, pre: string, id: string, pos: string) =>
        imgUris[id] ? `${pre}${imgUris[id]}${pos}` : m
    );
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<style>
  html,body{margin:0;padding:0;background:transparent;}
  body{
    color:#e4e4e7;
    font-family:-apple-system,'Segoe UI',Roboto,sans-serif;
    font-size:15.5px;line-height:1.55;
    padding:6px 0 40px;
    -webkit-user-select:text;user-select:text;
    word-wrap:break-word;
  }
  p{margin:0 0 14px}
  h1,h2,h3,h4{color:#fafafa;line-height:1.3;margin:22px 0 10px}
  h1{font-size:24px} h2{font-size:20px} h3{font-size:17px}
  a{color:#60a5fa;text-decoration:none}
  code{
    font-family:Menlo,monospace;font-size:13.5px;
    background:#1c1c1f;border-radius:6px;padding:2px 6px;color:#fbbf24;
  }
  pre{
    background:#1c1c1f;border:1px solid #26262a;border-radius:10px;
    padding:12px;overflow-x:auto;margin:0 0 14px;
  }
  pre code{background:none;padding:0;color:#d4d4d8}
  ol,ul{margin:0 0 14px;padding-left:26px}
  li{margin-bottom:6px}
  ol[start]{padding-left:30px}
  blockquote{
    margin:0 0 14px;padding:8px 14px;border-left:3px solid #fbbf24;
    background:#1c1c1f;border-radius:0 8px 8px 0;color:#a1a1aa;
  }
  img{max-width:100%;border-radius:8px}
  hr{border:none;border-top:1px solid #2c2c31;margin:18px 0}
  table{border-collapse:collapse;margin:0 0 14px;width:100%}
  th,td{border:1px solid #2c2c31;padding:7px 10px;text-align:left;font-size:14px}
  th{background:#1c1c1f;color:#fafafa}
  ::selection{background:rgba(251,191,36,.35)}
</style></head><body>${content}</body></html>`;
}
