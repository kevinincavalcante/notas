import { AppState, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View, BackHandler, type TextInputInstance } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ActionSheet, { type ActionItem } from "../../components/ActionSheet";
import VersionHistorySheet from "../../components/VersionHistorySheet";
import KeepTopImage from "../../components/note/KeepTopImage";
import VaultUnlockGate from "../../components/note/VaultUnlockGate";
import NoteReadMode from "../../components/note/NoteReadMode";
import NoteEditToolbar, { RecordingBanner } from "../../components/note/NoteEditToolbar";
import AttachmentChips from "../../components/note/AttachmentChips";
import { useNoteMedia } from "../../hooks/useNoteMedia";
import { autoList } from "../../lib/auto-list";
import { fetchLinkMeta, isCardWorthy, type LinkMeta } from "../../lib/link-meta";
import { extractUrls } from "../../../../lib/extract-urls";
import {
  deleteNote,
  getDb,
  getNote,
  setNoteArchived,
  setNotePinned,
  updateNote,
  type NotePatch,
  type NoteRow,
} from "../../lib/db";
import { notifyLocalChange, onSynced, scheduleQuietSync, type SyncApiConfig } from "../../lib/sync";
import { getSyncApi } from "../../lib/api";
import { displayUriFor, listAttachments } from "../../lib/attachments";
import { decryptAttachmentRow, decryptNoteRow, getVaultDek } from "../../lib/vault";
import { encryptString } from "../../../../lib/vault-crypto";
import type { AttachmentRow } from "../../lib/db";

/**
 * Editor da nota: título + corpo markdown com autosave com debounce
 * e flush no sair da tela (o gesto de voltar do Android fecha e salva,
 * igual no desktop).
 */

