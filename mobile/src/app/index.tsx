import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { openDatabaseSync } from "expo-sqlite";
import { ensureSchema } from "../../../lib/db-schema";
import { createExpoClient } from "../lib/sqlite-client";
import { syncOnceHttp } from "../lib/sync";
import {
  DEFAULT_API_URL,
  getApiUrl,
  getStoredToken,
  getStoredUser,
  login,
  logout,
  setApiUrl,
} from "../lib/api";
import type { ReplicaSyncResult } from "../../../lib/sync-core";

/**
 * Tela de status da base técnica — prova o tubo completo:
 * SQLite local → schema → login (JWT no SecureStore) → POST /api/sync.
 * A UI de verdade vem com os designs do dono.
 */
export default function StatusScreen() {
  const [ready, setReady] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<string | null>(null);
  const [apiUrl, setApiUrlState] = useState(DEFAULT_API_URL);
  const [userInput, setUserInput] = useState("");
  const [passInput, setPassInput] = useState("");
  const [urlInput, setUrlInput] = useState("");
  const [showUrlField, setShowUrlField] = useState(false);
  const [syncResult, setSyncResult] = useState<ReplicaSyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [noteCount, setNoteCount] = useState<number | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const db = openDatabaseSync("notas.db");
        await db.execAsync("PRAGMA foreign_keys = ON");
        await ensureSchema(createExpoClient(db));
        const [t, u, url] = await Promise.all([getStoredToken(), getStoredUser(), getApiUrl()]);
        setToken(t);
        setUser(u);
        setApiUrlState(url);
        setUrlInput(url === DEFAULT_API_URL ? "" : url);
      } catch (e) {
        setError(`Falha no banco local: ${String(e)}`);
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const refreshCount = useCallback(async () => {
    try {
      const db = openDatabaseSync("notas.db");
      const client = createExpoClient(db);
      const res = await client.execute("SELECT COUNT(*) AS c FROM notes");
      setNoteCount(Number(res.rows[0]?.c ?? 0));
    } catch {
      setNoteCount(null);
    }
  }, []);

  useEffect(() => {
    if (token) void refreshCount();
  }, [token, syncResult, refreshCount]);

  async function handleLogin() {
    setBusy(true);
    setError(null);
    if (showUrlField && urlInput.trim()) {
      await setApiUrl(urlInput);
      setApiUrlState(urlInput.trim());
    }
    const result = await login(userInput, passInput);
    if (result.ok) {
      const [t, u] = await Promise.all([getStoredToken(), getStoredUser()]);
      setToken(t);
      setUser(u);
      setPassInput("");
    } else {
      setError(result.error || "Login falhou.");
    }
    setBusy(false);
  }

  async function handleSync() {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const db = openDatabaseSync("notas.db");
      const result = await syncOnceHttp(createExpoClient(db), {
        baseUrl: apiUrl,
        token,
      });
      setSyncResult(result);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    await logout();
    setToken(null);
    setUser(null);
    setSyncResult(null);
    setNoteCount(null);
  }

  if (!ready) {
    return (
      <View style={[styles.container, styles.center]}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (!token) {
    return (
      <View style={[styles.container, styles.center]}>
        <Text style={styles.title}>Notas</Text>
        <Text style={styles.subtitle}>{apiUrl}</Text>

        <TextInput
          style={styles.input}
          placeholder="Usuário"
          autoCapitalize="none"
          value={userInput}
          onChangeText={setUserInput}
        />
        <TextInput
          style={styles.input}
          placeholder="Senha"
          secureTextEntry
          value={passInput}
          onChangeText={setPassInput}
          onSubmitEditing={() => void handleLogin()}
        />

        <Pressable
          onPress={() => setShowUrlField((v) => !v)}
          style={styles.linkWrap}
        >
          <Text style={styles.link}>{showUrlField ? "usar API padrão" : "usar outra API"}</Text>
        </Pressable>
        {showUrlField && (
          <TextInput
            style={styles.input}
            placeholder={`URL da API (padrão: ${DEFAULT_API_URL})`}
            autoCapitalize="none"
            autoCorrect={false}
            value={urlInput}
            onChangeText={setUrlInput}
          />
        )}

        <Pressable
          style={[styles.button, busy && styles.buttonDisabled]}
          onPress={() => void handleLogin()}
          disabled={busy}
        >
          <Text style={styles.buttonText}>{busy ? "Entrando..." : "Entrar"}</Text>
        </Pressable>

        {error && <Text style={styles.error}>{error}</Text>}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Notas</Text>
      <Text style={styles.subtitle}>
        logado como {user ?? "?"} · {apiUrl}
      </Text>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>Notas locais</Text>
        <Text style={styles.cardValue}>{noteCount ?? "—"}</Text>
      </View>

      <Pressable
        style={[styles.button, busy && styles.buttonDisabled]}
        onPress={() => void handleSync()}
        disabled={busy}
      >
        <Text style={styles.buttonText}>{busy ? "Sincronizando..." : "Sync agora"}</Text>
      </Pressable>

      {syncResult && (
        <View style={styles.card}>
          <Text style={styles.cardLabel}>Última sync</Text>
          <Text style={styles.mono}>
            {`push: ${syncResult.pushedNotes} notas · ${syncResult.pushedVersions} versões
pull: ${syncResult.pulledNotes} notas · ${syncResult.pulledVersions} versões
túmulos aplicados: ${syncResult.appliedTombstones}
cursor: ${syncResult.cursor}${syncResult.conflicts.length > 0 ? `
conflitos: ${syncResult.conflicts.join(", ")}` : ""}`}
          </Text>
        </View>
      )}

      {error && <Text style={styles.error}>{error}</Text>}

      <Pressable style={styles.linkWrap} onPress={() => void handleLogout()}>
        <Text style={styles.link}>Sair</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f8fafc",
    padding: 24,
    gap: 12,
  },
  center: {
    justifyContent: "center",
    maxWidth: 420,
    width: "100%",
    alignSelf: "center",
  },
  title: {
    fontSize: 32,
    fontWeight: "700",
    color: "#0f172a",
  },
  subtitle: {
    fontSize: 13,
    color: "#64748b",
    marginBottom: 12,
  },
  input: {
    borderWidth: 1,
    borderColor: "#e2e8f0",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    backgroundColor: "#fff",
  },
  button: {
    backgroundColor: "#fbbf24",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: "#1c1917",
    fontWeight: "700",
    fontSize: 16,
  },
  linkWrap: {
    alignSelf: "center",
    padding: 6,
  },
  link: {
    color: "#2563eb",
    fontSize: 13,
  },
  card: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#e2e8f0",
    borderRadius: 12,
    padding: 14,
    gap: 4,
  },
  cardLabel: {
    fontSize: 12,
    color: "#64748b",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  cardValue: {
    fontSize: 28,
    fontWeight: "700",
    color: "#0f172a",
  },
  mono: {
    fontFamily: undefined,
    fontSize: 13,
    color: "#334155",
    lineHeight: 20,
  },
  error: {
    color: "#dc2626",
    fontSize: 13,
  },
});
