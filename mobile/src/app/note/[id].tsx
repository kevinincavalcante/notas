import { Alert, AppState, Image, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View, BackHandler, type TextInputInstance } from "react-native";
import { WebView } from "react-native-webview";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ActionSheet, { type ActionItem } from "../../components/ActionSheet";
import { AudioBar, FileChip, shareAttachmentFile } from "../../components/AttachmentStrip";
import VersionHistorySheet from "../../components/VersionHistorySheet";
import { autoList } from "../../lib/auto-list";
import { bodyToHtml } from "../../lib/markdown-html";
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
import { NOTE_COLOR_IDS, NOTE_COLOR_SWATCH } from "../../lib/colors";
import { notifyLocalChange, onSynced, scheduleQuietSync, type SyncApiConfig } from "../../lib/sync";
import { getSyncApi } from "../../lib/api";
import {
  displayUriFor,
  uploadAttachment,
  deleteAttachment,
  listAttachments,
  type UploadInput,
} from "../../lib/attachments";
import {
  decryptAttachmentRow,
  decryptNoteRow,
  getVaultDek,
  isBiometricEnabled,
  unlockVault,
  unlockWithBiometric,
  resetVault,
} from "../../lib/vault";
import { decryptString, encryptString, isEncrypted } from "../../../../lib/vault-crypto";
import type { AttachmentRow } from "../../lib/db";
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import { useAudioRecorder, RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync } from "expo-audio";
import { ActivityIndicator } from "react-native";

/**
 * Editor da nota: título + corpo markdown com autosave com debounce
 * e flush no sair da tela (o gesto de voltar do Android fecha e salva,
 * igual no desktop).
 */
