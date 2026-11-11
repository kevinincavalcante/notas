<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# 📝 Notas - Diretrizes para Agentes de IA & Status do Projeto

Este arquivo documenta as diretrizes operacionais, a arquitetura e o estado atual do projeto **Notas** (gerenciador pessoal estilo Google Keep).

---

## 🔑 Autenticação & Como Gerar a Senha

A aplicação utiliza autenticação de usuário único baseada nas variáveis do `.env.local`:
- `APP_USER`: Nome de usuário (ex: `admin`).
- `APP_PASSWORD_HASH`: Hash seguro gerado com Bcrypt.
- `JWT_SECRET`: Chave secreta de alta entropia para assinatura do token de sessão (cookie HttpOnly).
- `APP_PASSWORD` *(opcional)*: Permite definir a senha diretamente em texto puro no `.env.local`.

### ⚠️ Importante sobre o Escape do Bcrypt no Next.js:
O parser de variáveis do Next.js interpreta o cifrão `$` como interpolação (`dotenv-expand`). Portanto, **todo cifrão em hashes Bcrypt dentro do `.env.local` DEVE ter escape com barra invertida `\$`** (exemplo: `APP_PASSWORD_HASH="\$2b\$10\$..."`).

### Comando para gerar nova senha:
```bash
node scripts/hash-password.mjs "sua_nova_senha_aqui"
```
O script já gera a linha com os escapes necessários pronta para ser copiada e colada no `.env.local`. Após alterar, reinicie o servidor de desenvolvimento (`npm run dev`).

---

## 🚀 Status Atual do Projeto (Concluído & Operacional)

### 1. Banco de Dados & Busca FTS5 (Turso / libSQL)
- **Tabelas**:
  - `notes`: Armazena metadados relacionais e conteúdo textual (`id`, `title`, `body`, `color`, `is_pinned`, `is_archived`, `created_at`, `updated_at`).
  - `attachments`: Chave estrangeira para `notes(id)` com `ON DELETE CASCADE`.
  - `notes_fts`: Tabela virtual SQLite **FTS5** com 3 triggers automáticos (`notes_ai`, `notes_au`, `notes_ad`) para sincronização em tempo real.
- **Busca**: Rota `/api/notes/search?q=termo` com suporte a operador `MATCH` com prefixos (`termo*`), ranking `bm25` e destaques com `snippet()`.

### 2. Armazenamento de Anexos (Cloudflare R2 + Sharp)
- **Bucket**: Conectado ao Cloudflare R2 com API S3 via `@aws-sdk/client-s3`.
- **Pipeline de Imagem**: Processamento via `sharp` no servidor com conversão para **WebP**, correção de orientação EXIF e redimensionamento para no máximo 1600px de largura.
- **Gravação de Áudio**: Microfone grava diretamente no navegador em formato comprimido **Opus / WebM**.
- **Streaming**: Rota `/api/attachments/[id]` com suporte a `Range Requests` (HTTP 206) para pausar/avançar áudios e cabeçalhos de cache imutáveis (`Cache-Control: private, max-age=31536000, immutable`).

### 3. Integração com Clipboard & Flameshot (Ctrl+V)
- Suporte a colar capturas de tela diretamente da área de transferência com `Ctrl+V`.
- Funciona tanto na caixa rápida de criação (`QuickNoteCreator`) quanto dentro do modal de qualquer nota (`NoteModal`).
- As capturas coladas são otimizadas e enviadas diretamente para o Cloudflare R2.

### 4. Pré-visualização Rica de Links (OpenGraph & YouTube)
- Rota `/api/metadata?url=...` com detecção automática de links em tempo real.
- **YouTube**: Extração automática via oEmbed oficial com thumbnail em alta definição, nome do canal e ícone oficial.
- **Sites / Artigos**: Extração de `og:image`, `og:title`, descrição e favicon do domínio.
- Os cards são clicáveis e abrem em nova aba sem acionar a abertura do modal da nota.

### 5. Experiência de Usuário (Desktop & Mobile)
- **Fechar ao Clicar Fora**: Clicar na área escura de fundo (backdrop) fecha e salva a nota automaticamente.
- **Botão/Gesto Voltar no Celular**: Integrado com a History API (`window.history.pushState` e `popstate`). Se o usuário apertar o botão ou fizer o gesto nativo de voltar no Android, apenas o modal da nota fecha e salva as alterações, sem sair da página do app.

---

## 🛠️ Comandos Principais

```bash
# Iniciar o servidor de desenvolvimento (Porta 3000)
npm run dev

# Compilar para produção e verificar tipagem
npm run build

# Executar migration no Turso
npm run db:init

# Reconstruir índice FTS5 de busca (se a busca retornar vazio silenciosamente)
npm run db:rebuild

# Gerar hash de senha
node scripts/hash-password.mjs "senha"
```
