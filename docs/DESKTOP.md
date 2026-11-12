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

## Configuração do app empacotado (thin-client — sem env!)

Na primeira execução o app abre uma **janela de login** (igual ao celular):
endereço da API + usuário + senha. O token fica no cofre do sistema
(`safeStorage`) em `~/.config/Notas/notas-config.json` — **nenhuma credencial
de Turso/R2 mora no disco**.

- **Sync**: via `POST /api/sync` + Bearer (mesmo protocolo do mobile) — polling
  de 30s no processo main, botão ⟳ na barra de abas pra ciclo imediato.
- **CRUD offline**: continua 100% local (sidecar Next + SQLite em
  `~/.config/Notas/notas.db`); o sidecar roda sem tela de login (bind só em
  127.0.0.1).
- **Anexos**: upload/download via proxy do sidecar pra API real — R2 fica só
  na Vercel; streaming com Range (áudio) preservado.
- **Token expirado** (~30 dias): o indicador fica vermelho e a janela de login
  volta (usuário pré-preenchido).

Legado: um `~/.config/Notas/notas.env` antigo ainda é lido como fallback
(ordem: `notas-local.env` gerado > `notas.env`), mas não é mais necessário —
pode apagar. Em dev (`npm run electron:start`), `.env.local` continua válido.

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
