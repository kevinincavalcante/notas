# 🗒️ Notas — Gerenciador pessoal para desenvolvedores

Anotações estilo Google Keep com **editor Markdown de verdade**, reconhecimento de código, tags automáticas, abas, pré-visualização rica de links e **sync offline-first** em três plataformas (web, desktop e celular) — tudo custo zero.

Feito pra quem vive no teclado: abrir uma aba, colar um screenshot, gravar um áudio, escrever um snippet com syntax highlighting e achar tudo depois em milissegundos.

---

## ✨ Recursos

### ✍️ Editor focado em código
- **Markdown com 3 modos de visualização**: editar, dividido (split) ou preview — a mesma nota aberta como quiser.
- **Reconhecimento de código**: blocos com syntax highlighting via [highlight.js](https://highlight.js.org), com **detecção automática de linguagem** (nem precisa declarar a crase), gutter de números de linha e botão de copiar.
- Nota com código é **marcada automaticamente** com a tag `Códigos`.
- **Colar screenshot com `Ctrl+V`** direto na nota (clipboard → R2 otimizado).
- **Gravação de áudio** no navegador em Opus/WebM comprimido, com player que suporta pular/seções (HTTP Range).

### 🏷️ Tags automáticas (zero trabalho manual)
- **Por anexo**: mime type / extensão → `Imagens`, `Gravações`, `Documentos`, `Chaves`, `Vídeos`…
- **Por URL**: o servidor lê o **JSON-LD/schema.org** da página vinculada e classifica → `Compras`, `Artigos`, `Notícias`, `Vídeos`… (com cache de 10 min e falha silenciosa — nunca bloqueia o salvamento).
- Funciona igual no web, desktop e mobile (detecção no servidor).
- Cores por nota, fixação (pin) e arquivo (arquivar sem perder).

### 🗂️ Abas estilo Chrome
Abra **várias notas ao mesmo tempo** em abas com largura fixa, título truncado, `×` no hover e botão `+` — fechar aba salva a nota. Navegação de pesquisa/documentação sem perder o contexto.

### 🔗 Pré-visualização rica de links
Cole uma URL e a nota mostra o card pronto: `og:image`, título, descrição e favicon — **YouTube** com thumbnail em HD e nome do canal via oEmbed oficial. Cards clicáveis que abrem em nova aba.

### 🔎 Busca instantânea (FTS5)
Texto completo com **SQLite FTS5**, suporte a prefixos (`termo*`), ranking `bm25` e snippets destacados — sincronizado em tempo real por triggers do banco.

### 🕘 Histórico de versões
Cada atualização relevante gera uma versão da nota — restaure qualquer ponto anterior pelo modal de versões.

---

## 📱 Multiplataforma, offline-first

| Plataforma | O que é | Sync |
|---|---|---|
| **Web** | Next.js 16 hospedado na Vercel | Turso (libSQL remoto) |
| **Desktop** | Electron thin-client: app Next 100% local (sidecar em `127.0.0.1`) | réplica SQLite local ↔ API via HTTP + JWT |
| **Mobile** | App nativo Expo/React Native (APK gerado pelo GitHub Actions) | réplica SQLite local ↔ API via HTTP + JWT |

- **O motor é um só**: web, desktop e mobile usam a **mesma interface `Client`** do libSQL — Turso na nuvem, `file:` no desktop, `expo-sqlite` no celular. O miolo de sync (`lib/sync-core.ts`) e o schema (`lib/db-schema.ts`) são compartilhados de verdade.
- **Fila offline no mobile**: anexos (foto, áudio, arquivo) são **gravados no SQLite na hora** e enfileirados (`pending_attachments`). Sem internet ou com o app suspenso? Nada se perde — o upload roda em segundo plano e a fila é retomada sozinha quando a conexão volta.
- **Deleção vence update**: exclusões propagam como *tombstones* — uma réplica atrasada não ressuscita nota apagada.
- **Zero credenciais nos binários**: o APK e o desktop não carregam token do Turso nem chave do R2 — falam com a API só com o JWT do login. A **URL da API é digitada no login** (nada embutido no código) e fica no cofre do sistema (SecureStore / `safeStorage`).

---

## 🔐 Segurança
- **Usuário único**: credenciais no `.env.local` — hash **Bcrypt** + JWT em cookie `HttpOnly` (web) ou `Authorization: Bearer` (mobile/desktop).
- **Rate limit no login**: 5 tentativas por IP a cada 15 minutos.
- `proxy.ts` intercepta tudo e renova a sessão em 401.
- Token do desktop cifrado com o cofre do SO (`safeStorage`).

---

## 🚀 Como rodar

### 1. Instalar e subir o servidor
```bash
npm install
npm run dev        # http://localhost:3000
```

### 2. Configurar `.env.local`
```bash
cp .env.example .env.local   # e preencha com seus valores
```
| Variável | Pra quê |
|---|---|
| `TURSO_LINK` / `TURSO_TOKEN` | Banco remoto (produção/sync) |
| `APP_USER` + `APP_PASSWORD_HASH` (ou `APP_PASSWORD`) | Login único |
| `JWT_SECRET` | Assinatura da sessão (≥ 32 caracteres, alta entropia) |
| `R2_ENDPOINT` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET_NAME` | Anexos no Cloudflare R2 |

> Sem `JWT_SECRET` em produção o servidor **recusa o start** — sem fallback inseguro.

**Gerar hash de senha:**
```bash
node scripts/hash-password.mjs "sua_senha"
```
(O script já imprime a linha com o escape de `\$` pronto pro parser do Next.)

### 3. Banco
```bash
npm run db:init      # cria tabelas + FTS5 no Turso
npm run db:rebuild   # reconstrói o índice FTS5 se a busca voltar vazia
```

### 4. Mobile (APK Android)
O APK é compilado pelo **GitHub Actions** (`.github/workflows/android.yml`) a cada mudança em `mobile/` e publicado nas Releases — sem margem de erro local. Para build manual:
```bash
scripts/build-apk.sh
```

### 5. Desktop (Electron)
```bash
npm run electron:dev   # desenvolvimento
npm run electron:build # empacotar (electron-builder)
```

---

## 🏗️ Estrutura do projeto

```
app/                  # Web (Next.js App Router) + rotas de API
components/           # UI: abas, editor, preview de links, player, versões…
lib/                  # Domínio compartilhado:
  ├── sync-core.ts    #   miolo puro do sync (usado por web/desktop/mobile)
  ├── db-schema.ts    #   schema único (notes, attachments, FTS5, tombstones…)
  ├── auto-tags.ts    #   regras de tags automáticas (anexos e URLs)
  ├── turso.ts        #   driver: Turso remoto / SQLite local
mobile/               # App Expo (réplica local + fila offline de anexos)
electron/             # Shell desktop (sidecar Next em-processo, thin-client)
docs/                 # Decisões de arquitetura (SYNC, MOBILE, DESKTOP, ROADMAP)
```

Banco principal: `notes`, `attachments`, `note_versions`, `tombstones` e `notes_fts` (FTS5 com triggers `notes_ai/au/ad`).

---

## 📄 Licença
Uso pessoal — sinta-se livre para se inspirar. 🧡
