# Motor de Sincronização — Contrato v1

> Fonte de verdade do protocolo de sync entre réplicas (desktop SQLite ↔ servidor Turso).
> Qualquer app que falar `/api/sync` segue este contrato.

## Princípios

- **Motor próprio em TS puro** — sem embedded replicas do libSQL (Turso mudou de rumo em 2025).
- **Local-first**: toda leitura/escrita do app é no banco local; a rede só entra no sync em background.
- **Réplicas iguais**: qualquer lado pode iniciar o sync (desktop ↔ servidor). O servidor Turso é apenas a réplica "de referência" pra resolução de conflito.
- **LWW** (Last-Write-Wins) por `updated_at` (ms). Empate → **ganha quem recebeu a última escrita no servidor de referência** (a push que chega depois vence com `updated_at` maior; se vier igual, o estado local da referência permanece).
- **Tombstones** para exclusões: nota apagada nunca volta.
- **Falha silenciosa na UI**: sync roda em background; se falha, tenta de novo com backoff. App continua 100% offline.

## Cursor incremental (`change_log`)

Cada réplica mantém uma tabela de log de mudanças:

```sql
CREATE TABLE IF NOT EXISTS change_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,  -- cursor: monotônico por réplica
  entity TEXT NOT NULL,                   -- 'note' | 'attachment' | 'tombstone'
  entity_id TEXT NOT NULL,
  op TEXT NOT NULL,                       -- 'upsert' | 'delete'
  at INTEGER NOT NULL                     -- Date.now() da mutação
);

CREATE TABLE IF NOT EXISTS tombstones (
  id TEXT PRIMARY KEY,
  entity TEXT NOT NULL DEFAULT 'note',
  deleted_at INTEGER NOT NULL
);
```

- Toda mutação de dado (rota de CRUD) grava no `change_log` logo após a escrita
  principal (`lib/sync-log.ts` → `logChange`).
- O cursor de sync é o **maior `seq` global** do log — réplica nunca refaz bootstrap.
- **Cursor 0 = bootstrap**: o log só cobre o futuro, então o pull devolve o
  estado completo (todas as notas, anexos e tombstones).
- **Versões do histórico não entram no `change_log`**: são append-only e
  imutáveis, sincronizadas por marca d'água de `created_at` (seção abaixo).

## Versões do histórico (`note_versions`)

Versões são **append-only e imutáveis** — nunca mudam depois de criadas e só
morrem junto com a nota. Então não precisam de LWW, tombstone nem log:

- Cada réplica guarda em `sync_meta` a marca d'água `sync_versions_watermark`
  = maior `created_at` de versão já presente nela.
- **Push**: a réplica envia versões locais com `created_at >= watermark`
  (notas tombstoned são excluídas). A versão exatamente na fronteira pode ser
  re-enviada a cada ciclo — `INSERT OR IGNORE` no destino deduplica. Preferimos
  re-enviar uma linha a perder uma versão criada no mesmo ms.
- **Pull**: o response traz versões do remoto com
  `created_at >= push.versions_watermark`. Watermark 0 = bootstrap backfilla
  o histórico inteiro (inclusive versões antigas, criadas antes do sync de
  versões existir).
- **FK não é coberta por `INSERT OR IGNORE`**: só entra versão cuja nota
  existe do lado que recebe (`WHERE EXISTS` no push, filtro no pull).
- Ao aplicar tombstone, a réplica apaga as `note_versions` da nota à mão
  (o cascade pode estar desligado no SQLite local).
- **Quem cria versão nova é o remoto, no `applyPush`**: edição vinda de uma
  réplica (mobile/desktop) faz o snapshot do estado anterior do remoto antes
  do `UPDATE` — mesmas regras da rota web `PUT /api/notes/[id]` (só se o
  conteúdo mudou, sem duplicar a última versão, `created_at` = `updated_at`
  do estado anterior). A réplica recebe a versão de volta pelo pull da
  watermark, então o histórico do celular/desktop se enche sozinho.

## Tags e vínculos: estado derivado (não sincronizado)

Tags automáticas são **função determinística do conteúdo** (auto-tags rodam ao
salvar em cada réplica). Sincronizá-las criaria loops (réplica A remove o que a
B re-deriva). Então:

- **Não** entram no push nem no pull incremental
- O response traz **snapshot completo** de `tags` e `note_tags` — serve de
  bootstrap e convergência rápida de leitura
- Após aplicar um push, **cada réplica re-deriva** as auto-tags das notas cujo
  conteúdo mudou (`syncBodyAutoTags`); o servidor faz o mesmo antes de montar
  o response
- Quando existir tag manual do usuário (v1.1), vínculos de tag manual ganham
  tombstone próprio (`entity: 'note_tag'`)

## Endpoint: `POST /api/sync`

Autenticação: mesmo JWT da app (login com APP_USER/senha; token renovado em 401).

### Request

