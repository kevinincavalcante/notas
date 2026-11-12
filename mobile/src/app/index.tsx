import {
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Client } from "@libsql/client";
import TopBar from "../components/TopBar";
import ChipsRow from "../components/ChipsRow";
import NoteCard from "../components/NoteCard";
import ActionSheet, { type ActionItem } from "../components/ActionSheet";
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import { uploadAttachment } from "../lib/attachments";
import ShareReceiver, { type SharedPayload } from "../../modules/share-receiver";
import {
  createNote,
  updateNote,
  deleteNote,
  getDb,
  listNotes,
  listTags,
  setNoteArchived,
  setNotePinned,
  tagsForNotes,
  type NoteRow,
  type TagRow,
} from "../lib/db";
import {
  DEFAULT_API_URL,
  getApiUrl,
  getStoredToken,
  getStoredUser,
  getSyncApi,
  login,
  setApiUrl,
} from "../lib/api";
import { getLastSync, onSynced, scheduleQuietSync, setLocalClientProvider, syncQuiet, type SyncApiConfig } from "../lib/sync";

/**
 * Home — estilo OneNote: blocos com as notas recentes e chips de
 * marcadores deslizando na horizontal. Long-press: fixar/arquivar/excluir.
 */
export default function HomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  // boot / auth
  const [booted, setBooted] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<string | null>(null);

  // login (só quando sem token)
  const [userInput, setUserInput] = useState("");
  const [passInput, setPassInput] = useState("");
  const [showUrlField, setShowUrlField] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);

  // dados
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [tagsByNote, setTagsByNote] = useState<Record<string, string[]>>({});
  const [tags, setTags] = useState<TagRow[]>([]);
  const [activeTag, setActiveTag] = useState<string | null>(null);

  // sync
  const apiRef = useRef<SyncApiConfig | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [pulling, setPulling] = useState(false); // spinner só no gesto do usuário

  // menu de ações (long-press)
  const [sheetNote, setSheetNote] = useState<NoteRow | null>(null);
  const [createSheetOpen, setCreateSheetOpen] = useState(false);

  const reload = useCallback(async () => {
    try {
      const { client } = await getDb();
      const list = await listNotes(client, activeTag);
      setNotes(list);
      setTagsByNote(await tagsForNotes(client, list.map((n) => n.id)));
      setTags(await listTags(client));
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : String(e));
    }
  }, [activeTag]);

  const runSync = useCallback(async () => {
    const cfg = await getSyncApi();
    if (!cfg) return;
    apiRef.current = cfg;
    setSyncing(true);
    const ok = await syncQuiet(cfg);
    const { error } = getLastSync();
    setSyncError(ok ? null : error || "erro desconhecido");
    setSyncing(false);
  }, []);

  function scheduleSync() {
    const cfg = apiRef.current;
    if (cfg) scheduleQuietSync(cfg);
  }

  // boot: banco + sessão + primeira sync
  useEffect(() => {
    (async () => {
      await getDb(); // força schema/abertura antes de qualquer tela
      setLocalClientProvider(() => getDb().then((d) => d.client));
      const [t, u, url] = await Promise.all([getStoredToken(), getStoredUser(), getApiUrl()]);
      setToken(t);
      setUser(u);
      setUrlInput(url === DEFAULT_API_URL ? "" : url);
      setBooted(true);
      if (t) {
        apiRef.current = { baseUrl: url, token: t };
        setTimeout(() => void runSync(), 1200);
      }
    })();
  }, [runSync]);

  // sync no ciclo de vida: app volta pro foreground → sincroniza
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") void runSync();
    });
    return () => sub.remove();
  }, [runSync]);

  // telas recarregam quando um sync termina
  useEffect(() => onSynced(() => void reload()), [reload]);

  useEffect(() => {
    if (token) void reload();
  }, [token, activeTag, reload]);

  // voltar pro home (do editor/busca) recarrega a lista
  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload])
  );

  async function handleLogin() {
    if (loggingIn) return;
    setLoginError(null);
    setLoggingIn(true);
    try {
      if (showUrlField && urlInput.trim()) {
        await setApiUrl(urlInput);
      }
      const result = await login(userInput, passInput);
      if (result.ok) {
        const [t, u, url] = await Promise.all([getStoredToken(), getStoredUser(), getApiUrl()]);
        const cfg = { baseUrl: url, token: t! };
        apiRef.current = cfg;
        // Puxa as notas antes de trocar de tela para que a Home abra com dados pré-carregados
        await syncQuiet(cfg);
        setToken(t);
        setUser(u);
      } else {
        setLoginError(result.error || "Login falhou.");
      }
    } catch (e) {
      setLoginError(e instanceof Error ? e.message : "Erro ao conectar.");
    } finally {
      setLoggingIn(false);
    }
  }

  async function runSheetAction(note: NoteRow, fn: (client: Client, id: string) => Promise<void>) {
    const { client } = await getDb();
    await fn(client, note.id);
    scheduleSync();
    void reload();
  }

  const sheetNoteRef = sheetNote;
  const sheetItems: ActionItem[] = sheetNoteRef
    ? [
        {
          label: sheetNoteRef.is_pinned ? "Desafixar" : "Fixar",
          onPress: () => {
            void runSheetAction(sheetNoteRef, (client, id) =>
              setNotePinned(client, id, !sheetNoteRef.is_pinned)
            );
          },
        },
        {
          label: "Arquivar",
          onPress: () => {
            void runSheetAction(sheetNoteRef, (client, id) =>
              setNoteArchived(client, id, true)
            );
          },
        },
        {
          label: "Excluir",
          destructive: true,
          onPress: () => {
            void runSheetAction(sheetNoteRef, (client, id) => deleteNote(client, id));
          },
        },
      ]
    : [];

  async function handleCreateNote() {
    const { client } = await getDb();
    const id = await createNote(client);
    scheduleSync();
    void reload();
    router.push(`/note/${id}`);
  }

  async function handleCreateChecklist() {
    const { client } = await getDb();
    const id = await createNote(client, { body: "- [ ] " });
    scheduleSync();
    void reload();
    router.push(`/note/${id}?mode=edit`);
  }

  async function handleCreateAudio() {
    const { client } = await getDb();
    const id = await createNote(client);
    scheduleSync();
    void reload();
    router.push(`/note/${id}?startAudio=1`);
  }

  async function handleCreatePhoto(useCamera: boolean) {
    try {
      const result = useCamera
        ? await ImagePicker.launchCameraAsync({ quality: 0.9 })
        : await ImagePicker.launchImageLibraryAsync({ quality: 0.9, selectionLimit: 5 });
      if (result.canceled || result.assets.length === 0) return;

      const { client } = await getDb();
      const id = await createNote(client);
      let body = "";

      for (const asset of result.assets) {
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
            console.warn("Compressao falhou, enviando original:", e);
          }
        }
        const att = await uploadAttachment({ uri, fileName, mimeType, noteId: id });
        if (att) {
          body = `${body ? body.trimEnd() + "\n\n" : ""}![${att.file_name}](/api/attachments/${att.id})\n\n`;
        }
      }

      if (body.trim()) {
        await updateNote(client, id, { body });
      }
      scheduleSync();
      void reload();
      router.push(`/note/${id}`);
    } catch (e) {
      console.warn("Falha ao criar nota com foto:", e);
      Alert.alert("Erro", e instanceof Error ? e.message : "Não foi possível criar nota com imagem.");
    }
  }

  /** Itens compartilhados de outros apps ("Compartilhar → Notas"). */
  async function handleSharedItems(payload: SharedPayload) {
    try {
      const { client } = await getDb();
      const id = await createNote(client);
      let body = payload.text ?? "";

      for (const file of payload.files) {
        let uri = file.uri;
        let fileName = file.name || `anexo-${Date.now()}`;
        let mimeType = file.mime || "application/octet-stream";
        if (mimeType.startsWith("image/")) {
          try {
            const out = await ImageManipulator.manipulateAsync(
              uri,
              [{ resize: { width: 1600 } }],
              { compress: 0.8, format: ImageManipulator.SaveFormat.WEBP }
            );
            uri = out.uri;
            fileName = fileName.replace(/\.[^.]+$/, "") + ".webp";
            mimeType = "image/webp";
          } catch (e) {
            console.warn("Compressao falhou, enviando original:", e);
          }
        }
        const att = await uploadAttachment({ uri, fileName, mimeType, noteId: id });
        if (att) {
          body = `${body ? body.trimEnd() + "\n\n" : ""}![${att.file_name}](/api/attachments/${att.id})\n\n`;
        }
      }

      if (body.trim()) {
        await updateNote(client, id, { body });
      }
      scheduleSync();
      void reload();
      router.push(`/note/${id}`);
    } catch (e) {
      console.warn("Falha ao receber compartilhamento:", e);
      Alert.alert(
        "Compartilhar",
        e instanceof Error ? e.message : "Não foi possível criar a nota a partir do compartilhamento."
      );
    }
  }

  // Share sheet: cold start (getShared) e app já aberto (listener)
  useEffect(() => {
    void ShareReceiver.getShared().then((payload) => {
      if (payload) void handleSharedItems(payload);
    });
    const sub = ShareReceiver.addListener("onShareReceived", (payload) => {
      void handleSharedItems(payload);
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!booted) {
    return (
      <View style={[styles.root, styles.center]}>
        <Text style={styles.muted}>Abrindo suas notas…</Text>
      </View>
    );
  }

  if (!token) {
    return (
      <View style={[styles.root, styles.center, styles.login]}>
        <Text style={styles.title}>Notas</Text>
        <Text style={styles.subtitle}>{DEFAULT_API_URL}</Text>

        <TextInput
          style={styles.input}
          placeholder="Usuário"
          placeholderTextColor="#71717a"
          autoCapitalize="none"
          value={userInput}
          onChangeText={setUserInput}
          editable={!loggingIn}
        />
        <TextInput
          style={styles.input}
          placeholder="Senha"
          placeholderTextColor="#71717a"
          secureTextEntry
          value={passInput}
          onChangeText={setPassInput}
          editable={!loggingIn}
          onSubmitEditing={() => void handleLogin()}
        />

        <Pressable onPress={() => setShowUrlField((v) => !v)} hitSlop={8} disabled={loggingIn}>
          <Text style={styles.link}>{showUrlField ? "usar API padrão" : "usar outra API"}</Text>
        </Pressable>
        {showUrlField && (
          <TextInput
            style={styles.input}
            placeholder={`URL da API (padrão: ${DEFAULT_API_URL})`}
            placeholderTextColor="#71717a"
            autoCapitalize="none"
            autoCorrect={false}
            value={urlInput}
            onChangeText={setUrlInput}
            editable={!loggingIn}
          />
        )}

        <Pressable
          style={[styles.button, loggingIn && { opacity: 0.7 }]}
          onPress={() => void handleLogin()}
          disabled={loggingIn}
        >
          {loggingIn ? (
            <ActivityIndicator size="small" color="#18181b" />
          ) : (
            <Text style={styles.buttonText}>Entrar</Text>
          )}
        </Pressable>
        {loginError && <Text style={styles.error}>{loginError}</Text>}
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <TopBar
        user={user}
        onAvatar={() => router.push("/config")}
        right={[{ label: "⌕", onPress: () => router.push("/search") }]}
      />
      <ChipsRow tags={tags} active={activeTag} onSelect={setActiveTag} />

      {syncError && (
        <Pressable
          onPress={() => void runSync()}
          style={({ pressed }) => [styles.syncLine, pressed && { opacity: 0.7 }]}
        >
          <Text style={styles.syncError}>
            {`Sync falhou: ${syncError} — toque pra tentar de novo`}
          </Text>
        </Pressable>
      )}

      <FlatList
        data={notes}
        keyExtractor={(item) => item.id}
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 90 }]}
        ListEmptyComponent={
          <View style={styles.empty}>
            {syncing && notes.length === 0 ? (
              <>
                <ActivityIndicator size="small" color="#a1a1aa" />
                <Text style={styles.emptyText}>Sincronizando suas notas…</Text>
              </>
            ) : (
              <>
                <Text style={styles.emptyIcon}>🗒</Text>
                <Text style={styles.emptyText}>
                  {activeTag
                    ? "Nada com esse marcador ainda."
                    : "Nada por aqui — crie sua primeira nota."}
                </Text>
              </>
            )}
            {syncError && <Text style={styles.syncError}>{`Sync falhou: ${syncError}`}</Text>}
          </View>
        }
        refreshControl={
          <RefreshControl
            refreshing={pulling}
            onRefresh={() => {
              setPulling(true);
              void runSync().finally(() => setPulling(false));
            }}
            tintColor="#a1a1aa"
          />
        }
        renderItem={({ item }) => (
          <NoteCard
            note={item}
            tags={tagsByNote[item.id] || []}
            onPress={() => router.push(`/note/${item.id}`)}
            onLongPress={() => setSheetNote(item)}
          />
        )}
      />

      {/* FAB flutuante estilo Joplin: + abre os atalhos de criação */}
      <Pressable
        style={({ pressed }) => [
          styles.fab,
          { position: "absolute", right: 20, bottom: 24 + insets.bottom },
          pressed && { transform: [{ scale: 0.95 }] },
        ]}
        onPress={() => setCreateSheetOpen(true)}
        accessibilityLabel="Criar nova nota"
      >
        <Text style={styles.fabText}>＋</Text>
      </Pressable>

      <ActionSheet visible={Boolean(sheetNote)} items={sheetItems} onClose={() => setSheetNote(null)} />
      <ActionSheet
        visible={createSheetOpen}
        items={[
          { label: "📝 Nova nota", onPress: () => void handleCreateNote() },
          { label: "☑️ Nova tarefa", onPress: () => void handleCreateChecklist() },
          { label: "📷 Tirar foto (câmera)", onPress: () => void handleCreatePhoto(true) },
          { label: "🖼️ Escolher da galeria", onPress: () => void handleCreatePhoto(false) },
          { label: "🎙️ Gravar áudio", onPress: () => void handleCreateAudio() },
        ]}
        onClose={() => setCreateSheetOpen(false)}
      />
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
  },
  login: {
    padding: 28,
    gap: 12,
    alignSelf: "stretch",
    maxWidth: 440,
    width: "100%",
    marginHorizontal: "auto",
  },
  title: {
    fontSize: 34,
    fontWeight: "800",
    color: "#fafafa",
  },
  subtitle: {
    fontSize: 13,
    color: "#71717a",
    marginBottom: 10,
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
  link: {
    color: "#60a5fa",
    fontSize: 13,
    alignSelf: "flex-start",
    paddingVertical: 4,
  },
  error: {
    color: "#f87171",
    fontSize: 13,
  },
  muted: {
    color: "#71717a",
  },
  list: {
    paddingHorizontal: 14,
    paddingBottom: 100,
  },
  empty: {
    alignItems: "center",
    paddingVertical: 60,
    gap: 8,
  },
  emptyIcon: {
    fontSize: 40,
  },
  emptyText: {
    color: "#71717a",
    textAlign: "center",
    paddingHorizontal: 40,
  },
  fab: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: "#fbbf24",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.4,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  syncLine: {
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  syncMuted: {
    color: "#6b6b74",
    fontSize: 11.5,
  },
  syncError: {
    color: "#f87171",
    fontSize: 11.5,
  },
  fabText: {
    color: "#1c1917",
    fontSize: 26,
    fontWeight: "700",
    marginTop: -2,
  },
});
