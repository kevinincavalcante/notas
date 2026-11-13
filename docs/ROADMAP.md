# 🗺️ Roadmap — Notas

> Documento vivo. Conforme os recursos forem sendo analisados, a gente encaixa
> aqui: cada recurso novo entra na **Fila de Recursos** e depois vira fase
> executada. Decisões fechadas ficam em **Decisões de Arquitetura**.

---

## 🧭 Visão Geral

O **app web Next.js não é "a versão para browser" — ele é o backend de tudo**:
API REST (notas, busca FTS5, anexos com pipeline `sharp`, previews de link,
histórico de versões), autenticação JWT e o banco Turso. Os apps de Linux e
Android consomem essa mesma base.

```
┌─────────────────┐   ┌──────────────────┐   ┌─────────────────┐
│  App Linux       │   │  App Android      │   │  Web (fallback) │
│  (Electron,      │   │  (Expo/Capacitor, │   │                 │
│   sidecar Next)  │   │   decisão pendente)│   │                 │
└────────┬────────┘   └────────┬─────────┘   └────────┬────────┘
         │   SQLite local      │   SQLite local        │
         │   + sync engine ◄───┴───► sync engine      │
         ▼                     ▼                      ▼
              /api/sync  +  API REST existente
                          │
                          ▼
                   Turso (libSQL) + R2
```

---

## 📐 Decisões de Arquitetura

### 1. Linux = Electron (decidido ✅)
- **Motivo**: tudo em TypeScript ponta a ponta (sem Rust), Chromium próprio
  embutido → renderização consistente em qualquer distro (o Tauri usa a
  WebKitGTK do sistema, historicamente com bugs no Linux), `electron-builder`
  gera `.deb`/`AppImage` sem drama.
- **A UI não será reescrita**: o Electron roda o próprio app Next como
  **sidecar** (`next start` no processo main, BrowserWindow apontando para
  `localhost`). A UI Keep-style atual vira o app de Linux inteiro.

### 2. Local-first + Sync (decidido ✅ — design a refinar)
Requisito do dono do app: **estável, dados baixados localmente, sincronizando
quando alterado**.

- **Banco**: `lib/turso.ts` escolhe por ambiente —
  - Web/hospedado: Turso (atual, via `TURSO_LINK`)
  - Desktop: SQLite em arquivo (`NOTES_DB_PATH`) — **mesma API libSQL**, o app
    inteiro funciona sem saber qual banco está por trás (implementado ✅)
- **Anexos**: driver de disco local **já existe** em `lib/storage.ts` → passa a
  ser o padrão no desktop; no mobile, armazenamento do app.
- **Motor de sync em TS puro** (compartilhado entre desktop e mobile):
  - cursor incremental via tabela `change_log` (seq auto-incremento por réplica)
  - resolução de conflito: **LWW por `updated_at`** (usuário único = conflitos raros)
  - **tombstones** para exclusões propagarem corretamente
  - endpoint **`/api/sync`** no backend existente
  - **contrato completo: `docs/SYNC.md`** (payload, cursor, regras de aplicação)
- **Anexos no desktop: download sob demanda** (decisão do dono ✅) — metadados
  sincronizam, binário baixa quando a nota abre pela primeira vez e fica em cache
- ⚠️ **Não depender das embedded replicas do libSQL**: os recursos de
  "embedded replica/sync" da Turso mudaram de rumo em 2025 — verificar o estado
  atual antes de considerar. O desenho acima funciona sem eles.

### 3. Android = Expo (decidido ✅)
- **Expo/React Native**: UI nativa nova (o UI React DOM não reaproveita), motor
  de sync e lógica de domínio reutilizados (JS puro + `expo-sqlite`).
- **Capacitor descartado** (decisão do dono, junto com o design do app).
- **Hospedagem da API**: Vercel (endereço configurado no login, sem default
  no código) — o celular sincroniza via `POST /api/sync` +
  `Authorization: Bearer` (APK não carrega credenciais do Turso); token do
  login vai no SecureStore.
- Build focado em `arm64-v8a` (celular do dono).
- Designs finais da UI ainda a definir pelo dono.

---

## 🚦 Fases (ordem proposta)

| # | Fase | Status |
|---|------|--------|
| 1 | **Sync engine + `/api/sync`** — contrato em `docs/SYNC.md`; motor como biblioteca + testes e2e (15/15 e 17/17, já com sync do histórico de versões) | ✅ |
| 2 | **App Linux (Electron)** — sidecar Next + SQLite local + sync em background; bootado e sincronizado em ambiente de teste | 🔨 falta gerar o `.deb` **na máquina x86 do dono** |
| 3 | **Empacotamento Linux** — `electron-builder`: **.deb** (pipeline provado; `npm run electron:deb` no PC do dono) | 🔨 |
| 4 | **App Android (Expo)** — base técnica feita: réplica expo-sqlite sincronizando via `POST /api/sync` + Bearer (e2e 12/12); UI nativa com os designs do dono | 🔨 base pronta, UI pendente |

