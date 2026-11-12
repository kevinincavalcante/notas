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
const e = (prev: string, next: string, enter = false) => autoList(prev, next, { enter });

// ---- Regra 1: número + dois espaços vira `N. ` (gatilho = o SEGUNDO espaço)
let r = e("33 ", "33  ");
check("33 + 2 espaços → 33. ", r?.text === "33. ", r);
check("cursor não muda (mesmo tamanho)", r?.cursor === 3, r?.cursor);

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

// Enter no MEIO da linha (divide o item) também continua
r = e("34. algo", "34. al\ngo", true);
check("Enter no meio divide com 35. ", r?.text === "34. al\n35. go", r);

// ---- Regra 3: Enter em item vazio encerra a lista
r = e("anterior\n37. ", "anterior\n37. \n", true);
check("Enter em item vazio encerra (some o marcador)", r?.text === "anterior\n", r);
check("cursor no fim da linha", r?.cursor === "anterior\n".length, r?.cursor);

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
