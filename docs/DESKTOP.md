# 🖥️ App Desktop (Linux) — Notas

> Electron + Next como sidecar + SQLite local + sync em background.
> Contrato do sync: `docs/SYNC.md`. Roadmap: `docs/ROADMAP.md`.

## Como funciona

```
┌──────────────────────────────────────────────┐
│ Electron (processo main)                     │
│  ├─ notas.env / .env.local → config          │
│  ├─ SQLite local (~/.config/notas/notas.db)  │
│  ├─ Next como sidecar IN-PROCESS             │
│  │   (a MESMA UI web — nada reescrito)       │
│  ├─ BrowserWindow → http://127.0.0.1:porta   │
│  └─ sync a cada 30s (réplica ↔ Turso)        │
└──────────────────────────────────────────────┘
```

- **Todo carregamento é leitura de disco local** — instantâneo, funciona offline
- **Primeiro boot**: o sync baixa tudo do Turso (notas, tags, anexos-metadata)
- **Sync em background** a cada 30s; em falha, backoff até 2min. Se você
  escrever algo e a rede cair, o sync manda quando voltar
- **Conflitos**: LWW por `updated_at` (usuário único = raros)
- **Anexos v1**: vão direto pro R2 (precisa de internet pra inserir/ver
  anexos); notas e tags funcionam 100% offline. Cache local de anexos
  ("sob demanda") entra na fase 2

## Gerar o `.deb` (máquina x86_64)

Os módulos nativos (libsql, sharp) são específicos de arquitetura — gere o
pacote **na sua máquina**, nunca copie o `.deb` de outro ambiente:

```bash
git pull
npm install                      # entra electron, electron-builder, esbuild
npm run electron:deb             # build do Next + bundle do main + .deb em dist/
```

Sai em `dist/notas_<versão>_amd64.deb`:

```bash
sudo dpkg -i dist/notas_1.0.0_amd64.deb
# ou: sudo apt install ./dist/notas_1.0.0_amd64.deb
```

Durante o desenvolvimento (sem empacotar):

```bash
npm run build && npm run electron:bundle
npx electron .                   # roda o app direto do repo
```

## Atalhos de aba (só no desktop)

Estilo browser — o menu nativo do Electron manda os comandos por IPC:

| Atalho | Ação |
|---|---|
| `Ctrl+N` | Nova aba com nota nova (a atual continua aberta) |
| `Ctrl+W` | Fecha a aba atual (salva antes de fechar) |
| `Ctrl+Tab` | Próxima aba |
| `Ctrl+Shift+Tab` | Aba anterior |

No web/navegador esses atalhos pertencem ao browser e não existem conflito —
lá a barra de abas funciona só pelo clique. Nota já aberta clicada na sidebar
vira a aba ativa em vez de abrir duplicada.

## Configuração do app empacotado

Na primeira execução, o app procura a config em
`~/.config/Notas/notas.env` (mesmo formato do `.env.local`). Mínimo:

```env
# Sync (hub remoto das suas notas)
TURSO_LINK=libsql://seu-banco.turso.io
TURSO_TOKEN=eyJ...

# Login local (a UI continua com a tela de login; cookie persiste)
APP_USER=admin
APP_PASSWORD=sua-senha

# Anexos (R2)
R2_ENDPOINT=https://<account>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=notas

# Assinatura do cookie de sessão local
JWT_SECRET=uma-chave-de-alta-entropia

# (opcional) onde fica o banco local — default: ~/.config/Notas/notas.db
# NOTES_DB_PATH=/caminho/notas.db
```

Sem `TURSO_LINK`/`TURSO_TOKEN` o app roda 100% local, sem sincronizar.

## Comandos

| Comando | O que faz |
|---|---|
| `npm run electron:deb` | Build completo + `.deb` em `dist/` |
| `npm run electron:start` | Roda o app Electron direto do repo (build incluso) |
| `npm run electron:bundle` | Só compila o processo main (esbuild → `dist-electron/`) |
| `npm run test:sync` | Teste do protocolo `/api/sync` (12 checks) |
| `npm run test:sync:replica` | Teste da réplica local ↔ Turso (13 checks) |

## Arquitetura (arquivos)

| Arquivo | Papel |
|---|---|
| `electron/main.ts` | Processo main: janela, sidecar Next, laço de sync |
| `electron/env.ts` | Carrega config antes de qualquer lib abrir o banco |
| `lib/turso.ts` | Driver: `NOTES_DB_PATH` → SQLite local; senão Turso |
| `lib/db-schema.ts` | Schema idempotente da réplica local |
| `lib/sync-replica.ts` | Cliente de sync (push LWW, pull, tombstones, backoff) |
| `lib/sync.ts` | Motor compartilhado (também usado por `POST /api/sync`) |
| `electron-builder.yml` | Empacotamento (.deb) |
