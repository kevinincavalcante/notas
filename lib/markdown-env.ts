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

function isEnvLikeBlock(lines: string[]): boolean {
  const nonBlank = lines.filter((l) => l.trim() !== "");
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
      out.push("```env", ...buffer, "```");
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
    if (line.trim() === "") {
      flush();
      out.push(line);
      continue;
    }
    buffer.push(line);
  }
  flush();
  return out.join("\n");
}
