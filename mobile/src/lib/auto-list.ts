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

export interface AutoListOptions {
  /** Mantido por compatibilidade; teclados Android muitas vezes não disparam onKeyPress(Enter). */
  enter?: boolean;
  /** Posição do cursor ANTES da edição (quando colapsado), vinda de onSelectionChange. */
  cursorBefore?: number;
}

/** Comprimento do prefixo comum entre dois textos (onde eles divergem). */
export function commonPrefixLength(prev: string, next: string): number {
  const max = Math.min(prev.length, next.length);
  let i = 0;
  while (i < max && prev[i] === next[i]) i++;
  return i;
}

/** Confere que `prev` é `next` sem exatamente um caractere na posição `p`. */
export function isSingleInsertion(prev: string, next: string, p: number): boolean {
  return prev.length + 1 === next.length && prev === next.slice(0, p) + next.slice(p + 1);
}

function lineStartOf(text: string, p: number): number {
  return text.lastIndexOf("\n", Math.max(0, p - 1)) + 1;
}

/**
 * Aplica as regras comparando o texto anterior com o novo. Usa `cursorBefore`
 * quando disponível para não escorregar por quebras de linha / espaços já
 * existentes abaixo do cursor (ex.: editando um bloco intermediário da nota).
 * Devolve null quando nada a fazer (pastes/autocorreções são ignorados).
 */
export function autoList(
  prev: string,
  next: string,
  opts: AutoListOptions = {}
): ListEdit | null {
  // Sem cursorBefore, commonPrefixLength avança por todos os `\n` ou espaços
  // iguais logo após o cursor e erra a linha quando há blocos abaixo na nota.
  const hasCursor =
    typeof opts.cursorBefore === "number" &&
    opts.cursorBefore >= 0 &&
    opts.cursorBefore <= prev.length;
  const p =
    hasCursor && isSingleInsertion(prev, next, opts.cursorBefore!)
      ? opts.cursorBefore!
      : commonPrefixLength(prev, next);

  if (!isSingleInsertion(prev, next, p)) return null;
  const inserted = next[p];
  const lineStart = lineStartOf(next, p);

  // ---- Regra 1: número + dois espaços → `N. ` (cursor no fim do marcador: p + 1)
  if (inserted === " " && p >= 2 && next[p - 1] === " ") {
    const beforeSpaces = next.slice(lineStart, p - 1);
    const numMatch = /^([ \t]*)(\d+)$/.exec(beforeSpaces);
    if (numMatch) {
      const text = next.slice(0, p - 1) + ". " + next.slice(p + 1);
      return { text, cursor: p + 1 };
    }
    return null;
  }

  // ---- Regra 2 e 3: quebra de linha dentro/na sequência de um item numerado
  // Não exige `opts.enter`: no Android (IME / Fabric), `onKeyPress("Enter")`
  // falha com frequência ou chega fora de ordem em relação a `onChangeText`.
  if (inserted === "\n") {
    const prevLine = next.slice(lineStart, p);
    const match = /^([ \t]*)(\d+)\.\s?(.*)$/.exec(prevLine);
    if (!match) return null;

    const [, indent, numStr, content] = match;
    if (content.trim().length > 0) {
      // Regra 2: continua a lista — `N+1. ` logo após a quebra
      const n = Number(numStr) + 1;
      const marker = `${indent}${n}. `;
      const text = next.slice(0, p + 1) + marker + next.slice(p + 1);
      return { text, cursor: p + 1 + marker.length };
    }

    // Regra 3: item vazio → encerra a lista (some `N. ` e a linha quebra)
    const text = next.slice(0, lineStart) + next.slice(p + 1);
    return { text, cursor: lineStart };
  }

  return null;
}
