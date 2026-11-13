# 📱 App Mobile (Expo) — Android

App nativo em React Native (Expo SDK 58) na pasta `mobile/`, réplica do mesmo
banco local do desktop: **baixa tudo no SQLite do celular e sincroniza com a
API — funciona 100% offline.**

## Arquitetura

```
web (Next.js) = backend de tudo
   └── POST /api/sync (JWT)
mobile/ = réplica local (expo-sqlite)
   ├── src/lib/sqlite-client.ts  → adaptador expo-sqlite → interface Client
   │                              do libSQL (o motor não sabe a diferença)
   ├── src/lib/sync.ts           → syncOnceHttp: MESMO miolo do desktop
   │                              (lib/sync-core) com remoto via HTTP + Bearer
   └── src/lib/api.ts            → login (JWT no SecureStore), URL da API
```

- **Por que HTTP e não Turso direto**: o APK não pode carregar credenciais do
  Turso (qualquer um extrai do binário). O celular fala com a API hospedada
  (endereço digitado no login — não vem embutido no código) com o mesmo JWT
  da app web.
- **Bearer**: o `proxy.ts` e `lib/auth.ts` aceitam `Authorization: Bearer` além
  do cookie (o login devolve `token` no corpo do JSON).
- **Código compartilhado**: `lib/sync-core.ts` (miolo puro do cliente de sync)
  e `lib/sync-types.ts` (tipos do protocolo) são importados pelo mobile via
  `metro.config.js` (watchFolders). Nada de servidor entra no bundle.
- **Schema local**: o MESMO `lib/db-schema.ts` do desktop (idempotente).

## Comandos (na pasta `mobile/`)

```bash
npm install              # uma vez
npx expo start           # dev server (Expo Go / emulador)
npx expo run:android     # build nativo em dev (precisa Android SDK)
npx expo export --platform android   # bundle de produção de teste
```

Em dev dá pra apontar pra outra API na tela de login ("usar outra API" —
ex: `http://192.168.x.x:3000` pro PC na mesma rede).

## Testes

```bash
npm run test:sync:mobile     # réplica expo-sqlite (shim node:sqlite) ↔ API
npm run test:sync:replica    # réplica desktop ↔ Turso (sem servidor)
npm run test:sync            # protocolo HTTP (precisa do npm run dev)
```

O teste mobile usa um shim de `node:sqlite` com a MESMA API do expo-sqlite
e valida o adaptador + sync completo: bootstrap, push local→remoto, pull
incremental, LWW, tombstones nos dois sentidos, idempotência.

## Build do APK (arm64-v8a)

A gerar: build com EAS ou local (`expo run:android --variant release`), com
`abiFilters` restrito a `arm64-v8a` (o celular do dono). Pendente da fase de UI.

## Estado

- ✅ Base técnica: réplica sincronizando de verdade (e2e 12/12)
- ✅ UI v1 (design do dono, estilo OneNote): blocos recentes + chips de tags na
  horizontal com filtro, long-press (fixar/arquivar/excluir), editor com autosave
  e flush no voltar, busca FTS local, config — sync em background (foreground
  do app + puxar pra recarregar + debounce pós-mutação)
- ⏳ Anexos: câmera/áudio/download sob demanda (fase 4.4)
