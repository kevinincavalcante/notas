# Notas - Gerenciador Pessoal de Anotações (Estilo Google Keep)

Gerenciador pessoal de anotações de alto desempenho, custo zero, seguro e com busca rápida em texto completo, imagens otimizadas e notas de áudio.

## 🚀 Arquitetura

- **Front-end & Backend**: Next.js 16 (App Router, Turbopack, Tailwind CSS v4).
- **Banco de Dados Relacional & FTS**: [Turso](https://turso.tech) (libSQL/SQLite) com busca `FTS5` de alta velocidade e sincronização automática via triggers.
- **Armazenamento de Anexos**: [Cloudflare R2](https://developers.cloudflare.com/r2/) (10 GB gratuitos para sempre, sem custo de tráfego, compatível com S3).
- **Otimização de Mídia**: Pipeline no servidor via `sharp` (redimensionamento e conversão WebP) e gravação de áudio no navegador em Opus/WebM.
- **Autenticação**: Usuário único no `.env.local`, Bcrypt e JWT em cookie `HttpOnly`, interceptado por `proxy.ts` (antigo `middleware.ts`, renomeado no Next 16).

---

## 🛠️ Como Iniciar o Projeto

### 1. Iniciar o servidor de desenvolvimento
```bash
npm run dev
```
Acesse: [http://localhost:3000](http://localhost:3000)

### 2. Credenciais de Acesso
- **Usuário padrão**: `admin`
- **Senha padrão**: `admin123`

> ⚠️ Em produção, defina `JWT_SECRET` (chave de alta entropia, mínimo 32 caracteres) no `.env.local` — sem ele, o servidor recusa o start.

Para trocar a sua senha:
```bash
node scripts/hash-password.mjs "sua_nova_senha_aqui"
```

### 3. Reconstruir o índice de busca (FTS5)
Se a busca começar a retornar vazio silenciosamente, o índice FTS5 pode ter dessincronizado da tabela `notes`. Para reconstruí-lo:
```bash
npm run db:rebuild
```

---

## 📦 Armazenamento em Nuvem (Cloudflare R2)

Configurado no `.env.local`:
- `R2_ENDPOINT`: Endpoint S3 do Cloudflare R2
- `R2_ACCESS_KEY_ID`: Chave de acesso R2
- `R2_SECRET_ACCESS_KEY`: Chave secreta R2
- `R2_BUCKET_NAME`: Nome do bucket (ex: `kevinindev`)

---

## 🗄️ Estrutura do Banco de Dados (Turso)

As tabelas criadas no Turso:
- `notes`: `id`, `title`, `body`, `color`, `is_pinned`, `is_archived`, `created_at`, `updated_at`.
- `attachments`: `id`, `note_id`, `storage_key`, `file_name`, `mime_type`, `file_size`, `duration_seconds`, `created_at`.
- `notes_fts`: Tabela virtual SQLite `FTS5` sincronizada via triggers automáticos (`notes_ai`, `notes_au`, `notes_ad`).