### Concluído
- ✅ Sync do histórico de versões (`note_versions`) no motor — marca d'água `created_at`, bootstrap backfilla o histórico inteiro no desktop (v1.1)
- ✅ Bugs críticos: reversão de updates otimistas, AbortController na busca (`f59427b`)
- ✅ Segurança: JWT_SECRET obrigatório, `middleware.ts`→`proxy.ts` (Next 16), SSRF no `/api/metadata`, rate limit no login (`a6f3f36`)
- ✅ Remoção do driver Box (só R2 + fallback local), coluna `box_file_id`→`storage_key`, `npm run db:rebuild` (`823c0c1`)

---

## 📥 Fila de Recursos

> Recursos lembrados/avaliados ainda sem fase definida. Ao analisar cada um,
> decidimos onde encaixa (backend, desktop, mobile ou os três).

### 1. Marcadores automáticos (tags) — `AUTOTAG`
**Status: uploads ✅ e URLs ✅ implementados.**
(`tags`, `note_tags` no Turso com coluna `source` = `file`/`url`, chips nos cards)

**Detecção por URL** (no servidor, ao salvar a nota — `lib/url-autotag.ts`):
JSON-LD `@type` da página → regra por host de vídeo (YouTube/Vimeo) →
fallback `og:type`. Cache em memória de 10 min por URL; falha silenciosa.
*Limitações reais da web:* sites com bloqueio anti-bot (IMDb, Allrecipes)
entregam challenge/403 e ficam sem tag; alguns sites (ex: g1) só expõem
`og:type: article` → classifica como "Artigos".

**Fonte URL** (estende `/api/metadata`, que já baixa o HTML): parsear o
JSON-LD `<script type="application/ld+json">` e ler o `@type`:

| `@type` detectado | Tag automática |
|---|---|
| `Product`, `Offer`, `ProductGroup` | Compras |
| `VideoObject` / YouTube (oEmbed já detectado) | Vídeos |
| `NewsArticle` | Notícias |
| `Article`, `BlogPosting`, `TechArticle` | Artigos |
| Fallback: `og:type`, depois favicon/dominio sem tag | — |

**Fonte upload** (mime/extension já conhecidos em `attachments/upload`):

| Tipo / extensão | Tag automática |
|---|---|
| `audio/*` | Gravações |
| `image/*` | Imagens |
| `video/*` | Vídeos |
| `.key` | Chaves |
| `.pdf`, `.docx`, `.pptx`... (sugestão) | Documentos |

**Persistência** (pensando no sync futuro): tabelas `tags`
(id, nome, kind: auto|user, cor) e `note_tags` (note_id, tag_id).
Tags automáticas aplicadas no salvar/upload; removíveis manualmente.

**Ganhos**: chips de tag nos cards, filtro por tag na lista, tags
pesáveis via FTS5. Encaixa em: backend (detecção + storage), desktop e
mobile (exibição).

### 2. Editor Markdown com preview lado a lado — `MARKDOWN`
**Status: implementado ✅** (split no desktop, abas Editar/Preview no mobile,
`MarkdownView.tsx` reutilizável no app Linux e referência pro mobile).

**Inspiração: Joplin** (editor à esquerda, preview renderizado à direita,
seleção/cópia na direita sem risco de editar).

- Desktop/web: modal da nota com painel dividido — editor markdown à
  esquerda, preview ao vivo somente-leitura à direita
- Mobile: abas de alternância `Editar | Preview`
- Renderização: `react-markdown` + `remark-gfm` (tabelas, riscado,
  checkboxes) — sem HTML cru, XSS-safe por padrão
- Notas antigas (texto puro): continuam idênticas com `breaks: true`
- FTS5 segue indexando o texto-fonte; banco não muda
- Encaixa em: web/desktop (agora, pois o web É o app Linux), mobile
  (React Native tem renderizadores markdown próprios)

### Recursos já existentes (referência do que os apps precisam cobrir)
- Notas: CRUD, cores, fixar, arquivar, masonry
- Busca FTS5 com `bm25` + `snippet()`
- Anexos: imagens (WebP/sharp), áudio (Opus/WebM), streaming com Range/206
- Pré-visualização de links (OpenGraph + YouTube oEmbed)
- Clipboard: colar captura de tela (Ctrl+V)
- Histórico de versões com restauração
- Fechar ao clicar fora; botão voltar nativo no celular via History API
