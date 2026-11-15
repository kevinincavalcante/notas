/**
 * Heurística de PREVIEW: blocos de texto que são claramente configuração
 * (.env, ini, properties) ganham fence de código automático — senão o
 * markdown "engole": `# =====` vira H1 gigante e comentários viram títulos.
 *
 * Só afeta a EXIBIÇÃO (preview) — o corpo armazenado continua como foi
 * escrito. Regras de segurança pra não estragar notas comuns:
 * - Nada dentro de fences existentes é reprocessado
 * - Bloco com QUALQUER linha que não seja comentário/atribuição (listas,
 *   citações, texto corrido) NÃO é env — passa normal
 * - Bloco só de `#...` (sem nenhuma `KEY=valor`) continua markdown normal:
   `# Título` isolado é heading de verdade
 */

const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_.\-]*\s*=/;
const ENV_COMMENT_RE = /^\s*#/;
/** Linha que só tem "&nbsp;" (e espaços): é linha em branco colada de HTML. */
const NBSP_ONLY_RE = /^(?:&nbsp;|&#160;|&#xa0;|\s)+$/i;

function isBlankLike(line: string): boolean {
  const t = line.trim();
  return t === "" || NBSP_ONLY_RE.test(t);
}

function isEnvLikeBlock(lines: string[]): boolean {
  const nonBlank = lines.filter((l) => !isBlankLike(l));
  if (nonBlank.length === 0) return false;
  let assignments = 0;
  let comments = 0;
  let other = 0;
  for (const line of nonBlank) {
    if (ENV_ASSIGNMENT_RE.test(line)) assignments += 1;
    else if (ENV_COMMENT_RE.test(line)) comments += 1;
    else other += 1;
  }
  if (assignments === 0) return false; // sem `KEY=valor` não é .env
  // Bloco de 1 linha: só interessa se for atribuição (comentário solto é
  // heading markdown de verdade)
  if (nonBlank.length === 1) return assignments === 1;
  // Bloco multi-linha: tudo precisa ser comentário ou atribuição
  return other === 0;
}

export function autoFenceEnvBlocks(content: string): string {
  if (!content) return content;
  const lines = content.split("\n");
  const out: string[] = [];
  let buffer: string[] = [];
  let inFence = false;
  let fenceMarker = "```";

  const flush = () => {
    if (buffer.length === 0) return;
    if (isEnvLikeBlock(buffer)) {
      // Bloco de config gerado por NÓS: o "&nbsp;" colado de HTML é lixo de
      // formatação (vira espaço), diferente de código do usuário (que fica
      // literal)
      out.push("```env", ...buffer.map((l) => l.replace(NBSP_RE, " ")), "```");
    } else {
      out.push(...buffer);
    }
    buffer = [];
  };

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!inFence && (trimmed.startsWith("```") || trimmed.startsWith("~~~"))) {
      flush();
      inFence = true;
      fenceMarker = trimmed.slice(0, 3);
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      if (trimmed.startsWith(fenceMarker)) inFence = false;
      continue;
    }
    if (isBlankLike(line)) {
      flush();
      // Linha só-"&nbsp;" é lixo de HTML: some do preview. Linha em branco
      // de verdade continua (respiro entre as seções).
      if (line.trim() !== "") continue;
      out.push(line);
      continue;
    }
    buffer.push(line);
  }
  flush();
  return out.join("\n");
}

const NBSP_RE = /&nbsp;|&#160;|&#xa0;/gi;

/** Substitui trechos de código inline (entre crases) por eles mesmos. */
function replaceOutsideInlineCode(line: string): string {
  const parts = line.split(/(`[^`]*`)/g);
  return parts
    .map((part, i) => (i % 2 === 1 ? part : part.replace(NBSP_RE, "\u00A0")))
    .join("");
}

/** "&nbsp;" (entidade HTML de espaço inseparável) colada de uma página vira
 *  espaço REAL no preview — antes aparecia o texto literal "&nbsp;" porque o
 *  react-markdown escapa HTML por segurança. Não tem conteúdo: significa
 *  só espaço.
 *  Blocos de código ficam intactos: ali "&nbsp;" é texto literal e importa.
 */
export function decodeNbspEntities(content: string): string {
  if (!content) return content;
  const lines = content.split("\n");
  const out: string[] = [];
  let inFence = false;
  let fenceMarker = "```";
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!inFence && (trimmed.startsWith("```") || trimmed.startsWith("~~~"))) {
      inFence = true;
      fenceMarker = trimmed.slice(0, 3);
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      if (trimmed.startsWith(fenceMarker)) inFence = false;
      continue;
    }
    out.push(replaceOutsideInlineCode(line));
  }
  return out.join("\n");
}

/** Pipeline de pré-processamento do PREVIEW (web/desktop e APK). */
export function preprocessMarkdown(content: string): string {
  return decodeNbspEntities(autoFenceEnvBlocks(content));
}

/**
 * Preserva quebras de linha e Enters extras no Markdown.
 *
 * As linhas em branco extras viram ESPAÇO REAL (U+00A0), não o texto
 * "&nbsp;" — do contrário o react-markdown mostrava a palavra "&nbsp;"
 * literal (dentro de bloco de código a entidade não é decodificada) e,
 * pior, a injeção sem quebra de linha GRUDA o fence seguinte
 * ("&nbsp;```env"), fazendo o fence não abrir o bloco e engolindo o
 * resto da nota num bloco de código gigante.
 */
export function preserveExtraNewlines(text: string): string {
  if (!text) return "";
  const normalized = text.replace(/\r\n/g, "\n");

  const codeBlockRegex = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$))/g;
  const parts = normalized.split(codeBlockRegex);

  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part;

      let res = part;

      // 1. Linhas vazias no início do texto
      res = res.replace(/^(?:[ \t]*\n)+/, (match) => {
        const count = match.split("\n").length - 1;
        if (count <= 0) return "";
        return Array(count).fill("\u00A0").join("\n") + "\n\n";
      });

      // 2. Linhas vazias no final do texto (sempre com quebra no fim: o
      //    próximo bloco de código não pode ficar grudado)
      res = res.replace(/(?:\n[ \t]*)+$/, (match) => {
        const count = match.split("\n").length - 1;
        if (count <= 0) return "";
        return "\n\n" + Array(count).fill("\u00A0").join("\n") + "\n";
      });

      // 3. Múltiplos Enters consecutivos entre blocos
      res = res.replace(/(?:\n[ \t]*){3,}/g, (match) => {
        const lines = match.split("\n").length - 1;
        const extraCount = lines - 2;
        if (extraCount <= 0) return "\n\n";
        const nbsps = Array(extraCount).fill("\u00A0").join("\n");
        return "\n\n" + nbsps + "\n\n";
      });

      return res;
    })
    .join("");
}
