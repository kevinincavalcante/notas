import {
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
import {
  createNote,
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

  // dados
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [tagsByNote, setTagsByNote] = useState<Record<string, string[]>>({});
  const [tags, setTags] = useState<TagRow[]>([]);
  const [activeTag, setActiveTag] = useState<string | null>(null);

  // sync
  const apiRef = useRef<SyncApiConfig | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);

  // menu de ações (long-press)
  const [sheetNote, setSheetNote] = useState<NoteRow | null>(null);

  const reload = useCallback(async () => {
    const { client } = await getDb();
    const list = await listNotes(client, activeTag);
    setNotes(list);
    setTagsByNote(await tagsForNotes(client, list.map((n) => n.id)));
    setTags(await listTags(client));
  }, [activeTag]);

  const runSync = useCallback(async () => {
    const cfg = apiRef.current;
    if (!cfg) return;
    setSyncing(true);
    const ok = await syncQuiet(cfg);
    const { error } = getLastSync();
    setSyncError(ok ? null : error || "erro desconhecido");
    if (ok) setLastSyncAt(Date.now());
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
    setLoginError(null);
    if (showUrlField && urlInput.trim()) {
      await setApiUrl(urlInput);
    }
    const result = await login(userInput, passInput);
    if (result.ok) {
      const [t, u, url] = await Promise.all([getStoredToken(), getStoredUser(), getApiUrl()]);
      setToken(t);
      setUser(u);
      apiRef.current = { baseUrl: url, token: t! };
      void runSync();
    } else {
      setLoginError(result.error || "Login falhou.");
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

  async function handleFab() {
    const { client } = await getDb();
    const id = await createNote(client);
    scheduleSync();
    void reload();
    router.push(`/note/${id}`);
  }

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
        />
        <TextInput
          style={styles.input}
          placeholder="Senha"
          placeholderTextColor="#71717a"
          secureTextEntry
          value={passInput}
          onChangeText={setPassInput}
          onSubmitEditing={() => void handleLogin()}
        />

        <Pressable onPress={() => setShowUrlField((v) => !v)} hitSlop={8}>
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
          />
        )}

        <Pressable style={styles.button} onPress={() => void handleLogin()}>
          <Text style={styles.buttonText}>Entrar</Text>
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

      {(syncing || syncError || lastSyncAt) && (
        <Pressable
          onPress={() => void runSync()}
          disabled={syncing}
          style={({ pressed }) => [styles.syncLine, pressed && { opacity: 0.7 }]}
        >
          <Text
            style={
              syncing
                ? styles.syncMuted
                : syncError
                  ? styles.syncError
                  : styles.syncMuted
            }
          >
            {syncing
              ? "Sincronizando…"
              : syncError
                ? `Sync falhou: ${syncError} — toque pra tentar de novo`
                : `Sincronizado ${new Date(lastSyncAt || 0).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`}
          </Text>
        </Pressable>
      )}

      <FlatList
        data={notes}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <Text style={styles.section}>{activeTag ? "Bloco" : "Recentes"}</Text>
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>🗒</Text>
            <Text style={styles.emptyText}>
              {activeTag
                ? "Nada com esse marcador ainda."
                : "Nada por aqui — crie sua primeira nota."}
            </Text>
            {syncError && <Text style={styles.syncError}>{`Sync falhou: ${syncError}`}</Text>}
          </View>
        }
        refreshControl={
          <RefreshControl
            refreshing={syncing}
            onRefresh={() => void runSync()}
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

      <Pressable
        style={[styles.fab, { bottom: insets.bottom + 18 }]}
        onPress={() => void handleFab()}
      >
        <Text style={styles.fabText}>＋</Text>
      </Pressable>

      <ActionSheet visible={Boolean(sheetNote)} items={sheetItems} onClose={() => setSheetNote(null)} />
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
  section: {
    color: "#71717a",
    fontSize: 11.5,
    textTransform: "uppercase",
    letterSpacing: 1,
    paddingHorizontal: 4,
    paddingBottom: 6,
    paddingTop: 8,
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
    position: "absolute",
    right: 18,
    bottom: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
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