```jsonc
{
  "cursor": 42,               // último seq do servidor que eu já apliquei (0 = bootstrap)
  "push": {                   // minhas mudanças locais desde meu último push (pode ser vazio)
    "notes": [                // linha completa, incluindo created_at/updated_at próprios
      { "id": "...", "title": "...", "body": "...", "color": "default",
        "is_pinned": 0, "is_archived": 0, "created_at": 1731..., "updated_at": 1731... }
    ],
    "note_tags": [ { "note_id": "...", "tag_id": "..." } ],
    "tags": [ { "id": "...", "name": "Códigos", "kind": "auto", "source": "code", "created_at": ... } ],
    "attachments": [          // SÓ METADADOS — binário vai por R2 direto (ambos os lados têm as credenciais)
      { "id": "...", "note_id": "...", "storage_key": "...", "mime_type": "image/webp",
        "size": 12345, "duration": null, "created_at": ... }
    ],
    "tombstones": [ { "id": "note-id-apagado", "deleted_at": 1731... } ],
    "versions": [              // histórico (append-only; ver seção própria)
      { "id": "...", "note_id": "...", "title": "...", "body": "...", "created_at": 1731... }
    ],
    "versions_watermark": 1731 // maior created_at de versão que eu já vi (0 = bootstrap)
  }
}
```

### Response

```jsonc
{
  "cursor": 87,               // novo watermark: maior seq do change_log
  "notes":      [ ...linhas mudadas no servidor desde :cursor... ],
  "attachments":[ ...metadados... ],
  "attachments_removed": [ "id-apagado" ],
  "tombstones": [ { "id": "...", "deleted_at": ... } ],
  "versions":  [ ...versões do remoto com created_at >= versions_watermark do push... ],
  "tags":       [ ...snapshot completo... ],
  "note_tags":  [ ...snapshot completo... ],
  "conflicts":  [ "id-da-nota-que-eu-perdi" ]   // push que perdeu LWW, pra UI reverter otimista
}
```

### Regras de aplicação (nos dois lados)

1. **Upsert** de note: aplica se `incoming.updated_at > local.updated_at`; senão registra em `conflicts`.
2. **Nota inexistente**: entra direto (bootstrap/nova nota da réplica).
3. **Tombstone vence**: tombstone chega primeiro no push; se existe tombstone pra `id` com `deleted_at > updated_at` da linha, a linha é ignorada/apagada localmente.
4. **Anexo é imutável**: metadado com id novo entra (`INSERT OR IGNORE`); existente nunca é sobrescrito (mesmo id = mesmo binário no R2).
5. **Re-derivação de tags**: após aplicar push, notas alteradas passam por `syncBodyAutoTags` localmente.
6. **Tombstone no servidor**: ao receber tombstone, a réplica apaga a nota + os binários do storage e registra no change_log.
7. **Note nunca é apagada por push de update** — só por tombstone.
8. **Versão é append-only**: entra por id novo (`INSERT OR IGNORE`), nunca sobrescreve; só entra se a nota existir do lado que recebe; dedupe por marca d'água de `created_at` (seção própria acima).

## Implementação (código)

| Peça | Onde |
|---|---|
| `logChange(entity, id, op)` | `lib/sync-log.ts` — chamado nas rotas de CRUD |
| Motor server-side (applyPush + collectChanges) | `lib/sync.ts` |
| Rota `POST /api/sync` | `app/api/sync/route.ts` (JWT via proxy) |
| Migração (`change_log`, `tombstones`) | `scripts/init-db.mjs` (`npm run db:init`) |
| Teste ponta a ponta do protocolo | `scripts/test-sync.mts` (`npm run test:sync`) |

Teste atual: **15/15 passando** (bootstrap, push, LWW conflito, update válido, tombstone via push, tombstone via DELETE da API, versões no protocolo). Réplica: **17/17** (inclui backfill de versões antigas, push/pull incremental de versões e idempotência).

## Anexos (binário)

- Estratégia: **download sob demanda** (decisão do usuário).
- Binários vão direto pro **R2** (ambas as réplicas têm as credenciais) — o sync só trafega metadados.
- Upload: o app local grava no R2 + linha local na `attachments`; o sync espalha o metadado.
- Download: app local busca `GET /api/attachments/:id` da réplica remota quando a nota é aberta e o arquivo ainda não está em disco; cache em `~/AppData/notas/attachments/` (naming por plataforma).

## Bootstrap (primeiro boot do desktop)

1. Login → JWT da réplica remota.
2. `POST /api/sync` com `cursor: 0` e push vazio → recebe **tudo** (notas, tags, **versões** — histórico completo) + cursor.
3. Anexos: só metadados; binários baixam quando a nota abre.
4. Versões (`note_versions`): **sincronizadas desde o v1.1** — o bootstrap (watermark 0) backfilla todo o histórico do remoto, e depois o sync incremental troca só versões novas pela marca d'água `created_at`.

## Fluxo do sync em background

```
[app aberto]
   │  (a cada 30s ou após qualquer escrita local, com debounce de 2s)
   ▼
coleta mudanças locais desde último push ──► POST /api/sync ──► aplica response (LWW + tombstones)
   ▲                                                        │
   └──────────── falha? backoff exponencial (5s→30s→2min) ◄──┘
```

## Fila de implementação (ordem)

1. `change_log` + hooks nas rotas de CRUD (web primeiro — o Turso passa a logar).
2. Rota `POST /api/sync` (pull por cursor + push LWW + tombstones).
3. Tabela `tombstones` + hook no `DELETE /api/notes/[id]`.
4. Adaptador local: `lib/turso.ts` ganha modo `file:` (mesma API libSQL) — o app web inteiro roda sobre SQLite sem mudar nada.
5. Cliente de sync do desktop: laço de background, backoff, aplicação de response.
6. Empacotamento Electron (sidecar Next + `.deb` via electron-builder).
