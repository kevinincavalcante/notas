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

- **Banco**: adapter trocável em `lib/` —
  - `TursoDriver` (atual, para quando hospedado)
  - `LocalDriver` — SQLite em arquivo local (`better-sqlite3`) dentro do Electron
- **Anexos**: driver de disco local **já existe** em `lib/storage.ts` → passa a
  ser o padrão no desktop; no mobile, armazenamento do app.
- **Motor de sync em TS puro** (compartilhado entre desktop e mobile):
  - cursor incremental: *push* das mudanças locais, *pull* das do servidor
  - resolução de conflito: **LWW por `updated_at`** (usuário único = conflitos raros)
  - **tombstones** para exclusões propagarem corretamente
  - novo endpoint **`/api/sync`** no backend existente
- ⚠️ **Não depender das embedded replicas do libSQL**: os recursos de
  "embedded replica/sync" da Turso mudaram de rumo em 2025 — verificar o estado
  atual antes de considerar. O desenho acima funciona sem eles.

### 3. Android = Expo ou Capacitor (em aberto ⏳)
- **Expo/React Native**: UI nativa nova (o UI React DOM não reaproveita), mas
  o motor de sync e a lógica de domínio são reutilizados (JS puro +
  `expo-sqlite`).
- **Capacitor**: reusa a mesma web UI com muito menos trabalho, menos "nativo".
- **Decidir com o app desktop na mão.**
- Nota para Expo: a API hoje usa cookie `HttpOnly`; o fetch do RN não gerencia
  cookies bem → o `proxy.ts` precisará aceitar `Authorization: Bearer`, token
  guardado no SecureStore.

---

## 🚦 Fases (ordem proposta)

| # | Fase | Status |
|---|------|--------|
| 1 | **Sync engine + `/api/sync`** — contratos de payload, cursor, conflito; fundação de tudo | ⏳ próximo |
| 2 | **App Linux (Electron)** — sidecar Next + DB adapter local + sync no main process | ⏳ |
| 3 | **Empacotamento Linux** — `electron-builder`: `.deb` + `AppImage` | ⏳ |
| 4 | **App Android** — stack decidido na fase 3 | ⏳ |

### Concluído
- ✅ Bugs críticos: reversão de updates otimistas, AbortController na busca (`f59427b`)
- ✅ Segurança: JWT_SECRET obrigatório, `middleware.ts`→`proxy.ts` (Next 16), SSRF no `/api/metadata`, rate limit no login (`a6f3f36`)
- ✅ Remoção do driver Box (só R2 + fallback local), coluna `box_file_id`→`storage_key`, `npm run db:rebuild` (`823c0c1`)

---

## 📥 Fila de Recursos

> Recursos lembrados/avaliados ainda sem fase definida. Ao analisar cada um,
> decidimos onde encaixa (backend, desktop, mobile ou os três).

### 1. Marcadores automáticos (tags) — `AUTOTAG`
**Status: uploads ✅ implementado (`tags`, `note_tags` no Turso, chips nos cards).**
**URLs: pendente.**

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

### Recursos já existentes (referência do que os apps precisam cobrir)
- Notas: CRUD, cores, fixar, arquivar, masonry
- Busca FTS5 com `bm25` + `snippet()`
- Anexos: imagens (WebP/sharp), áudio (Opus/WebM), streaming com Range/206
- Pré-visualização de links (OpenGraph + YouTube oEmbed)
- Clipboard: colar captura de tela (Ctrl+V)
- Histórico de versões com restauração
- Fechar ao clicar fora; botão voltar nativo no celular via History API
