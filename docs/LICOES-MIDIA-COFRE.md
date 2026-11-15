# 🎓 Lições Aprendidas — Mídia do Cofre "Não Acontecia" (bug de corrida com o autosave)

> **Data**: 15/11/2026 · **Fix**: commit `74aa474` · **APK**: v19
>
> Este bug custou **múltiplas iterações** (v15 → v19) e várias hipóteses erradas
> (renderização da WebView, cache, fila de uploads, DEK). O usuário final foi
> quem achou a pista correta: *"será que é pq quando faz a captura o app já
> fica tentando salvar antes de terminar a criptografia?"* — **era exatamente
> isso**. Documentado aqui para NUNCA repetirmos.

---

## 1. Sintoma

No APK, dentro de notas do **cofre** (cifradas):

- Tira foto / escolhe da galeria / grava áudio → **nada acontece**.
- Sem alerta, sem chip, sem preview, sem erro no servidor.
- Texto do cofre funcionava normalmente (só mídia quebrada).

## 2. Causa raiz: corrida entre autosave em background e descarte de nota vazia

Cadeia exata do desastre:

1. Usuário abre uma **nota nova vazia** e toca em 📷/🖼️.
2. `ImagePicker.launchCameraAsync` / `launchImageLibraryAsync` → **o app Android
   vai para background** (a câmera/galeria é outro processo no primeiro plano).
3. O listener de `AppState` no editor (`note/[id].tsx`) dispara `flushSave()`
   como "rede de segurança" para não perder texto não salvo.
4. O `flushSave` tem uma heurística de limpeza: *"nota vazia (título e corpo em
   branco) e sem anexos → descarta"* (igual ao desktop, para não criar lixo
   "Sem título").
5. **Mas o anexo ainda não existe** — ele está no meio de
   `saveAttachmentLocally`, que para notas do cofre é lento: ler arquivo →
   base64 → **AES-256-GCM em JS (Hermes)** → gravar ciphertext → só então
   `INSERT` em `attachments`. Segundos de janela.
6. Nota apagada (`deleteNote`) + `savedRef.current = null` + tombstone empurrado
   pro servidor.
7. Usuário volta com a foto → `pickImage` continua → `savedRef.current!.id`
   estoura **TypeError em null**.
8. A chamada era `void pickImage(true)` → **a rejeição era engolida**.
   Zero feedback. **"Nada acontece".**
9. Se o anexo chegasse a salvar depois da nota apagada, o
   `processPendingUploads` encontrava `SELECT id FROM notes` vazio e
   **descartava a pendência em silêncio** ("nota deletada").

### Por que SÓ o cofre quebrava

Fora do cofre, `saveAttachmentLocally` é um `copyAsync` de **milissegundos** —
a linha do anexo existe antes de qualquer autosave em background disparar.
No cofre, a criptografia abre uma **janela de segundos** entre "toca em 📷" e
"linha registrada no banco". A corrida existia sempre; no cofre ela perdia.

## 3. Provas (as que levaram ao diagnóstico)

- **`change_log` do Turso**: 6 pares `note upsert → tombstone delete` com
  **~4s de distância** (21:22–21:32) — as 6 tentativas do usuário criando a
  nota e o autosave apagando-a em seguida.
- Uploads cifrados (`storage_key = enc_...`, `enc1:`) só chegaram ao servidor
  quando **não** havia corrida (20:47–20:49) — ou seja, o transporte funcionava.
- Nenhum erro em lugar nenhum — porque o fluxo **morria antes de falhar**.

## 4. Correções (todas em `74aa474`, camadas de proteção)

1. **`mediaInFlightRef`** (contador no editor): enquanto há mídia em voo
   (câmera/galeria abertas, gravando, ou criptografia/upload rodando), o
   `flushSave` **não descarta** a nota como vazia.
   - `pickImage`: incrementa **antes de abrir** a câmera/galeria (é ali que o
     app vai pro fundo), decrementa em `finally` (depois do anexo registrado).
   - `toggleRecording`: incrementa no **início da gravação** (fechar o teclado
     ao tocar no 🎙 também disparava o flush), decrementa após o `runUpload`
     do áudio terminar.
