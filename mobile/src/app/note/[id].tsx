import { Alert, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View, BackHandler, type TextInputInstance } from "react-native";
import { WebView } from "react-native-webview";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import ActionSheet, { type ActionItem } from "../../components/ActionSheet";
import AttachmentStrip, { AudioChip } from "../../components/AttachmentStrip";
import { autoList } from "../../lib/auto-list";
import { bodyToHtml } from "../../lib/markdown-html";
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
  uploadAttachment,
  deleteAttachment,
  listAttachments,
  cachePath,
  cacheExists,
  cacheAttachment,
  type UploadInput,
} from "../../lib/attachments";
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
    (async () => {
      const local = cachePath(att);
      if (await cacheExists.has(att.id, local)) {
        if (active) setUri(local);
      } else {
        const remote = await cacheAttachment(att);
        if (active) setUri(remote);
      }
    })();
    return () => {
      active = false;
    };
  }, [att.id]);

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
  const [showColors, setShowColors] = useState(false);
  const [selOverride, setSelOverride] = useState<{ start: number; end: number } | undefined>();
  const [attachments, setAttachments] = useState<AttachmentRow[]>([]);

  const loadAtts = useCallback(() => {
    if (noteId) void listAttachments(noteId).then(setAttachments);
  }, [noteId]);

  useEffect(() => {
    loadAtts();
  }, [loadAtts]);

  useEffect(() => onSynced(loadAtts), [loadAtts]);

  const imageAttachments = attachments.filter((a) => a.mime_type.startsWith("image/"));
  const audioAttachments = attachments.filter((a) => a.mime_type.startsWith("audio/"));
  // Modo Joplin: existentes abrem em LEITURA (preview markdown, texto
  // selecionável); ✏️ entra em edição. Nota nova abre direto editando.
  const [mode, setMode] = useState<"read" | "edit">("read");

  // lista numerada automática: texto anterior + flag do Enter
  const prevBodyRef = useRef("");
  const enterRef = useRef(false);

  // anexos: gravação de áudio
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [recording, setRecording] = useState(false);
  const [busyAtt, setBusyAtt] = useState(false);
  const recordStartRef = useRef(0);

  const savedRef = useRef<NoteRow | null>(null); // snapshot do que já foi gravado
  const bodyRef = useRef<TextInputInstance | null>(null);
  const latestRef = useRef({ title: "", body: "", color: "default" });
  const apiRef = useRef<SyncApiConfig | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushSave = useCallback(async () => {
    const saved = savedRef.current;
    if (!saved) return;
    const latest = latestRef.current;

    // Nota vazia (título e corpo em branco, sem anexo) → descarta,
    // igual o desktop (sem lixo "Sem título" no banco nem no sync)
    if (latest.title.trim() === "" && latest.body.trim() === "") {
      const { client } = await getDb();
      const atts = await client.execute({
        sql: `SELECT COUNT(*) AS c FROM attachments WHERE note_id = ?`,
        args: [saved.id],
      });
      if (Number(atts.rows[0]?.c ?? 0) === 0) {
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
    if (latest.title !== saved.title) patch.title = latest.title;
    if (latest.body !== saved.body) patch.body = latest.body;
    if (latest.color !== saved.color) patch.color = latest.color;
    if (Object.keys(patch).length === 0) {
      setStatus("saved");
      return;
    }
    setStatus("saving");
    const { client } = await getDb();
    const now = Date.now();
    await updateNote(client, saved.id, patch);
    savedRef.current = { ...saved, ...patch, updated_at: now };
    setStatus("saved");
    notifyLocalChange();
    const cfg = apiRef.current ?? (await getSyncApi());
    if (cfg) {
      apiRef.current = cfg;
      scheduleQuietSync(cfg);
    }
  }, []);

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

  // carrega a nota
  useEffect(() => {
    (async () => {
      const { client } = await getDb();
      const note = noteId ? await getNote(client, noteId) : null;
      if (!note) {
        setMissing(true);
        setLoaded(true);
        return;
      }
      savedRef.current = note;
      latestRef.current = { title: note.title, body: note.body, color: note.color };
      prevBodyRef.current = note.body;
      setTitle(note.title);
      setBody(note.body);
      setColor(note.color);
      apiRef.current = await getSyncApi();
      setLoaded(true);
      // Nota nova/sem nada ou solicitada com edit: abre direto no body
      if ((!note.title && !note.body) || params.mode === "edit" || params.startAudio === "1") {
        setMode("edit");
        setTimeout(() => bodyRef.current?.focus(), 350);
      } else {
        setMode("read");
      }
    })();
  }, [noteId]);

  // Volta pro modo leitura quando entra em edição (gesto de voltar do Android)
  useEffect(() => {
    if (mode !== "edit") return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      switchToRead();
      return true;
    });
    return () => sub.remove();
  }, [mode]);

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
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void flushSave(), 700);
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

  /* ---- Anexos: câmera, galeria e áudio ---- */

  async function runUpload(input: UploadInput): Promise<AttachmentRow | null> {
    if (busyAtt) return null;
    setBusyAtt(true);
    try {
      const att = await uploadAttachment(input);
      loadAtts();
      return att;
    } catch (e) {
      Alert.alert("Anexo", e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusyAtt(false);
    }
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
      const att = await runUpload({ uri, fileName, mimeType, noteId: savedRef.current!.id });
      if (att) {
        // Insere a foto no corpo da nota como Markdown estilo Keep/Joplin
        const imgMarkdown = `\n\n![${att.file_name}](/api/attachments/${att.id})\n\n`;
        const currentBody = latestRef.current.body || "";
        const nextBody = currentBody ? `${currentBody.trimEnd()}${imgMarkdown}` : imgMarkdown.trim();
        touch("body", nextBody);
        loadAtts();
      }
    }
  }

  async function toggleRecording() {
    if (!savedRef.current) return;
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
            noteId: savedRef.current.id,
            durationSeconds: (Date.now() - recordStartRef.current) / 1000,
          });
        }
      } catch (e) {
        console.warn("Falha ao salvar gravação:", e);
      }
      return;
    }
    try {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) {
        Alert.alert("Permissão", "Permissão de microfone necessária para gravar notas de voz.");
        return;
      }
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      recordStartRef.current = Date.now();
      setRecording(true);
    } catch (e) {
      console.warn("Falha ao gravar:", e);
      Alert.alert("Erro ao gravar áudio", e instanceof Error ? e.message : String(e));
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
          {mode === "edit" && (
            <Text style={styles.status}>
              {status === "saved" ? "Salvo" : status === "saving" ? "Salvando…" : "…"}
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

      {mode === "read" ? (
        /* ---- MODO LEITURA: preview markdown selecionável (estilo desktop) ----
           WebView rola POR DENTRO — dentro de ScrollView ela colapsa a zero */
        <View style={{ flex: 1, paddingHorizontal: 20 }}>
          <Text selectable style={styles.readTitle}>
            {title || "Sem título"}
          </Text>
          <WebView
            source={{ html: bodyToHtml(body), baseUrl: apiRef.current?.baseUrl }}
            style={styles.readBody}
            backgroundColor="transparent"
            javaScriptEnabled={false}
            originWhitelist={["*"]}
            setSupportMultipleWindows={false}
            onShouldStartLoadWithRequest={(req) => {
              // Links do markdown abrem no navegador do sistema
              if (req.url.startsWith("http")) {
                import("react-native").then(({ Linking }) => void Linking.openURL(req.url));
                return false;
              }
              return true;
            }}
          />
          <AttachmentStrip noteId={noteId ?? ""} canEdit />
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

            {/* Audios anexados com player integrado */}
            {audioAttachments.length > 0 && (
              <View style={styles.audioChipsContainer}>
                {audioAttachments.map((audio) => (
                  <AudioChip key={audio.id} att={audio} />
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
          placeholder="Escreva aqui… (markdown; digite um nº + 2 espaços pra lista)"
          placeholderTextColor="#52525b"
          multiline
          textAlignVertical="top"
        />
      </ScrollView>

      <AttachmentStrip noteId={noteId ?? ""} canEdit />

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

      <ActionSheet visible={sheetOpen} items={sheetItems} onClose={() => setSheetOpen(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#101012",
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
    flexDirection: "row",
    flexWrap: "wrap",
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
