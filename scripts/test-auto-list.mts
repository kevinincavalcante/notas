/**
 * Teste da lista numerada automática (mobile/src/lib/auto-list.ts) —
 * roda em Node, sem dispositivo. Uso: npm run test:auto-list
 */
let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  if (ok) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}`, extra !== undefined ? JSON.stringify(extra) : "");
  }
}

const { autoList } = await import("../mobile/src/lib/auto-list.js");
const e = (prev: string, next: string, enter = false, cursorBefore?: number) =>
  autoList(prev, next, { enter, cursorBefore });

// ---- Regra 1: número + dois espaços vira `N. ` (gatilho = o SEGUNDO espaço)
let r = e("33 ", "33  ");
check("33 + 2 espaços → 33. ", r?.text === "33. ", r);
check("cursor no fim de `33. ` (após o espaço)", r?.cursor === 4, r?.cursor);

// recomeça do 1 em linha nova (segunda lista da nota)
r = e("37. dois\n1 ", "37. dois\n1  ");
check("recomeça do 1 em linha nova", r?.text === "37. dois\n1. ", r);

// dois espaços NO MEIO do texto não dispara
r = e("abc 33 ", "abc 33  ");
check("número no meio de texto não dispara", r === null, r);

// não é dígito → não dispara
r = e("ab ", "ab  ");
check("letras + 2 espaços não dispara", r === null, r);

// ---- Regra 2: Enter continua a numeração
r = e("34. algo", "34. algo\n", true);
check("Enter após item → 35. ", r?.text === "34. algo\n35. ", r);
check("cursor depois do marcador novo", r?.cursor === "34. algo\n35. ".length, r?.cursor);

// Enter no Android mesmo sem onKeyPress(Enter) (opts.enter = false / omitido)
r = e("34. algo", "34. algo\n", false);
check("Enter sem onKeyPress continua lista", r?.text === "34. algo\n35. ", r);

// Enter no MEIO da linha (divide o item) também continua
r = e("34. algo", "34. al\ngo", true);
check("Enter no meio divide com 35. ", r?.text === "34. al\n35. go", r);

// ---- Regra 2 em bloco intermediário (linhas em branco + outros blocos abaixo)
const blocoMeioPrev = "Dc11 bege\n33. 4\n\nDc11 Preto\n35. 6\n\nPedir\nTg01 preto alta";
const cursorPosBloco = "Dc11 bege\n33. 4\n\nDc11 Preto\n35. 6".length;
const blocoMeioNext =
  blocoMeioPrev.slice(0, cursorPosBloco) + "\n" + blocoMeioPrev.slice(cursorPosBloco);
r = e(blocoMeioPrev, blocoMeioNext, false, cursorPosBloco);
check(
  "bloco intermediário com \\n\\n abaixo continua numeração",
  r?.text === "Dc11 bege\n33. 4\n\nDc11 Preto\n35. 6\n36. \n\nPedir\nTg01 preto alta",
  r
);
check(
  "cursor após `36. ` no bloco intermediário",
  r?.cursor === "Dc11 bege\n33. 4\n\nDc11 Preto\n35. 6\n36. ".length,
  r?.cursor
);

// Regra 1 no bloco intermediário (com espaços/\n logo após o cursor)
const r1MeioPrev = "Dc11 Preto\n33 \n\nPedir";
const r1Cursor = "Dc11 Preto\n33 ".length;
const r1MeioNext = r1MeioPrev.slice(0, r1Cursor) + " " + r1MeioPrev.slice(r1Cursor);
r = e(r1MeioPrev, r1MeioNext, false, r1Cursor);
check("33 + 2 espaços em bloco intermediário → 33. ", r?.text === "Dc11 Preto\n33. \n\nPedir", r);
check("cursor após `33. ` em bloco intermediário", r?.cursor === "Dc11 Preto\n33. ".length, r?.cursor);

// ---- Regra 3: Enter em item vazio encerra a lista
r = e("anterior\n37. ", "anterior\n37. \n", true);
check("Enter em item vazio encerra (some o marcador)", r?.text === "anterior\n", r);
check("cursor no fim da linha", r?.cursor === "anterior\n".length, r?.cursor);

// Regra 3 em bloco intermediário (preserva blocos abaixo)
const r3MeioPrev = "Dc11 Preto\n35. 6\n36. \n\nPedir";
const r3Cursor = "Dc11 Preto\n35. 6\n36. ".length;
const r3MeioNext = r3MeioPrev.slice(0, r3Cursor) + "\n" + r3MeioPrev.slice(r3Cursor);
r = e(r3MeioPrev, r3MeioNext, false, r3Cursor);
check(
  "Enter em item vazio no bloco intermediário encerra e preserva blocos abaixo",
  r?.text === "Dc11 Preto\n35. 6\n\n\nPedir",
  r
);
check("cursor fica na linha em branco", r?.cursor === "Dc11 Preto\n35. 6\n".length, r?.cursor);

// Indentação preservada
r = e("  34. algo", "  34. algo\n", false);
check("indentação opcional preservada", r?.text === "  34. algo\n  35. ", r);

// Enter em linha comum → nada a fazer
r = e("texto", "texto\n", true);
check("Enter fora de lista = normal", r === null, r);

// Enter em item com conteúdo multi-linha… ou marcador sem ponto não engana
r = e("33 ", "33  \n", true);
check("linha sem `N. ` não engata", r === null, r);

// paste / autocorreção (mudança grande) → ignora sem quebrar
r = e("texto", "texto grande colado inteiro");
check("mudança grande = ignora", r === null, r);

console.log(`\nResultado: ${pass} ok / ${fail} falha\n`);
if (fail > 0) process.exit(1);
