/**
 * Teste ponta a ponta do protocolo de sync (docs/SYNC.md).
 *
 * Simula uma réplica cliente falando POST /api/sync com o servidor real
 * (npm run dev precisando estar de pé). Cria notas de teste próprias e
 * apaga no final via tombstone — nada seu é tocado.
 *
 * Uso: npx tsx scripts/test-sync.mts
 */
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

function loadEnv() {
  const envPath = resolve(process.cwd(), ".env.local");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i !== -1 && !process.env[t.slice(0, i).trim()]) {
        process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      }
    }
  }
}
loadEnv();

const BASE = process.env.SYNC_TEST_URL || "http://localhost:3000";

const { createToken, AUTH_COOKIE_NAME } = await import("../lib/jwt.js");
const token = await createToken({ username: process.env.APP_USER || "sync-test" });
const cookie = `${AUTH_COOKIE_NAME}=${token}`;

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Cookie: cookie, ...(init?.headers || {}) },
  });
  return res;
}

async function sync(cursor: number, push: unknown = {}) {
  const res = await api("/api/sync", {
    method: "POST",
    body: JSON.stringify({ cursor, push }),
  });
  if (!res.ok) throw new Error(`sync falhou: ${res.status} ${await res.text()}`);
  return res.json();
}

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  if (ok) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}`, extra !== undefined ? JSON.stringify(extra).substring(0, 300) : "");
  }
}

// ---- 1. Bootstrap: cursor 0 devolve o estado completo ----
const boot = await sync(0);
check("bootstrap retorna todas as notas", Array.isArray(boot.notes) && boot.notes.length > 0, {
  recebidas: boot.notes?.length,
});
check("bootstrap retorna cursor > 0", Number(boot.cursor) > 0);
check("bootstrap traz snapshot de tags", Array.isArray(boot.tags) && boot.tags.length > 0);
const bootstrapCursor = Number(boot.cursor);

// ---- 2. Push de nota nova da réplica ----
const replicaNoteId = crypto.randomUUID();
const now = Date.now();
const push1 = await sync(bootstrapCursor, {
  notes: [
    {
      id: replicaNoteId,
      title: "SYNC TEST replica",
      body: "nota criada pela réplica no teste",
      color: "default",
      is_pinned: 0,
      is_archived: 0,
      created_at: now,
      updated_at: now,
    },
  ],
});
check("push de nota nova sem conflitos", Array.isArray(push1.conflicts) && push1.conflicts.length === 0, push1.conflicts);
check(
  "nota da réplica aplicada e refletida no response (change_log)",
  (push1.notes || []).some((n: any) => n.id === replicaNoteId),
  { recebidas: push1.notes?.length }
);

// ---- 3. Conflito LWW: push com updated_at velho perde ----
const perdedora = await sync(Number(push1.cursor), {
  notes: [
    {
      id: replicaNoteId,
      title: "SYNC TEST antigo",
      body: "update velho deve perder",
      color: "default",
      is_pinned: 0,
      is_archived: 0,
      created_at: now,
      updated_at: now - 5000,
    },
  ],
});
check(
  "update com updated_at velho vira conflito",
  Array.isArray(perdedora.conflicts) && perdedora.conflicts.includes(replicaNoteId),
  perdedora.conflicts
);
const aposConflito = await sync(0);
const notaApos = aposConflito.notes.find((n: any) => n.id === replicaNoteId);
check("título preservado após conflito (LWW)", notaApos?.title === "SYNC TEST replica", notaApos?.title);

// ---- 4. Update válido (updated_at mais novo) vence ----
const futuro = now + 5000;
const vencedora = await sync(Number(perdedora.cursor), {
  notes: [
    {
      id: replicaNoteId,
      title: "SYNC TEST venceu",
      body: "update novo vence o LWW",
      color: "blue",
      is_pinned: 0,
      is_archived: 0,
      created_at: now,
      updated_at: futuro,
    },
  ],
});
check("update mais novo aplica sem conflito", vencedora.conflicts.length === 0, vencedora.conflicts);
check(
  "conteúdo atualizado no servidor (refletido no response)",
  (vencedora.notes || []).some((n: any) => n.id === replicaNoteId && n.title === "SYNC TEST venceu" && n.color === "blue"),
  vencedora.notes?.map((n: any) => n.title)
);

// ---- 5. Tombstone propagando no push ----
const tombo = await sync(Number(vencedora.cursor), {
  tombstones: [{ id: replicaNoteId, deleted_at: Date.now() }],
});
check("tombstone refletido no response", (tombo.tombstones || []).some((t: any) => t.id === replicaNoteId));
check("nota tombstoned não vem mais como linha", !(tombo.notes || []).some((n: any) => n.id === replicaNoteId));

// ---- 6. Nota apagada pela UI (API DELETE) gera tombstone visível pro sync ----
const apiNoteRes = await api("/api/notes", {
  method: "POST",
  body: JSON.stringify({ title: "SYNC TEST delete via API", body: "", color: "default" }),
});
const apiNote = await apiNoteRes.json();
const cursorAntesDoDelete = Number((await sync(0)).cursor);
await api(`/api/notes/${apiNote.note.id}`, { method: "DELETE" });
const aposDelete = await sync(cursorAntesDoDelete);
check(
  "DELETE via API gera tombstone no sync",
  aposDelete.tombstones.some((t: any) => t.id === apiNote.note.id)
);

// ---- 7. Versões do histórico no protocolo ----
check(
  "bootstrap traz versões do histórico",
  Array.isArray(boot.versions) && boot.versions.length > 0,
  { recebidas: boot.versions?.length }
);

// Nota dedicada pra versão (FK exige nota existente no servidor)
const noteComVersao = crypto.randomUUID();
const agora = Date.now();
const pushNotaVersao = await sync(Number(aposDelete.cursor), {
  notes: [
    {
      id: noteComVersao,
      title: "SYNC TEST versoes",
      body: "nota pra histórico",
      color: "default",
      is_pinned: 0,
      is_archived: 0,
      created_at: agora,
      updated_at: agora,
    },
  ],
});
const versionId = crypto.randomUUID();
const versoes = await sync(Number(pushNotaVersao.cursor), {
  versions: [
    {
      id: versionId,
      note_id: noteComVersao,
      title: "SYNC TEST versoes",
      body: "estado antigo da nota",
      created_at: agora,
    },
  ],
});
check(
  "versão enviada no push refletida no pull",
  (versoes.versions || []).some((v: any) => v.id === versionId),
  { recebidas: versoes.versions?.length }
);

// Marca d'água: versões com created_at abaixo dela não voltam de novo
const filtro = await sync(Number(versoes.cursor), { versions_watermark: agora + 1 });
check(
  "marca d'água filtra versões já vistas",
  !(filtro.versions || []).some((v: any) => v.id === versionId),
  (filtro.versions || []).length
);

// limpeza da nota de versões
await sync(Number(filtro.cursor), {
  tombstones: [{ id: noteComVersao, deleted_at: Date.now() }],
});

console.log(`\nResultado: ${pass} ok / ${fail} falha`);
process.exit(fail > 0 ? 1 : 0);
