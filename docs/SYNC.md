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
  entity TEXT NOT NULL,                   -- 'note' | 'tag' | 'note_tag' | 'attachment' | 'tombstone'
  entity_id TEXT NOT NULL,
  op TEXT NOT NULL,                       -- 'upsert' | 'delete'
  at INTEGER NOT NULL                     -- Date.now() da mutação
);
```

- Toda mutação de dado (rota de CRUD) grava no `change_log` na mesma transação.
- O cursor de sync é o último `seq` aplicado/acknowledgado de cada réplica par.
- Pull incremental: `SELECT ... WHERE seq > :cursor` — barato e sem relógio compartilhado.

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
    "tombstones": [ { "id": "note-id-apagado", "deleted_at": 1731... } ]
  }
}
```

### Response

```jsonc
{
  "cursor": 87,               // novo watermark: próximo pull começa daqui
  "notes":      [ ...linhas mudadas no servidor desde :cursor... ],
  "tags":       [ ... ],
  "note_tags":  [ ... ],
  "attachments":[ ...metadados... ],
  "tombstones": [ { "id": "...", "deleted_at": ... } ],
  "conflicts":  [ "id-da-nota-que-eu-perdi" ]   // push que perdeu LWW, pra UI reverter otimista
}
```

### Regras de aplicação (nos dois lados)

1. **Upsert** de note/tag/attachment: aplica se `incoming.updated_at > local.updated_at`; senão registra em `conflicts`.
2. **note_tags**: par (note_id, tag_id) é idempotente — `INSERT OR IGNORE`; remoção de vínculo via tombstone de vínculo? Não: vínculos removidos são re-sincronizados por **reconciliação completa** (tags/note_tags são pequenas — o pull pode mandar snapshot cheio quando `cursor = 0` ou a cada N syncs).
3. **Tombstone vence**: se existe tombstone pra `id` com `deleted_at > updated_at` da linha, a linha é ignorada/apagada localmente.
4. **Note nunca é apagada por push de update** — só por tombstone.

## Anexos (binário)

- Estratégia: **download sob demanda** (decisão do usuário).
- Binários vão direto pro **R2** (ambas as réplicas têm as credenciais) — o sync só trafega metadados.
- Upload: o app local grava no R2 + linha local na `attachments`; o sync espalha o metadado.
- Download: app local busca `GET /api/attachments/:id` da réplica remota quando a nota é aberta e o arquivo ainda não está em disco; cache em `~/AppData/notas/attachments/` (naming por plataforma).

## Bootstrap (primeiro boot do desktop)

1. Login → JWT da réplica remota.
2. `POST /api/sync` com `cursor: 0` e push vazio → recebe **tudo** (notas, tags, versões?) + cursor.
3. Anexos: só metadados; binários baixam quando a nota abre.
4. Versões (`note_versions`): **fora do escopo v1** — histórico de versões continua sincronizando só quando criado pela réplica que editou (fase 2 decide).

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
