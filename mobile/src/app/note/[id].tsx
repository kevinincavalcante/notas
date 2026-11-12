import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import ActionSheet, { type ActionItem } from "../../components/ActionSheet";
import { autoList } from "../../lib/auto-list";
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
import { notifyLocalChange, scheduleQuietSync, type SyncApiConfig } from "../../lib/sync";
import { getSyncApi } from "../../lib/api";

/**
 * Editor da nota: título + corpo markdown com autosave com debounce
 * e flush no sair da tela (o gesto de voltar do Android fecha e salva,
 * igual no desktop).
 */
export default function NoteScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id: string }>();
  const noteId = params.id;

  const [loaded, setLoaded] = useState(false);
  const [missing, setMissing] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [color, setColor] = useState("default");
  const [status, setStatus] = useState<"saved" | "saving" | "unsaved">("saved");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [selOverride, setSelOverride] = useState<{ start: number; end: number } | undefined>();

  // lista numerada automática: texto anterior + flag do Enter
  const prevBodyRef = useRef("");
  const enterRef = useRef(false);

  const savedRef = useRef<NoteRow | null>(null); // snapshot do que já foi gravado
  const latestRef = useRef({ title: "", body: "", color: "default" });
  const apiRef = useRef<SyncApiConfig | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushSave = useCallback(async () => {
    const saved = savedRef.current;
    if (!saved) return;
    const latest = latestRef.current;
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
    })();
  }, [noteId]);

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
        <Text style={styles.status}>
          {status === "saved" ? "Salvo" : status === "saving" ? "Salvando…" : "…"}
        </Text>
        <Pressable onPress={() => setSheetOpen(true)} hitSlop={10}>
          <Text style={styles.more}>⋯</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <TextInput
          style={styles.titleInput}
          value={title}
          onChangeText={(t) => touch("title", t)}
          placeholder="Título"
          placeholderTextColor="#52525b"
          returnKeyType="done"
        />

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

        <TextInput
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
});
