/**
 * Lista numerada automática (estilo Keep) — lógica PURA sobre markdown,
 * testável em Node (scripts/test-auto-list.mts).
 *
 * Regras (sempre só no COMEÇO de linha):
 *   - digitar o 2º espaço depois de um número (`33` + `␣␣`) → vira `33. `
 *   - Enter no fim de item `34. algo` → linha nova já com `35. `
 *   - Enter no fim de item VAZIO (`35. ` sem texto) → encerra a lista:
 *     some o marcador e fica só a quebra
 *
 * O body continua markdown puro — web, desktop e preview leem o mesmo texto.
 */

export interface ListEdit {
  text: string;
  /** Cursor depois da edição; -1 = não precisa ajustar. */
  cursor: number;
}

/** Comprimento do prefixo comum entre dois textos (onde eles divergem). */
export function commonPrefixLength(prev: string, next: string): number {
  const max = Math.min(prev.length, next.length);
  let i = 0;
  while (i < max && prev[i] === next[i]) i++;
  return i;
}

/** Confere que `prev` é `next` sem exatamente um caractere na posição `p`. */
function isSingleInsertion(prev: string, next: string, p: number): boolean {
  return prev.length + 1 === next.length && prev === next.slice(0, p) + next.slice(p + 1);
}

function lineStartOf(text: string, p: number): number {
  return text.lastIndexOf("\n", Math.max(0, p - 1)) + 1;
}

/**
 * Aplica as regras comparando o texto anterior com o novo. `enter` marca
 * que o Enter foi a tecla que gerou essa mudança (onKeyPress). Devolve
 * null quando nada a fazer (mudanças grandes/pastes/autocorrejo são ignoradas).
 */
export function autoList(
  prev: string,
  next: string,
  opts: { enter?: boolean } = {}
): ListEdit | null {
  const p = commonPrefixLength(prev, next);
  if (!isSingleInsertion(prev, next, p)) return null;
  const inserted = next[p];
  const lineStart = lineStartOf(next, p);

  // ---- Regra 1: número + dois espaços → `N. ` (cursor não muda: mesmo tamanho)
  if (inserted === " " && !opts.enter && p >= 2 && next[p - 1] === " ") {
    const digits = next.slice(lineStart, p - 1);
    if (/^\d+$/.test(digits)) {
      const text = next.slice(0, p - 1) + ". " + next.slice(p + 1);
      return { text, cursor: p }; // `␣␣` virou `. ` — mesmo comprimento
    }
    return null;
  }

  // ---- Regra 2 e 3: Enter dentro/na sequência de um item numerado
  if (opts.enter && inserted === "\n") {
    const prevLine = next.slice(lineStart, p);
    const match = /^(\d+)\.\s?(.*)$/.exec(prevLine);
    if (!match) return null;

    if (match[2].trim().length > 0) {
      // Regra 2: continua a lista — `N+1. ` logo após a quebra
      const n = Number(match[1]) + 1;
      const marker = `${n}. `;
      const text = next.slice(0, p + 1) + marker + next.slice(p + 1);
      return { text, cursor: p + 1 + marker.length };
    }

    // Regra 3: item vazio → encerra a lista (some `N. ` e a linha quebra)
    const text = next.slice(0, lineStart) + next.slice(p + 1);
    return { text, cursor: lineStart };
  }

  return null;
}