/** Preview amplo de imagem no topo estilo Google Keep (Print 2) */
function KeepTopImage({
  att,
  onRemove,
}: {
  att: AttachmentRow;
  onRemove: () => void;
}) {
  const [uri, setUri] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    // displayUriFor resolve o cache local e, pro anexo do cofre, decifra
    // antes de mostrar (dek em memória)
    void displayUriFor(att).then((resolved) => {
      if (active) setUri(resolved);
    });
    return () => {
      active = false;
    };
  }, [att.id, att.storage_key]);

  if (!uri) {
    return (
      <View style={[styles.topImage, styles.topImageLoading]}>
        <ActivityIndicator size="small" color="#fbbf24" />
      </View>
    );
  }

  return (
    <View style={styles.topImageWrap}>
      <Image source={{ uri }} style={styles.topImage} resizeMode="cover" />
      <Pressable style={styles.topImageRemove} onPress={onRemove} hitSlop={8}>
        <Text style={styles.topImageRemoveText}>✕</Text>
      </Pressable>
    </View>
  );
}

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
  const vaultRef = useRef(false); // a nota em edição é do cofre?
  const [vaultLocked, setVaultLocked] = useState(false);
  const [vaultPass, setVaultPass] = useState("");
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [vaultBusy, setVaultBusy] = useState(false);
  const [vaultBiometric, setVaultBiometric] = useState(false);

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

  // anexos: gravação de áudio
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [recording, setRecording] = useState(false);
  const [busyAtt, setBusyAtt] = useState(false);
  const recordStartRef = useRef(0);
  // Mídia "em voo" (câmera/galeria abertas, gravando ou cifrando/upload).
  // O autosave em background (AppState) não pode descartar a nota como
  // "vazia" nesse período: abrir a câmera levava o app pro fundo, o flush
  // apagava a nota nova antes do anexo do cofre terminar de ser cifrado/salvo
  // e o fluxo morria em silêncio (savedRef nulo) — "nada acontece".
  const mediaInFlightRef = useRef(0);

  const savedRef = useRef<NoteRow | null>(null); // snapshot do que já foi gravado
  const bodyRef = useRef<TextInputInstance | null>(null);
  const latestRef = useRef({ title: "", body: "", color: "default" });
  const apiRef = useRef<SyncApiConfig | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      setVaultError(null);
      setVaultBiometric(await isBiometricEnabled());
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

  // ---- Destravar o cofre de dentro da nota ----
  function handleResetVaultPrompt() {
    Alert.alert(
      "Redefinir cofre",
      "Isso apagará todas as notas do cofre e permitirá cadastrar uma nova senha. Deseja continuar?",
      [
        { text: "Cancelar", style: "cancel" },
        {
          text: "Redefinir",
          style: "destructive",
          onPress: () => {
            void (async () => {
              await resetVault();
              setVaultError(null);
              setVaultPass("");
              router.back();
            })();
          },
        },
      ]
    );
  }

  async function handleVaultUnlock() {
    if (vaultBusy) return;
    setVaultError(null);
    setVaultBusy(true);
    try {
      const ok = await unlockVault(vaultPass);
      if (!ok) {
        setVaultError("Senha incorreta.");
        return;
      }
      setVaultPass("");
      await loadNote();
    } catch (e) {
      setVaultError(e instanceof Error ? e.message : String(e));
    } finally {
      setVaultBusy(false);
    }
  }

  async function handleVaultUnlockBiometric() {
    if (vaultBusy) return;
    setVaultError(null);
    setVaultBusy(true);
    try {
      const ok = await unlockWithBiometric();
      if (!ok) {
        setVaultError("Biometria falhou — use a senha.");
        return;
      }
      await loadNote();
    } catch (e) {
      setVaultError(e instanceof Error ? e.message : String(e));
    } finally {
      setVaultBusy(false);
    }
  }

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

  /* ---- Anexos: câmera, galeria e áudio ---- */

  // Uploads serializados: o guard antigo "busyAtt → return null" DESCARTAVA
  // o anexo em silêncio quando dois fluxos se cruzavam (foto + áudio)
  const uploadChainRef = useRef<Promise<unknown>>(Promise.resolve());

  async function runUpload(input: UploadInput): Promise<AttachmentRow | null> {
    const run = async (): Promise<AttachmentRow | null> => {
      setBusyAtt(true);
      try {
        const att = await uploadAttachment(input);
        // Reflete na hora no editor + pré-aquece o cache de exibição do anexo
        // novo (o chip/foto aparece sem esperar o próximo sync)
        loadAtts();
        if (att) void displayUriFor(att);
        return att;
      } catch (e) {
        Alert.alert("Anexo", e instanceof Error ? e.message : String(e));
        return null;
      } finally {
        setBusyAtt(false);
      }
    };
    const next = uploadChainRef.current.then(run, run);
    uploadChainRef.current = next.catch(() => {});
    return next;
  }

  async function handleRemoveAttachment(att: AttachmentRow) {
    try {
      await deleteAttachment(att);
      setAttachments((prev) => prev.filter((a) => a.id !== att.id));
      const regex = new RegExp(`!?\\[[^\\]]*\\]\\(/api/attachments/${att.id}\\)\\n*`, "g");
      const current = latestRef.current.body || "";
      const nextBody = current.replace(regex, "").trim();
      if (nextBody !== current) {
        touch("body", nextBody);
      }
      notifyLocalChange();
      scheduleQuiet();
    } catch (e) {
      console.warn("Falha ao remover anexo:", e);
    }
  }

  async function pickImage(useCamera: boolean) {
    if (!savedRef.current) return;
    // Captura o id AGORA: abrir a câmera/galeria joga o app pro fundo e o
    // autosave roda — não depender de savedRef depois desse ponto.
    const noteId = savedRef.current.id;
    // Cofre: DEK tem que estar em memória ANTES de abrir a câmera — a Activity
    // do Android suspende o app e, se o auto-lock tiver zerado a chave, o
    // upload falharia silencioso lá na frente. Falha cedo, mensagem clara.
    if (vaultRef.current && !getVaultDek()) {
      Alert.alert(
        "Cofre travado",
        "O cofre foi travado (auto-lock). Saia da nota e destrave o cofre para anexar mídia.",
        [{ text: "OK" }]
      );
      return;
    }
    // Permissões ANTES de abrir a câmera/galeria — negação sem mensagem
    // confunde o usuário com "mídia não salva".
    if (useCamera) {
      const cam = await ImagePicker.requestCameraPermissionsAsync();
      if (!cam.granted) {
        Alert.alert(
          "Permissão de câmera",
          "O app não tem permissão para usar a câmera. Libere em Ajustes → Apps → Notas → Permissões.",
          [{ text: "OK" }]
        );
        return;
      }
    }
    // A partir daqui a câmera/galeria abre e o app vai pro fundo: o
    // mediaInFlightRef mantém a nota viva até o anexo estar registrado
    mediaInFlightRef.current += 1;
    try {
      const result = useCamera
        ? await ImagePicker.launchCameraAsync({ quality: 0.9 })
        : await ImagePicker.launchImageLibraryAsync({ quality: 0.9, selectionLimit: 5 });
      if (result.canceled || result.assets.length === 0) return;

      for (const asset of result.assets) {
        // Compressão no cliente (1600px/webp) — sobe pequeno, sharp afina no servidor
        let uri = asset.uri;
        let fileName = asset.fileName || `foto-${Date.now()}.jpg`;
        let mimeType = asset.mimeType || "image/jpeg";
        if (mimeType.startsWith("image/")) {
          try {
            const out = await ImageManipulator.manipulateAsync(
              asset.uri,
              [{ resize: { width: 1600 } }],
              { compress: 0.8, format: ImageManipulator.SaveFormat.WEBP }
            );
            uri = out.uri;
            fileName = fileName.replace(/\.[^.]+$/, "") + ".webp";
            mimeType = "image/webp";
          } catch (e) {
            console.warn("Compressão falhou, enviando original:", e);
          }
        }
        const att = await runUpload({
          uri,
          fileName,
          mimeType,
          noteId,
          // Nota do cofre: bytes/nome/mime saem cifrados (runUpload só repassa)
          encrypted: vaultRef.current || Boolean(savedRef.current?.is_vault) || undefined,
        });
        if (att) {
          // O file_name do anexo cifrado volta encriptado — o markdown do corpo
          // mantém o nome legível (a troca de uri é só na exibição, via displayUriFor)
          const dek = getVaultDek();
          const displayName =
            dek && isEncrypted(att.file_name)
              ? (() => {
                  try {
                    return decryptString(dek, att.file_name);
                  } catch {
                    return "arquivo";
                  }
                })()
              : att.file_name;
          // Insere a foto no corpo da nota como Markdown estilo Keep/Joplin
          const imgMarkdown = `\n\n![${displayName}](/api/attachments/${att.id})\n\n`;
          const currentBody = latestRef.current.body || "";
          const nextBody = currentBody ? `${currentBody.trimEnd()}${imgMarkdown}` : imgMarkdown.trim();
          touch("body", nextBody);
          loadAtts();
        }
      }
    } catch (e) {
      // Nunca em silêncio: o `void pickImage()` engolia rejeições e o usuário
      // só via "nada acontece" — qualquer falha inesperada vira alerta.
      console.warn("Falha ao anexar mídia:", e);
      Alert.alert("Anexo", e instanceof Error ? e.message : String(e));
    } finally {
      mediaInFlightRef.current -= 1;
    }
  }

  async function toggleRecording() {
    if (!savedRef.current) return;
    // Captura o id AGORA: o autosave em background pode rodar durante a
    // gravação/criptografia e não depender de savedRef depois desse ponto.
    const noteId = savedRef.current.id;
    if (recording) {
      setRecording(false);
      try {
        await recorder.stop();
        const uri = recorder.uri;
        if (uri) {
          await runUpload({
            uri,
            fileName: `audio-${Date.now()}.m4a`,
            mimeType: "audio/mp4",
            noteId,
            durationSeconds: (Date.now() - recordStartRef.current) / 1000,
            // Nota do cofre: áudio também sai cifrado
            encrypted: vaultRef.current || Boolean(savedRef.current?.is_vault) || undefined,
          });
        }
      } catch (e) {
        console.warn("Falha ao salvar gravação:", e);
        Alert.alert("Erro ao salvar áudio", e instanceof Error ? e.message : String(e));
      } finally {
        // Só solta a nota "em voo" depois do anexo registrado (fim da
        // criptografia/upload local) — o descarte de nota vazia espera
        mediaInFlightRef.current = Math.max(0, mediaInFlightRef.current - 1);
      }
      return;
    }
    // Cofre: DEK em memória ANTES de gravar (mesma proteção do pickImage)
    if (vaultRef.current && !getVaultDek()) {
      Alert.alert(
        "Cofre travado",
        "O cofre foi travado (auto-lock). Saia da nota e destrave o cofre para gravar áudio.",
        [{ text: "OK" }]
      );
      return;
    }
    // A gravação segura a nota "em voo" desde o início (o teclado fecha ao
    // tocar no 🎙 e o autosave disparava o descarte da nota vazia no meio)
    mediaInFlightRef.current += 1;
    let started = false;
    try {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(
          "Permissão de microfone",
          "O app não tem permissão para usar o microfone. Libere em Ajustes → Apps → Notas → Permissões para gravar notas de voz.",
          [{ text: "OK" }]
        );
        return;
      }
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      recordStartRef.current = Date.now();
      setRecording(true);
      started = true;
    } catch (e) {
      console.warn("Falha ao gravar:", e);
      Alert.alert("Erro ao gravar áudio", e instanceof Error ? e.message : String(e));
    } finally {
      if (!started) mediaInFlightRef.current = Math.max(0, mediaInFlightRef.current - 1);
    }
  }

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
      <View style={[styles.root, styles.center, styles.lockWrap]}>
        <Text style={styles.lockTitle}>🔒 Cofre travado</Text>
        <Text style={styles.lockHint}>
          Esta nota está no cofre. Digite a senha para ler.
        </Text>

        <TextInput
          style={styles.input}
          placeholder="Senha do cofre"
          placeholderTextColor="#71717a"
          secureTextEntry
          value={vaultPass}
          onChangeText={setVaultPass}
          editable={!vaultBusy}
          onSubmitEditing={() => void handleVaultUnlock()}
        />

        <Pressable
          style={[styles.button, vaultBusy && { opacity: 0.7 }]}
          onPress={() => void handleVaultUnlock()}
          disabled={vaultBusy}
        >
          {vaultBusy ? (
            <ActivityIndicator size="small" color="#18181b" />
          ) : (
            <Text style={styles.buttonText}>Destravar</Text>
          )}
        </Pressable>

        {vaultBiometric && !vaultBusy && (
          <Pressable style={styles.ghostButton} onPress={() => void handleVaultUnlockBiometric()}>
            <Text style={styles.ghostButtonText}>🔓 Desbloquear com biometria</Text>
          </Pressable>
        )}

        {vaultError && (
          <View style={{ alignItems: "center", marginTop: 8 }}>
            <Text style={styles.error}>{vaultError}</Text>
            <Pressable onPress={handleResetVaultPrompt} style={{ marginTop: 10 }} hitSlop={8}>
              <Text style={{ color: "#ef4444", fontSize: 13, textDecorationLine: "underline" }}>
                Esqueceu a senha? Redefinir cofre
              </Text>
            </Pressable>
          </View>
        )}

        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Text style={styles.link}>Voltar</Text>
        </Pressable>
      </View>
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
        /* ---- MODO LEITURA: preview markdown selecionável (estilo desktop) ----
           WebView rola POR DENTRO — dentro de ScrollView ela colapsa a zero */
        <View style={{ flex: 1, paddingHorizontal: 20 }}>
          <Text selectable style={styles.readTitle}>
            {title || "Sem título"}
          </Text>
          {/* Áudio e arquivos no corpo da leitura (igual fotos inline) */}
          {(audioAttachments.length > 0 || fileAttachments.length > 0) && (
            <View style={styles.audioChipsContainer}>
              {audioAttachments.map((audio) => (
                <AudioBar key={audio.id} att={audio} />
              ))}
              {/* Arquivos REFERENCIADOS no corpo viram chip DENTRO do
                  WebView (notasfile://) — aqui só os avulsos */}
              {fileAttachments
                .filter((file) => !bodyImgIds.includes(file.id))
                .map((file) => (
                  <FileChip key={file.id} att={file} />
                ))}
            </View>
          )}
          {/* Mídias do corpo ainda baixando/decifrando: indicador + previews
              NATIVOS no lugar da WebView (instantâneos, sem depender dela) */}
          {bodyUrisPending.length > 0 ? (
            <View style={{ flex: 1 }}>
              <View style={styles.decryptingRow}>
                <ActivityIndicator size="small" color="#fbbf24" />
                <Text style={styles.decryptingText}>
                  Descriptografando mídias… ({Math.max(0, imageAttachments.length - bodyUrisPending.length)}/{imageAttachments.length})
                </Text>
              </View>
              <ScrollView contentContainerStyle={{ paddingHorizontal: 0 }}>
                {imageAttachments.map((img) => (
                  <KeepTopImage key={img.id} att={img} onRemove={() => {}} />
                ))}
              </ScrollView>
            </View>
          ) : (
          <WebView
            key={`read-${bodyUrisSignature}-${Object.keys(linkMetaMap).length}`}
            source={{ html: bodyToHtml(body, bodyImgUris, linkMetaMap), baseUrl: "file:///" }}
            style={styles.readBody}
            backgroundColor="transparent"
            javaScriptEnabled={false}
            originWhitelist={["*"]}
            allowFileAccess={true}
            setSupportMultipleWindows={false}
            onShouldStartLoadWithRequest={(req) => {
              // Chip de ARQUIVO no corpo: decifra em memória e abre o
              // compartilhar do Android (salvar em Arquivos, enviar...)
              if (req.url.startsWith("notasfile://")) {
                const id = req.url.replace("notasfile://", "").split("?")[0];
                const att = attachments.find((a) => a.id === id);
                if (att) void shareAttachmentFile(att);
                return false;
              }
              // Links do markdown abrem no navegador do sistema
              if (req.url.startsWith("http")) {
                import("react-native").then(({ Linking }) => void Linking.openURL(req.url));
                return false;
              }
              return true;
            }}
          />
          )}
        </View>
      ) : (
        /* ---- MODO EDIÇÃO: o editor de sempre ---- */
        <>
          {/* Banner visual durante a gravacao */}
          {recording && (
            <View style={styles.recordingBanner}>
              <View style={styles.recordingDot} />
              <Text style={styles.recordingText}>Gravando nota de voz...</Text>
              <Pressable
                style={styles.recordingStopBtn}
                onPress={() => void toggleRecording()}
              >
                <Text style={styles.recordingStopText}>Parar</Text>
              </Pressable>
            </View>
          )}

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
            {audioAttachments.length + fileAttachments.length > 0 && (
              <View style={styles.audioChipsContainer}>
                {audioAttachments.map((audio) => (
                  <AudioBar
                    key={audio.id}
                    att={audio}
                    onRemove={(a) => void handleRemoveAttachment(a)}
                  />
                ))}
                {fileAttachments.map((file) => (
                  <FileChip
                    key={file.id}
                    att={file}
                    onRemove={(a) => void handleRemoveAttachment(a)}
                  />
                ))}
              </View>
            )}

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
          <View style={[styles.toolbar, { paddingBottom: insets.bottom + 8 }]}>
            {showColors && (
              <View style={styles.swatches}>
                {NOTE_COLOR_IDS.map((id) => (
                  <Pressable
                    key={id}
                    onPress={() => pickColor(id)}
                    style={[
                      styles.swatch,
                      { backgroundColor: NOTE_COLOR_SWATCH[id] },
                      color === id && styles.swatchActive,
                    ]}
                  />
                ))}
              </View>
            )}
            <View style={styles.toolbarRow}>
              <View style={styles.toolGroup}>
                {busyAtt ? (
                  <View style={styles.toolBtn}>
                    <ActivityIndicator size="small" color="#fbbf24" />
                  </View>
                ) : (
                  <>
                    <Pressable onPress={() => void pickImage(true)} hitSlop={6} style={({ pressed }) => [styles.toolBtn, pressed && { opacity: 0.8 }]}>
                      <Text style={styles.toolIcon}>📷</Text>
                    </Pressable>
                    <Pressable onPress={() => void pickImage(false)} hitSlop={6} style={({ pressed }) => [styles.toolBtn, pressed && { opacity: 0.8 }]}>
                      <Text style={styles.toolIcon}>🖼️</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => void toggleRecording()}
                      hitSlop={6}
                      style={({ pressed }) => [styles.toolBtn, recording && styles.recordingBtn, pressed && { opacity: 0.8 }]}
                    >
                      <Text style={styles.toolIcon}>{recording ? "⏹" : "🎙"}</Text>
                    </Pressable>
                    <Pressable onPress={() => setShowColors((v) => !v)} hitSlop={6} style={({ pressed }) => [styles.toolBtn, pressed && { opacity: 0.8 }]}>
                      <Text style={styles.toolIcon}>🎨</Text>
                      <View style={[styles.toolDot, { backgroundColor: NOTE_COLOR_SWATCH[color] }]} />
                    </Pressable>
                  </>
                )}
              </View>
              <Pressable
                onPress={() => setSheetOpen(true)}
                hitSlop={6}
                style={({ pressed }) => [styles.toolBtn, pressed && { opacity: 0.8 }]}
              >
                <Text style={styles.toolIcon}>⋯</Text>
              </Pressable>
            </View>
          </View>
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
  readTitle: {
    color: "#fafafa",
    fontSize: 26,
    fontWeight: "700",
    marginBottom: 8,
    paddingHorizontal: 0,
  },
  readBody: {
    flex: 1,
    backgroundColor: "transparent",
  },
  decryptingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 10,
  },
  decryptingText: {
    color: "#a1a1aa",
    fontSize: 13,
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
  swatches: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    paddingVertical: 12,
  },
  swatch: {
    width: 26,
    height: 26,
    borderRadius: 13,
  },
  swatchActive: {
    borderWidth: 2,
    borderColor: "#fbbf24",
  },
  toolbar: {
    backgroundColor: "#18181b",
    borderTopWidth: 1,
    borderTopColor: "#26262a",
    paddingTop: 8,
    paddingHorizontal: 14,
  },
  toolbarRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  toolGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  recordingBtn: {
    backgroundColor: "#450a0a",
    borderColor: "#ef4444",
  },
  toolBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#1c1c1f",
    borderWidth: 1,
    borderColor: "#2c2c31",
    alignItems: "center",
    justifyContent: "center",
  },
  toolIcon: {
    fontSize: 17,
    color: "#d4d4d8",
  },
  toolDot: {
    position: "absolute",
    right: 6,
    bottom: 6,
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: "#101012",
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
  // ---- Cofre travado (estilos reaproveitados do login do index) ----
  lockWrap: {
    padding: 28,
    alignSelf: "stretch",
    maxWidth: 440,
    width: "100%",
    marginHorizontal: "auto",
  },
  lockTitle: {
    color: "#fafafa",
    fontSize: 24,
    fontWeight: "800",
  },
  lockHint: {
    color: "#71717a",
    fontSize: 13.5,
    textAlign: "center",
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: "#2c2c31",
    borderRadius: 12,
    backgroundColor: "#1c1c1f",
    color: "#fafafa",
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    alignSelf: "stretch",
  },
  button: {
    backgroundColor: "#fbbf24",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    alignSelf: "stretch",
    marginTop: 6,
  },
  buttonText: {
    color: "#1c1917",
    fontWeight: "700",
    fontSize: 16,
  },
  ghostButton: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#2c2c31",
    backgroundColor: "#1c1c1f",
    paddingVertical: 13,
    alignItems: "center",
    alignSelf: "stretch",
  },
  ghostButtonText: {
    color: "#e4e4e7",
    fontWeight: "600",
    fontSize: 14.5,
  },
  error: {
    color: "#f87171",
    fontSize: 13,
  },
  topImagesContainer: {
    gap: 12,
    marginBottom: 14,
    marginTop: 6,
  },
  topImageWrap: {
    position: "relative",
    borderRadius: 16,
    overflow: "hidden",
    backgroundColor: "#1c1c1f",
    borderWidth: 1,
    borderColor: "#27272a",
  },
  topImage: {
    width: "100%",
    height: 250,
    borderRadius: 16,
  },
  topImageLoading: {
    alignItems: "center",
    justifyContent: "center",
  },
  topImageRemove: {
    position: "absolute",
    top: 10,
    right: 10,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "rgba(0,0,0,0.65)",
    alignItems: "center",
    justifyContent: "center",
  },
  topImageRemoveText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "700",
  },
  audioChipsContainer: {
    flexDirection: "column",
    gap: 8,
    marginBottom: 12,
  },
  recordingBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#450a0a",
    borderWidth: 1,
    borderColor: "#ef4444",
    borderRadius: 12,
    marginHorizontal: 16,
    marginBottom: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  recordingDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#ef4444",
    marginRight: 8,
  },
  recordingText: {
    color: "#fecaca",
    fontSize: 13,
    fontWeight: "600",
    flex: 1,
  },
  recordingStopBtn: {
    backgroundColor: "#ef4444",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  recordingStopText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "700",
  },
});
