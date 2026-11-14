# 🔐 Cofre — Notas criptografadas (AES-256-GCM)

Área de notas com criptografia ponta-a-ponta: o servidor (Turso/R2) e os
bancos locais (desktop/mobile) guardam **apenas ciphertext**. A busca FTS5
nunca vê plaintext de notas do cofre — a busca lá é client-side em memória.

## Modelo de segurança (modelo B — cifra 100% no cliente)

```
senha do cofre ──PBKDF2-SHA256──▶ KEK ──desembrulha──▶ DEK ──AES-256-GCM──▶ conteúdo
```

- A senha **nunca sai do dispositivo** e não é armazenada em lugar algum.
- A `DEK` (32 bytes, aleatória) cifra de fato tudo: title/body de `notes`,
  `note_versions` e binários de anexos.
- A DEK viaja **embrulhada** pela KEK em `vault_meta` (salt + iterações +
  `wrapped_dek`) — trocar a senha re-embrulha a mesma DEK, sem re-criptografar
  nada. Falha de desembrulhar = senha errada (não há "verificação" separada).
- `vault_meta` sincroniza como entidade do protocolo (LWW por `updated_at`),
  então qualquer dispositivo destrava digitando a mesma senha.
- A chave destravada vive **só em memória**: web/desktop têm auto-lock por
  inatividade (10 min); o mobile usa biometria (ver abaixo).

## Marcação das notas

- `notes.is_vault` (INTEGER, padrão 0) — segue o padrão de `is_pinned`.
- Ciphertext reconhecível pelo prefixo `enc1:<iv_b64>:<ct_b64>`
  (`lib/vault-crypto.ts` → `CIPHER_PREFIX`/`isEncrypted`).
- Anexos do cofre: binário cifrado no storage (`enc_<uuid>` no R2, sem nome
  real), `file_name` e `mime_type` cifrados nas linhas de `attachments`.
  `duration_seconds` (áudio) fica em claro — metadado fraco, aceito na v1.

## Integração com o sync

Protocolo intocado: ciphertext é só TEXT. `vault_meta` é uma entidade nova
(`SyncPush.vault_meta`), LWW por `updated_at`. Notas do cofre **pulam
auto-tags** (derivação de tags de URL faz sentido só sobre plaintext).

## Busca

- Triggers FTS5 (`notes_ai/au/ad`) **excluem** `is_vault = 1` do índice —
  incluindo no UPDATE: nota que ENTRA no cofre sai do índice na hora.
- ⚠️ O `'delete'` do FTS5 external-content **erra** ("database disk image is
  malformed") se a linha nunca foi indexada — por isso o delete do estado
  antigo só roda quando `old.is_vault = 0` (a linha ESTAVA indexada).
- `GET /api/notes/search` filtra `n.is_vault = 0`; a busca do cofre roda em
  memória no cliente sobre as notas descriptografadas.

## Fluxos implementados (web/desktop)

- **Criar cofre / destravar**: modal global (`components/VaultProvider.tsx`),
  também acessível por `ensureUnlocked()` — usado ao mover uma nota pro cofre.
- **Aba `/vault`**: lista de notas descriptografadas, busca local, criar nota
  (já nasce cifrada), editar via `NoteModal` (PATCH sempre cifra), trocar
  senha, travar, remover do cofre (descriptografa campos + versões + re-envia
  anexos em claro).
- **Mover para o cofre** (context menu do Sidebar): cifra versões
  (`POST /api/notes/[id]/versions/reencrypt`), re-envia anexos cifrados e
  PATCH `{ title: enc, body: enc, is_vault: true }`.
- **Anexos**: `uploadEncryptedFile` cifra bytes + metadados no cliente e envia
  `encrypted=1` (o servidor pula o `sharp`, usa key neutra e não anexa
  auto-tag). Exibição: blob URLs descriptografados em memória
  (`getVaultMediaUrl`).

## Mobile (APK)

Igual na web + **biometria**: após o primeiro destravamento por senha, a DEK
pode ser guardada no SecureStore (`notas_vault_dek`); destravar pede
`expo-local-authentication` e lê a DEK. Tela própria (`mobile/src/app/vault.tsx`).

## Rotas novas

| Rota | Uso |
|---|---|
| `GET /api/vault` | material do cofre (`{ setup: true }` se não configurado) |
| `PUT /api/vault` | grava material (409 = material mais novo já existia) |
| `POST /api/notes/[id]/versions/reencrypt` | reescreve versões nas transições |

## Limitações v1

- Áudio do cofre: sem seek por streaming (AES-GCM não permite Range por
  blocos) — baixa e descriptografa inteiro antes de tocar.
- `duration_seconds` e `created_at` dos anexos ficam em claro.
- Notas do cofre não têm auto-tags nem aparecem na busca global (proposital).

## Testes

```bash
npm run test:sync            # protocolo (15 casos)
npm run test:sync:replica    # réplica desktop (17)
npm run test:sync:mobile     # réplica mobile (14)
npm run test:vault           # E2E do cofre (18) — precisa de next start :3000
npm run test:vault:sync      # sync do material do cofre (7)
```

⚠️ Os testes do cofre criam e removem dados no hub — roda-os num momento em que
nada esteja sincronizando (sync de device no meio de um teste pode ressuscitar
o que ele acabou de limpar).
