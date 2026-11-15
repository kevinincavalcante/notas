import { marked } from "marked";

/**
 * Markdown → HTML de leitura (modo preview, estilo desktop/Joplin).
 * Roda em RN (marked é JS puro) e alimenta a WebView do modo leitura —
 * que dá seleção/cópia de texto nativa de verdade.
 *
 * - GFM + quebra de linha simples = <br> (as notas são texto corrido)
 * - Listas numeradas do Keep ("33. item") viram <ol start=33>
 * - Tema escuro embutido; texto selecionável; sem JS (segurança)
 */

marked.use({ gfm: true, breaks: true });

const IMAGE_HTML_EXT = new Set(["jpg", "jpeg", "png", "webp", "gif", "svg", "bmp"]);

/** Alt/src com extensão que não é de imagem = ARQUIVO anexado (.key, pdf...) */
function fileLikeText(text: string): boolean {
  const m = text.match(/\.([a-zA-Z0-9]{1,8})$/);
  return Boolean(m && !IMAGE_HTML_EXT.has(m[1].toLowerCase()));
}

export function bodyToHtml(body: string, imgUris: Record<string, string> = {}): string {
  let content = marked.parse(body || "", { async: false }) as string;
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
