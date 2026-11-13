import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { getApiUrl, getStoredToken, getStoredUser, logout, setApiUrl } from "../lib/api";
import { getLastSync, syncQuiet, type SyncApiConfig } from "../lib/sync";

/** Config: conta, endereço da API, sync manual e sair. */
export default function ConfigScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [user, setUser] = useState<string | null>(null);
  const [hasToken, setHasToken] = useState(false);
  const [url, setUrl] = useState("");
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const [u, t, u2] = await Promise.all([getStoredUser(), getStoredToken(), getApiUrl()]);
      setUser(u);
      setHasToken(Boolean(t));
      setUrl(u2);
    })();
  }, []);

  async function handleSaveUrl() {
    await setApiUrl(url);
    setUrl(await getApiUrl());
    setSavedMsg("Endereço salvo.");
  }

  async function handleSync() {
    setBusy(true);
    setSyncMsg(null);
    const token = await getStoredToken();
    if (!token) {
      setSyncMsg("Você não está logado.");
      setBusy(false);
      return;
    }
    const ok = await syncQuiet({ baseUrl: await getApiUrl(), token });
    const { result, error } = getLastSync();
    setSyncMsg(
      ok && result
        ? `push: ${result.pushedNotes} notas · pull: ${result.pulledNotes} notas · túmulos: ${result.appliedTombstones}`
        : `Falhou: ${error || "?"}`
    );
    setBusy(false);
  }

  async function handleLogout() {
    await logout();
    router.replace("/");
  }

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Text style={styles.back}>‹</Text>
        </Pressable>
        <Text style={styles.headerTitle}>Configurações</Text>
        <View style={{ width: 30 }} />
      </View>

      <View style={styles.section}>
        <Text style={styles.label}>Conta</Text>
        <Text style={styles.value}>{hasToken ? `logado como ${user ?? "?"}` : "sem sessão"}</Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.label}>Endereço da API</Text>
        <TextInput
          style={styles.input}
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="https://minha-api.vercel.app"
          placeholderTextColor="#52525b"
        />
        <Pressable style={styles.smallButton} onPress={() => void handleSaveUrl()}>
          <Text style={styles.smallButtonText}>Salvar endereço</Text>
        </Pressable>
        {savedMsg && <Text style={styles.hint}>{savedMsg}</Text>}
      </View>

      <View style={styles.section}>
        <Text style={styles.label}>Sincronização</Text>
        <Pressable
          style={[styles.smallButton, busy && { opacity: 0.6 }]}
          onPress={() => void handleSync()}
          disabled={busy}
        >
          <Text style={styles.smallButtonText}>{busy ? "Sincronizando…" : "Sync agora"}</Text>
        </Pressable>
        {syncMsg && <Text style={styles.hint}>{syncMsg}</Text>}
        <Text style={styles.hint}>
          O app também sincroniza sozinho ao abrir e ao voltar pro primeiro plano.
        </Text>
      </View>

      {hasToken && (
        <Pressable style={styles.logout} onPress={() => void handleLogout()}>
          <Text style={styles.logoutText}>Sair da conta</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#101012",
    padding: 20,
    gap: 18,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: 4,
  },
  back: {
    color: "#fafafa",
    fontSize: 30,
  },
  headerTitle: {
    color: "#fafafa",
    fontSize: 17,
    fontWeight: "700",
  },
  section: {
    gap: 8,
  },
  label: {
    color: "#71717a",
    fontSize: 11.5,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  value: {
    color: "#e4e4e7",
    fontSize: 15,
  },
  input: {
    borderWidth: 1,
    borderColor: "#2c2c31",
    borderRadius: 12,
    backgroundColor: "#1c1c1f",
    color: "#fafafa",
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 14,
  },
  smallButton: {
    backgroundColor: "#232326",
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
  },
  smallButtonText: {
    color: "#e4e4e7",
    fontWeight: "600",
    fontSize: 14,
  },
  hint: {
    color: "#71717a",
    fontSize: 12.5,
  },
  logout: {
    marginTop: "auto",
    paddingVertical: 14,
    alignItems: "center",
  },
  logoutText: {
    color: "#f87171",
    fontWeight: "600",
    fontSize: 15,
  },
});