2. **Descarte durável**: o `flushSave` também consulta `pending_attachments`
   (além de `attachments`) antes de descartar — sobrevive a restart do app.
3. **`noteId` capturado no início** de `pickImage`/`toggleRecording` — o fluxo
   não depende mais de `savedRef` no meio (que o autosave podia limpar).
4. **Nunca mais silêncio**: `pickImage` tem try/catch e qualquer falha
   inesperada vira `Alert` (o `void pickImage()` engolia rejeições).
5. **`runUpload` serializa** uploads (promise chain) em vez de
   `if (busyAtt) return null` — que descartava anexo em silêncio quando dois
   fluxos se cruzavam (foto + áudio).

## 5. ⚠️ Contratos para não repetir o bug

Estes invariantes valem para **qualquer** funcionalidade nova (não só mídia):

1. **Nenhuma limpeza/descarte automático pode rodar durante um fluxo
   assíncrono de mídia.** Se uma rotina "de segurança" pode rodar enquanto
   outra coisa está em andamento, ela precisa de um flag de "em voo"
   (contador de referências) que a faça esperar.
2. **Operações que suspendem o app (câmera, galeria, biometria, gravação) são
   pontos de corrida obrigatórios.** Todo listener de `AppState`/
   `BackHandler`/unmount que grava ou limpa estado deve ser auditado contra
   esses fluxos.
3. **Rejeição de promise nunca é engolida.** `void fn()` em async sem
   `.catch` interno = falha invisível para o usuário. Toda função de ação do
   usuário termina em `Alert`/`console.warn` no pior caso.
4. **Descarte de "vazio" confere TODAS as fontes de dados pendentes**
   (tabela principal + filas/pendências), não só o estado em memória.
5. **Capturar ids/refs no início do fluxo** — estado React/refs podem ser
   zerados por um efeito colateral qualquer durante `await`.
6. **`return null` silencioso ≠ tratamento de erro.** Um guard `if (busy)
   return null` descarta trabalho sem ninguém saber. Serialize ou espere.

## 6. Como diagnosticar este tipo de bug (checklist)

Quando "funciona na máquina, não funciona no APK, e sem erro nenhum":

1. **Olhe o `change_log` do servidor** — padrão `upsert` seguido de
   `tombstone/delete` em segundos = algo apagando o que acabou de criar.
2. **Reproduza o SUSPENSÃO do app no raciocínio**: câmera/galeria/biometria
   colocam o app em background — que efeitos rodam nesse momento?
3. **Procure `void fn()` e `catch {}`** nos fluxos de mídia — são os esconderi-
   jos de falha silenciosa.
4. **Meça a diferença de timing entre o caminho comum e o caminho cifrado** —
   corridas aparecem só no caminho lento.
5. Pergunte ao usuário **o relato do timing** ("a nota some?", "aparece e
   some?") — o usuário percebeu o que 5 versões de código não mostraram.

## 7. Comandos úteis da época

```bash
# Conferir padrão upsert→delete no hub (trocar LIMIT conforme precisar)
# (script ad-hoc com @libsql/client lendo .env.local)
npm run build && (npx next start -p 3000 &)   # servidor local p/ E2E
npm run test:vault                             # 20 casos — cofre E2E
npx tsx scripts/test-vault-image.mts           # 8 casos — imagem cifrada E2E
npm run apk                                    # build local ARM → release apk-latest
```

> ⚠️ As suítes de teste do cofre **fazem snapshot e restauram o `vault_meta`
> real** no fim — rodá-las nunca deve destravar a senha do usuário (isso já
> causou lockout real em 14/11/2026; ver histórico do projeto).