export default function NoteScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id: string; mode?: string; startAudio?: string }>();
  const noteId = params.id;

  const [loaded, setLoaded] = useState(false);
  const [missing, setMissing] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [color, setColor] = useState("default");
  const [status, setStatus] = useState<"saved" | "saving" | "unsaved">("saved");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [showColors, setShowColors] = useState(false);
  const [selOverride, setSelOverride] = useState<{ start: number; end: number } | undefined>();
  const [attachments, setAttachments] = useState<AttachmentRow[]>([]);

  // ---- Cofre: nota cifrada exige DEK em memória antes de qualquer leitura ----
  // (senha/busy/erro/biometria vivem no VaultUnlockGate)
  const vaultRef = useRef(false); // a nota em edição é do cofre?
  const [vaultLocked, setVaultLocked] = useState(false);

  const attsKeyRef = useRef("");
  const loadAtts = useCallback(() => {
    if (!noteId) return;
    void listAttachments(noteId).then((atts) => {
      // Anexos ficam CRUS aqui (file_name/mime cifrados no cofre) — a
      // decifração acontece nos pontos de exibição (filtros, chips, uris)
      // Sem re-render quando nada mudou: um setAttachments novo a cada ciclo
      // de sync re-renderizava o editor inteiro com o teclado aberto
      const key = atts
        .map((a) => `${a.id}:${a.storage_key}:${a.file_size}`)
        .join("|");
      if (key === attsKeyRef.current) return;
      attsKeyRef.current = key;
      setAttachments(atts);
    });
  }, [noteId]);

  useEffect(() => {
    loadAtts();
  }, [loadAtts]);

  useEffect(() => {
    return onSynced(async () => {
      loadAtts();
      if (noteId) {
        try {
          const { client } = await getDb();
          const fresh = await getNote(client, noteId);
          if (!fresh || !fresh.title || latestRef.current.title) return;
          // Nota do cofre: o título chega cifrado — sem dek, nada a fazer
          const dek = getVaultDek();
          if (vaultRef.current && !dek) return;
          const freshTitle = dek ? decryptNoteRow(dek, fresh).title : fresh.title;
          if (freshTitle) {
            setTitle(freshTitle);
            latestRef.current.title = freshTitle;
            if (savedRef.current) savedRef.current.title = freshTitle;
          }
        } catch {
          // ignore
        }
      }
    });
  }, [loadAtts, noteId]);

  // Modo leitura: srcs de imagem do corpo resolvidos pro cache LOCAL
  // (a WebView não tem JWT pra autenticar contra a API remota)
  const [bodyImgUris, setBodyImgUris] = useState<Record<string, string>>({});

  // IDs de imagem no corpo — captura URL RELATIVA (/api/attachments/<uuid>)
  // e ABSOLUTA (nota criada no web: https://host/api/attachments/<uuid>).
  // Anexos do TIPO ARQUIVO (.key, pdf...) ficam FORA: o corpo mostra chip
  // "⬇ Baixar" (notasfile://) — não são mídia pendente nem viram <img>
  const bodyImgIds = useMemo(() => {
    const dek = getVaultDek();
    const ids = new Set<string>();
    for (const m of body.matchAll(/\/api\/attachments\/([0-9a-fA-F-]+)/g)) {
      const id = m[1];
      const att = attachments.find((a) => a.id === id);
      if (att) {
        const v = dek ? decryptAttachmentRow(dek, att) : att;
        const ext = (v.file_name || "").match(/\.([a-zA-Z0-9]{1,8})$/)?.[1]?.toLowerCase();
        if (ext && !["jpg", "jpeg", "png", "webp", "gif", "svg", "bmp"].includes(ext)) continue;
      }
      ids.add(id);
    }
    return Array.from(ids);
  }, [body, attachments]);

  // Mídias do corpo cuja uri local ainda NÃO resolveu (baixando/decifrando)
  const bodyUrisPending = useMemo(
    () => bodyImgIds.filter((id) => attachments.some((a) => a.id === id) && !bodyImgUris[id]),
    [bodyImgIds, attachments, bodyImgUris]
  );

  useEffect(() => {
    let active = true;
    (async () => {
      const map: Record<string, string> = {};
      for (const id of bodyImgIds) {
        const att = attachments.find((a) => a.id === id);
        if (!att) continue;
        // displayUriFor decifra anexos do cofre na hora (o resto é o cache de sempre)
        const uri = await displayUriFor(att);
        if (uri) map[id] = uri;
      }
      if (active) setBodyImgUris(map);
    })();
    return () => {
      active = false;
    };
  }, [bodyImgIds, attachments]);

  // Assinatura das uris resolvidas: muda → a WebView RECARREGA o HTML
  // (senão ela ficava com o HTML inicial de srcs quebrados pra sempre)
  const bodyUrisSignature = useMemo(
    () => bodyImgIds.map((id) => bodyImgUris[id] || "pending").join("|"),
    [bodyImgIds, bodyImgUris]
  );

  // Filtros por tipo: com nota do cofre, mime chega cifrado — a "vista"
  // decifra os metadados em memória (as linhas guardadas continuam cruas)
  const vaultDek = getVaultDek();
  const attView = useCallback(
    (a: AttachmentRow): AttachmentRow => (vaultDek ? decryptAttachmentRow(vaultDek, a) : a),
    [vaultDek]
  );
  const imageAttachments = attachments.filter((a) => {
    const v = attView(a);
    const mime = v.mime_type || "";
    if (mime.startsWith("image/")) return true;
    const name = v.file_name || "";
    return /\.(jpe?g|png|webp|gif|svg|bmp)$/i.test(name);
  });
  const audioAttachments = attachments.filter((a) => {
    const v = attView(a);
    const mime = v.mime_type || "";
    if (mime.startsWith("audio/")) return true;
    const name = v.file_name || "";
    return /\.(m4a|mp3|wav|ogg|aac|flac|webm)$/i.test(name);
  });
  const fileAttachments = attachments.filter((a) => {
    const v = attView(a);
    const mime = v.mime_type || "";
    const name = v.file_name || "";
    const isImg = mime.startsWith("image/") || /\.(jpe?g|png|webp|gif|svg|bmp)$/i.test(name);
    const isAud = mime.startsWith("audio/") || /\.(m4a|mp3|wav|ogg|aac|flac|webm)$/i.test(name);
    return !isImg && !isAud;
  });

  // Modo Joplin: existentes abrem em LEITURA (preview markdown, texto
  // selecionável); ✏️ entra em edição. Nota nova abre direto editando.
  const [mode, setMode] = useState<"read" | "edit">("read");

  // ---- Cards de link estilo WhatsApp (modo leitura) ----
  // Metadados das URLs do corpo (Facebook, Instagram, TikTok...), buscados
  // uma vez por URL (cache em sessão) e injetados como card estático na
  // WebView. Notas do COFRE ficam de fora: buscar preview revelaria a URL
  // do corpo cifrado ao servidor.
  const [linkMetaMap, setLinkMetaMap] = useState<Record<string, LinkMeta>>({});
  const resolvedLinksRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (mode !== "read" || vaultRef.current) return;
    const urls = extractUrls(body).slice(0, 4);
    const pending = urls.filter((u) => !resolvedLinksRef.current.has(u));
    if (pending.length === 0) return;
    let active = true;
    (async () => {
      const results = await Promise.all(pending.map((u) => fetchLinkMeta(u)));
      if (!active) return;
      const map: Record<string, LinkMeta> = {};
      pending.forEach((u, i) => {
        const meta = results[i];
        if (meta && isCardWorthy(meta)) {
          resolvedLinksRef.current.add(u);
          map[u] = meta;
        }
      });
      if (Object.keys(map).length > 0) setLinkMetaMap((prev) => ({ ...prev, ...map }));
    })();
    return () => {
      active = false;
    };
  }, [body, mode]);

  // lista numerada automática: texto anterior + flag do Enter
  const prevBodyRef = useRef("");
  const enterRef = useRef(false);

  const savedRef = useRef<NoteRow | null>(null); // snapshot do que já foi gravado
  const bodyRef = useRef<TextInputInstance | null>(null);
  const latestRef = useRef({ title: "", body: "", color: "default" });
  const apiRef = useRef<SyncApiConfig | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Câmera/galeria/áudio/uploads/remoção — hook dedicado. O mediaInFlight
  // RETORNADO é o mesmo ref lido pelo flushSave abaixo (contrato das
  // Lições Críticas: nada de descarte com mídia em voo).
  const {
    recording,
    busyAtt,
    mediaInFlightRef,
    pickImage,
    toggleRecording,
    handleRemoveAttachment,
  } = useNoteMedia({
    savedRef,
    vaultRef,
    latestRef,
    touch,
    loadAtts,
    scheduleQuiet,
    setAttachments,
  });

  const flushSave = useCallback(async () => {
    const saved = savedRef.current;
    if (!saved) return;
    const latest = latestRef.current;

    // Cofre travado (ex.: auto-lock no background) com a nota aberta:
    // NUNCA gravamos plaintext numa nota do cofre — o texto fica em tela
    // (não salvo) até o usuário destravar de novo
    if (vaultRef.current && !getVaultDek()) {
      setStatus("unsaved");
      return;
    }

    // Nota vazia (título e corpo em branco, sem anexo) → descarta,
    // igual o desktop (sem lixo "Sem título" no banco nem no sync).
    // NUNCA descarta com mídia em voo (mediaInFlightRef) nem com pendências
    // na fila de uploads — era o que apagava a nota nova no intervalo entre
    // abrir a câmera e o anexo do cofre terminar de ser cifrado/salvo.
    if (
      latest.title.trim() === "" &&
      latest.body.trim() === "" &&
      mediaInFlightRef.current === 0
    ) {
      const { client } = await getDb();
      const atts = await client.execute({
        sql: `SELECT COUNT(*) AS c FROM attachments WHERE note_id = ?`,
        args: [saved.id],
      });
      let pendingCount = 0;
      try {
        const pend = await client.execute({
          sql: `SELECT COUNT(*) AS c FROM pending_attachments WHERE note_id = ?`,
          args: [saved.id],
        });
        pendingCount = Number(pend.rows[0]?.c ?? 0);
      } catch {
        // tabela da fila pode ainda não existir
      }
      if (Number(atts.rows[0]?.c ?? 0) === 0 && pendingCount === 0) {
        await deleteNote(client, saved.id);
        savedRef.current = null;
        notifyLocalChange();
        void getSyncApi().then((cfg) => {
          if (cfg) scheduleQuietSync(cfg);
        });
        return;
      }
    }

    const patch: NotePatch = {};
    // Refs locais guardam PLAINTEXT — a cifração (nota do cofre) acontece
    // só no patch final, pra comparação latest !== saved continuar limpa
    const plainPatch: NotePatch = {};
    if (latest.title !== saved.title) {
      plainPatch.title = latest.title;
      patch.title = latest.title;
    }
    if (latest.body !== saved.body) {
      plainPatch.body = latest.body;
      patch.body = latest.body;
    }
    if (latest.color !== saved.color) patch.color = latest.color;
    if (Object.keys(patch).length === 0) {
      setStatus("saved");
      return;
    }
    // Nota do cofre: title/body vão pro banco CIFRADOS (o anexo de attachments
    // e o markdown do corpo continuam com o nome em claro dentro do plaintext)
    const dek = vaultRef.current ? getVaultDek() : null;
    if (dek) {
      if (patch.title !== undefined) patch.title = encryptString(dek, patch.title);
      if (patch.body !== undefined) patch.body = encryptString(dek, patch.body);
    }
    setStatus("saving");
    const { client } = await getDb();
    const now = Date.now();
    await updateNote(client, saved.id, patch);
    savedRef.current = { ...saved, ...plainPatch, updated_at: now };
    setStatus("saved");
    notifyLocalChange();
    const cfg = apiRef.current ?? (await getSyncApi());
    if (cfg) {
      apiRef.current = cfg;
      scheduleQuietSync(cfg);
    }
  }, []);

  // Rede de segurança: app indo pro background (ou usuário trocando de app)
  // com texto não salvo → grava antes de sumir (nada se perde num crash/fetch)
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s !== "active") void flushSave();
    });
    return () => sub.remove();
  }, [flushSave]);

  // Auto-inicia gravacao se foi aberta pelo atalho de audio
  const autoAudioStartedRef = useRef(false);
  useEffect(() => {
    if (params.startAudio === "1" && loaded && !autoAudioStartedRef.current && !recording) {
      autoAudioStartedRef.current = true;
      setTimeout(() => {
        void toggleRecording();
      }, 400);
    }
  }, [params.startAudio, loaded, recording]);

  // carrega a nota (destravar o cofre re-executa pra re-decifrar)
  const loadNote = useCallback(async () => {
    const { client } = await getDb();
    const note = noteId ? await getNote(client, noteId) : null;
    if (!note) {
      setMissing(true);
      setLoaded(true);
      return;
    }
    vaultRef.current = Boolean(note.is_vault);
    const dek = vaultRef.current ? getVaultDek() : null;
    if (vaultRef.current && !dek) {
      // 🔒 Cofre travado: tela de senha e nada é lido/decifrado
      setVaultLocked(true);
      setLoaded(true);
      return;
    }
    setVaultLocked(false);
    // Nota do cofre: refs/estado recebem o CONTEÚDO DESCRIPTOGRAFADO —
    // o banco continua cifrado (a cifração de volta acontece no flushSave)
    const view = dek ? decryptNoteRow(dek, note) : note;
    savedRef.current = view;
    latestRef.current = { title: view.title, body: view.body, color: view.color };
    prevBodyRef.current = view.body;
    setTitle(view.title);
    setBody(view.body);
    setColor(view.color);
    apiRef.current = await getSyncApi();
    // Anexos na mão já pro modo inicial (nota de áudio: corpo vazio,
    // mas tem anexo — não é nota nova, abre em leitura)
    const atts = await listAttachments(noteId);
    setAttachments(atts);
    attsKeyRef.current = atts.map((a) => `${a.id}:${a.storage_key}:${a.file_size}`).join("|");
    setLoaded(true);
    // Nota nova/sem nada (sem texto E sem anexo) ou solicitada com edit:
    // abre direto no body
    if ((!view.title && !view.body && atts.length === 0) || params.mode === "edit" || params.startAudio === "1") {
      setMode("edit");
      setTimeout(() => bodyRef.current?.focus(), 350);
    } else {
      setMode("read");
    }
  }, [noteId, params.mode, params.startAudio]);

  useEffect(() => {
    void loadNote();
  }, [loadNote]);

  // Gesto ou botão de voltar do Android: salva imediatamente e sai da tela
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      void flushSave().finally(() => router.back());
      return true;
    });
    return () => sub.remove();
  }, [flushSave, router]);

  const switchToRead = useCallback(() => {
    void flushSave();
    setMode("read");
  }, [flushSave]);

  // autosave com debounce (título/corpo)
  function touch(text: "title" | "body", value: string) {
    if (text === "title") {
      setTitle(value);
      latestRef.current.title = value;
    } else {
      setBody(value);
      latestRef.current.body = value;
    }
    setStatus("unsaved");
  }

  // lista numerada automática: intercepta a digitação e aplica as regras
  function onBodyChange(text: string) {
    const edit = autoList(prevBodyRef.current, text, { enter: enterRef.current });
    enterRef.current = false;
    if (edit) {
      setBody(edit.text);
      prevBodyRef.current = edit.text;
      if (edit.cursor >= 0) setSelOverride({ start: edit.cursor, end: edit.cursor });
      touch("body", edit.text);
      return;
    }
    prevBodyRef.current = text;
    touch("body", text);
  }

  // sai do modo "cursor empurrado" na primeira seleção que não for a nossa
  function onBodySelection(sel: { start: number; end: number }) {
    setSelOverride((current) =>
      current && current.start === sel.start && current.end === sel.end ? current : undefined
    );
  }

  // sai da tela = salva o que ficou pendente
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      void flushSave();
    };
  }, [flushSave]);

  function pickColor(next: string) {
    setColor(next);
    latestRef.current = { ...latestRef.current, color: next };
    void flushSave();
  }

  async function runSheetAction(fn: (id: string) => Promise<void>) {
    const saved = savedRef.current;
    if (!saved) return;
    await fn(saved.id);
  }

  const saved = savedRef.current;
  const sheetItems: ActionItem[] = saved
    ? [
        {
          label: saved.is_pinned ? "Desafixar" : "Fixar",
          onPress: () => {
            void runSheetAction(async (id) => {
              const { client } = await getDb();
              await setNotePinned(client, id, !saved.is_pinned);
              scheduleQuiet();
            });
          },
        },
        {
          label: "Arquivar",
          onPress: () => {
            void runSheetAction(async (id) => {
              const { client } = await getDb();
              await setNoteArchived(client, id, true);
              scheduleQuiet();
              router.back();
            });
          },
        },
        {
          label: "Histórico de versões",
          onPress: () => {
            setSheetOpen(false);
            setHistoryOpen(true);
          },
        },
        {
          label: "Excluir",
          destructive: true,
          onPress: () => {
            void runSheetAction(async (id) => {
              const { client } = await getDb();
              await deleteNote(client, id);
              scheduleQuiet();
              router.back();
            });
          },
        },
      ]
    : [];

  function scheduleQuiet() {
    void getSyncApi().then((cfg) => {
      if (cfg) {
        apiRef.current = cfg;
        scheduleQuietSync(cfg);
      }
    });
  }

  /** Recarrega a nota do banco local (após restaurar versão remota). */
  async function reloadNote() {
    const saved = savedRef.current;
    if (!saved) return;
    const { client } = await getDb();
    const fresh = await getNote(client, saved.id);
    if (!fresh) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    // Nota do cofre: o conteúdo (e o snapshot restaurado) chega cifrado —
    // a restauração no servidor copia ciphertext→ciphertext, nada quebra
    const dek = getVaultDek();
    if (vaultRef.current && !dek) {
      setVaultLocked(true);
      return;
    }
    const view = dek ? decryptNoteRow(dek, fresh) : fresh;
    savedRef.current = view;
    latestRef.current = { title: view.title, body: view.body, color: view.color };
    prevBodyRef.current = view.body;
    setTitle(view.title);
    setBody(view.body);
    setColor(view.color);
    setStatus("saved");
    setMode("read");
    loadAtts();
  }

  /* ---- Anexos: câmera, galeria e áudio → hook useNoteMedia ---- */

  if (missing) {
    return (
      <View style={[styles.root, styles.center]}>
        <Text style={styles.muted}>Essa nota não existe mais.</Text>
        <Pressable onPress={() => router.back()}>
          <Text style={styles.link}>Voltar</Text>
        </Pressable>
      </View>
    );
  }

  if (!loaded) {
    return (
      <View style={[styles.root, styles.center]}>
        <Text style={styles.muted}>Abrindo…</Text>
      </View>
    );
  }

  // 🔒 Cofre travado: nenhuma nota cifrada é lida antes da senha
  if (vaultLocked) {
    return (
      <VaultUnlockGate onUnlocked={loadNote} onBack={() => router.back()} />
    );
  }

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable
          onPress={() => {
            if (timerRef.current) {
              clearTimeout(timerRef.current);
              timerRef.current = null;
            }
            void flushSave().finally(() => router.back());
          }}
          hitSlop={10}
        >
          <Text style={styles.back}>‹</Text>
        </Pressable>
        <View style={styles.headerRight}>
          {mode === "edit" && status !== "unsaved" && (
            <Text style={styles.status}>
              {status === "saved" ? "Salvo" : status === "saving" ? "Salvando…" : ""}
            </Text>
          )}
          {/* ✏️ modo Joplin: alterna leitura ↔ edição */}
          <Pressable
            onPress={() => (mode === "edit" ? switchToRead() : setMode("edit"))}
            hitSlop={8}
            style={({ pressed }) => [styles.modeBtn, pressed && { opacity: 0.7 }]}
          >
            <Text style={styles.modeIcon}>{mode === "edit" ? "✅" : "✏️"}</Text>
          </Pressable>
          <Pressable onPress={() => setSheetOpen(true)} hitSlop={8}>
            <Text style={styles.more}>⋯</Text>
          </Pressable>
        </View>
      </View>

      {/* Teclado no edge-to-edge (Android 15+/SDK 58): adjustResize não redimensiona
          mais a janela sozinho — o KAV empurra o conteúdo (e a barra do Keep) pra
          cima do teclado, e o ScrollView encolhe em vez de cobrir o texto. */}
      <KeyboardAvoidingView behavior="padding" style={styles.kavAvoid}>
      {mode === "read" ? (
        /* ---- MODO LEITURA: preview markdown selecionável (estilo desktop) ---- */
        <NoteReadMode
          title={title}
          body={body}
          bodyImgUris={bodyImgUris}
          linkMetaMap={linkMetaMap}
          bodyUrisSignature={bodyUrisSignature}
          bodyUrisPending={bodyUrisPending}
          imageAttachments={imageAttachments}
          audioAttachments={audioAttachments}
          fileAttachments={fileAttachments}
          attachments={attachments}
          bodyImgIds={bodyImgIds}
        />
      ) : (
        /* ---- MODO EDIÇÃO: o editor de sempre ---- */
        <>
          {/* Banner visual durante a gravacao */}
          {recording && <RecordingBanner onStop={() => void toggleRecording()} />}

          <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
            {/* Fotos em destaque amplo estilo Google Keep (Print 2) */}
            {imageAttachments.length > 0 && (
              <View style={styles.topImagesContainer}>
                {imageAttachments.map((img) => (
                  <KeepTopImage
                    key={img.id}
                    att={img}
                    onRemove={() => void handleRemoveAttachment(img)}
                  />
                ))}
              </View>
            )}

            {/* Áudio e arquivos no corpo — barras largas estilo fotos */}
            <AttachmentChips
              audioAttachments={audioAttachments}
              fileAttachments={fileAttachments}
              onRemove={(a) => void handleRemoveAttachment(a)}
            />

            <TextInput
              style={styles.titleInput}
              value={title}
              onChangeText={(t) => touch("title", t)}
              placeholder="Título"
              placeholderTextColor="#52525b"
              returnKeyType="done"
            />

            <TextInput
              ref={bodyRef}
              style={styles.bodyInput}
              value={body}
              onChangeText={onBodyChange}
              onSelectionChange={(e) => onBodySelection(e.nativeEvent.selection)}
              onKeyPress={(e) => {
                if (e.nativeEvent.key === "Enter") enterRef.current = true;
              }}
              selection={selOverride}
              placeholder="Digite…"
              placeholderTextColor="#52525b"
              multiline
              textAlignVertical="top"
            />
          </ScrollView>

          {/* Barra inferior estilo Keep: mídia + 🎨 paleta + ⋯ menu */}
          <NoteEditToolbar
            showColors={showColors}
            onToggleColors={() => setShowColors((v) => !v)}
            busyAtt={busyAtt}
            recording={recording}
            onPickImage={(useCamera) => void pickImage(useCamera)}
            onToggleRecording={() => void toggleRecording()}
            onPickColor={pickColor}
            onOpenSheet={() => setSheetOpen(true)}
            color={color}
            bottomInset={insets.bottom}
          />
        </>
      )}
      </KeyboardAvoidingView>

      <ActionSheet visible={sheetOpen} items={sheetItems} onClose={() => setSheetOpen(false)} />
      <VersionHistorySheet
        visible={historyOpen}
        noteId={noteId ?? ""}
        dek={getVaultDek()}
        onClose={() => setHistoryOpen(false)}
        onRestored={() => void reloadNote()}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#101012",
  },
  kavAvoid: {
    flex: 1,
  },
  center: {
    justifyContent: "center",
    alignItems: "center",
    gap: 10,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 6,
  },
  back: {
    color: "#fafafa",
    fontSize: 30,
    paddingHorizontal: 8,
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  modeBtn: {
    padding: 4,
  },
  modeIcon: {
    fontSize: 18,
  },
  status: {
    color: "#71717a",
    fontSize: 12.5,
  },
  more: {
    color: "#d4d4d8",
    fontSize: 22,
    paddingHorizontal: 8,
  },
  scroll: {
    paddingHorizontal: 20,
    paddingBottom: 60,
  },
  titleInput: {
    color: "#fafafa",
    fontSize: 26,
    fontWeight: "700",
    paddingVertical: 10,
    minHeight: 52,
  },
  bodyInput: {
    color: "#e4e4e7",
    fontSize: 15.5,
    lineHeight: 24,
    minHeight: 380,
    paddingTop: 6,
  },
  muted: {
    color: "#71717a",
  },
  link: {
    color: "#60a5fa",
    fontSize: 14,
  },
  topImagesContainer: {
    gap: 12,
    marginBottom: 14,
    marginTop: 6,
  },
});
