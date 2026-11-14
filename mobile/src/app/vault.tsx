import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { getSyncApi } from "../lib/api";
import { onSynced, scheduleQuietSync } from "../lib/sync";
import {
  createNote,
  getDb,
  setNoteVault,
  updateNote,
  type NoteRow,
} from "../lib/db";
import {
  biometricSupported,
  changeVaultPassword,
  decryptNoteRow,
  disableBiometric,
  enableBiometric,
  getVaultDek,
  getVaultMeta,
  isBiometricEnabled,
  lockVault,
  setupVault,
  subscribeVault,
  unlockVault,
  unlockWithBiometric,
  type VaultMeta,
} from "../lib/vault";
import { encryptString } from "../../../lib/vault-crypto";

/**
 * Aba do COFRE — notas cifradas (AES-256-GCM no cliente). Quatro estados:
 * carregando material → setup (criar senha) → travado → destravado.
 * A busca do cofre é em memória sobre o conteúdo decifrado (o FTS5
 * propositalmente exclui notas is_vault).
 */

function relativeDate(ts: number): string {
  const d = new Date(ts);
  const hoje = new Date();
  const hora = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === hoje.toDateString()) return `hoje às ${hora}`;
  const ontem = new Date(hoje);
  ontem.setDate(hoje.getDate() - 1);
  if (d.toDateString() === ontem.toDateString()) return `ontem às ${hora}`;
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getFullYear())}`;
}

type Phase = "loading" | "setup" | "locked" | "unlocked";

export default function VaultScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [phase, setPhase] = useState<Phase>("loading");
  const [meta, setMeta] = useState<VaultMeta | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // setup (primeira senha)
  const [setupPass, setSetupPass] = useState("");
  const [setupPass2, setSetupPass2] = useState("");
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);

  // destravar
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [biometricOn, setBiometricOn] = useState(false);

  // destravado: notas + busca + troca de senha
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [query, setQuery] = useState("");
  const [changingPass, setChangingPass] = useState(false);
  const [currentPass, setCurrentPass] = useState("");
  const [newPass, setNewPass] = useState("");
  const [newPass2, setNewPass2] = useState("");
  const [changeBusy, setChangeBusy] = useState(false);
  const [changeError, setChangeError] = useState<string | null>(null);

  function scheduleSync() {
    void getSyncApi().then((cfg) => {
      if (cfg) scheduleQuietSync(cfg);
    });
  }

  const reload = useCallback(async () => {
    try {
      const m = await getVaultMeta();
      setMeta(m);
      setLoadError(null);
      const dek = getVaultDek();
      if (!m) {
        setPhase("setup");
      } else if (!dek) {
        setPhase("locked");
        setBiometricOn(await isBiometricEnabled());
      } else {
        setPhase("unlocked");
        // Notas do cofre: direto do SQLite (title/body cifrados) — decifra
        // em memória pra lista/busca
        const { client } = await getDb();
        const res = await client.execute({
          sql: `SELECT * FROM notes WHERE is_vault = 1 AND is_archived = 0 ORDER BY updated_at DESC LIMIT 200`,
          args: [],
        });
        const rows = res.rows as unknown as NoteRow[];
        setNotes(rows.map((r) => decryptNoteRow(dek, r)));
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // primeira carga + recargas no fim de sync e quando a DEK entra/sai
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => onSynced(() => void reload()), [reload]);
  useEffect(() => subscribeVault(() => void reload()), [reload]);
  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload])
  );

  // ---- Setup (criar a senha do cofre) ----
  async function handleSetup() {
    if (setupBusy) return;
    setSetupError(null);
    if (setupPass.length < 4) {
      setSetupError("Use ao menos 4 caracteres.");
      return;
    }
    if (setupPass !== setupPass2) {
      setSetupError("As senhas não conferem.");
      return;
    }
    setSetupBusy(true);
    try {
      const ok = await setupVault(setupPass);
      if (!ok) setSetupError("Não foi possível criar o cofre.");
      setSetupPass("");
      setSetupPass2("");
      // recarrega via subscribeVault
    } catch (e) {
      setSetupError(e instanceof Error ? e.message : String(e));
    } finally {
      setSetupBusy(false);
    }
  }

  // ---- Destravar por senha / biometria ----
  async function handleUnlock() {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const ok = await unlockVault(pass);
      if (!ok) {
        setError("Senha incorreta.");
        return;
      }
      setPass("");
      maybeOfferBiometric();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleUnlockBiometric() {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const ok = await unlockWithBiometric();
      if (!ok) setError("Biometria falhou — use a senha.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /** Primeiro destravamento por senha: se o aparelho suporta, oferecemos. */
  async function maybeOfferBiometric() {
    try {
      if (await isBiometricEnabled()) return;
      if (!(await biometricSupported())) return;
      Alert.alert(
        "Biometria",
        "Usar biometria para destravar o cofre?",
        [
          { text: "Não", style: "cancel" },
          { text: "Sim", onPress: () => void enableBiometric() },
        ]
      );
    } catch {
      // biometria é opcional — falha silenciosa
    }
  }

  // ---- Nova nota dentro do cofre ----
  async function handleCreateNote() {
    const dek = getVaultDek();
    if (!dek) return;
    const { client } = await getDb();
    const id = await createNote(client);
    // Nasce já cifrado (título/corpo vazios) e FORA da lista comum:
    // updateNote + setNoteVault (ambos logam no change_log pro sync)
    await updateNote(client, id, {
      title: encryptString(dek, ""),
      body: encryptString(dek, ""),
    });
    await setNoteVault(client, id, true);
    notifySync();
    router.push(`/note/${id}`);
  }

  function notifySync() {
    void reload();
    scheduleSync();
  }

  // ---- Remover do cofre (long-press): des-cifra os campos ----
  function removeFromVault(note: NoteRow) {
    const dek = getVaultDek();
    if (!dek) return;
    Alert.alert(
      "Remover do cofre",
      `"${note.title || "Sem título"}" volta para a lista comum em texto claro. Continuar?`,
      [
        { text: "Cancelar", style: "cancel" },
        {
          text: "Remover",
          style: "destructive",
          onPress: () => {
            void (async () => {
              const { client } = await getDb();
              // v1 mobile: só title/body des-cifram (versões/anexos já
              // transicionam completos na web/server)
              await updateNote(client, note.id, { title: note.title, body: note.body });
              await setNoteVault(client, note.id, false);
              notifySync();
            })();
          },
        },
      ]
    );
  }

  // ---- Troca de senha: re-embrulha a MESMA DEK (nada é re-cifrado) ----
  async function handleChangePassword() {
    if (changeBusy) return;
    setChangeError(null);
    if (newPass.length < 4) {
      setChangeError("Use ao menos 4 caracteres.");
      return;
    }
    if (newPass !== newPass2) {
      setChangeError("As senhas não conferem.");
      return;
    }
    setChangeBusy(true);
    try {
      const ok = await changeVaultPassword(currentPass, newPass);
      if (!ok) {
        setChangeError("Senha atual incorreta.");
        return;
      }
      setChangingPass(false);
      setCurrentPass("");
      setNewPass("");
      setNewPass2("");
      scheduleSync(); // material novo sobe pro servidor
      Alert.alert("Cofre", "Senha alterada.");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setChangeError(
        msg === "conflict"
          ? "Outro dispositivo alterou o cofre nesse meio-tempo — tente novamente."
          : msg
      );
    } finally {
      setChangeBusy(false);
    }
  }

  // ---- Biometria liga/desliga ----
  async function handleToggleBiometric() {
    if (biometricOn) {
      Alert.alert("Biometria", "Desligar a biometria do cofre?", [
        { text: "Cancelar", style: "cancel" },
        {
          text: "Desligar",
          style: "destructive",
          onPress: () => {
            void disableBiometric().then(() => setBiometricOn(false));
          },
        },
      ]);
      return;
    }
    const ok = await enableBiometric();
    if (!ok) {
      Alert.alert(
        "Biometria",
        "Biometria indisponível — verifique se o aparelho tem digital/rosto cadastrados."
      );
      return;
    }
    setBiometricOn(true);
  }

  if (phase === "loading") {
    return (
      <View style={[styles.root, styles.center]}>
        <ActivityIndicator size="small" color="#fbbf24" />
        <Text style={styles.muted}>Abrindo o cofre…</Text>
      </View>
    );
  }

  // ---- Sem cofre: primeira senha ----
  if (phase === "setup") {
    return (
      <View style={[styles.root, styles.center, styles.form]}>
        <Text style={styles.title}>Cofre</Text>
        <Text style={styles.subtitle}>Defina a senha do cofre</Text>

        <TextInput
          style={styles.input}
          placeholder="Senha do cofre"
          placeholderTextColor="#71717a"
          secureTextEntry
          value={setupPass}
          onChangeText={setSetupPass}
          editable={!setupBusy}
        />
        <TextInput
          style={styles.input}
          placeholder="Repetir senha"
          placeholderTextColor="#71717a"
          secureTextEntry
          value={setupPass2}
          onChangeText={setSetupPass2}
          editable={!setupBusy}
          onSubmitEditing={() => void handleSetup()}
        />

        <Text style={styles.warn}>
          ⚠️ A senha do cofre não pode ser recuperada — se você a perder, as
          notas cifradas ficam ilegíveis para sempre.
        </Text>

        <Pressable
          style={[styles.button, setupBusy && { opacity: 0.7 }]}
          onPress={() => void handleSetup()}
          disabled={setupBusy}
        >
          {setupBusy ? (
            <ActivityIndicator size="small" color="#18181b" />
          ) : (
            <Text style={styles.buttonText}>Criar cofre</Text>
          )}
        </Pressable>
        {setupError && <Text style={styles.error}>{setupError}</Text>}
      </View>
    );
  }

  // ---- Travado ----
  if (phase === "locked") {
    return (
      <View style={[styles.root, styles.center, styles.form]}>
        <Text style={styles.lockIcon}>🔒</Text>
        <Text style={styles.title}>Cofre travado</Text>
        <Text style={styles.subtitle}>Digite a senha para ver suas notas cifradas</Text>

        <TextInput
          style={styles.input}
          placeholder="Senha do cofre"
          placeholderTextColor="#71717a"
          secureTextEntry
          value={pass}
          onChangeText={setPass}
          editable={!busy}
          onSubmitEditing={() => void handleUnlock()}
        />

        <Pressable
          style={[styles.button, busy && { opacity: 0.7 }]}
          onPress={() => void handleUnlock()}
          disabled={busy}
        >
          {busy ? (
            <ActivityIndicator size="small" color="#18181b" />
          ) : (
            <Text style={styles.buttonText}>Destravar</Text>
          )}
        </Pressable>

        {biometricOn && !busy && (
          <Pressable style={styles.ghostButton} onPress={() => void handleUnlockBiometric()}>
            <Text style={styles.ghostButtonText}>🔓 Desbloquear com biometria</Text>
          </Pressable>
        )}

        {error && <Text style={styles.error}>{error}</Text>}
      </View>
    );
  }

  // ---- Destravado ----
  const q = query.trim().toLowerCase();
  const visible = q
    ? notes.filter(
        (n) =>
          n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q)
      )
    : notes;

  return (
    <View style={styles.root}>
      {/* Header estilo TopBar: voltar + título + 🔒/＋ */}
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Text style={styles.back}>‹</Text>
        </Pressable>
        <Text style={styles.headerTitle}>Cofre</Text>
        <View style={styles.headerRight}>
          <Pressable onPress={() => lockVault()} hitSlop={8} accessibilityLabel="Travar o cofre">
            <Text style={styles.headerIcon}>🔒</Text>
          </Pressable>
          <Pressable
            onPress={() => void handleCreateNote()}
            hitSlop={8}
            accessibilityLabel="Nova nota do cofre"
          >
            <Text style={styles.headerIcon}>＋</Text>
          </Pressable>
        </View>
      </View>

      <FlatList
        data={visible}
        keyExtractor={(item) => item.id}
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 24 }]}
        ListHeaderComponent={
          <View style={styles.searchWrap}>
            <TextInput
              style={styles.input}
              placeholder="Buscar no cofre…"
              placeholderTextColor="#71717a"
              value={query}
              onChangeText={setQuery}
              autoCorrect={false}
            />
            {notes.length === 0 && (
              <Text style={styles.emptyText}>
                Nada no cofre ainda — toque em ＋ para criar uma nota cifrada.
              </Text>
            )}
          </View>
        }
        ListFooterComponent={
          <View style={styles.config}>
            <Text style={styles.configTitle}>Configurações</Text>

            {changingPass ? (
              <View style={styles.changeForm}>
                <TextInput
                  style={styles.input}
                  placeholder="Senha atual"
                  placeholderTextColor="#71717a"
                  secureTextEntry
                  value={currentPass}
                  onChangeText={setCurrentPass}
                  editable={!changeBusy}
                />
                <TextInput
                  style={styles.input}
                  placeholder="Nova senha"
                  placeholderTextColor="#71717a"
                  secureTextEntry
                  value={newPass}
                  onChangeText={setNewPass}
                  editable={!changeBusy}
                />
                <TextInput
                  style={styles.input}
                  placeholder="Repetir nova senha"
                  placeholderTextColor="#71717a"
                  secureTextEntry
                  value={newPass2}
                  onChangeText={setNewPass2}
                  editable={!changeBusy}
                />
                {changeError && <Text style={styles.error}>{changeError}</Text>}
                <View style={styles.changeRow}>
                  <Pressable
                    style={[styles.ghostButton, styles.changeRowButton]}
                    onPress={() => {
                      setChangingPass(false);
                      setChangeError(null);
                      setCurrentPass("");
                      setNewPass("");
                      setNewPass2("");
                    }}
                  >
                    <Text style={styles.ghostButtonText}>Cancelar</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.button, styles.changeRowButton]}
                    onPress={() => void handleChangePassword()}
                    disabled={changeBusy}
                  >
                    {changeBusy ? (
                      <ActivityIndicator size="small" color="#18181b" />
                    ) : (
                      <Text style={styles.buttonText}>Trocar</Text>
                    )}
                  </Pressable>
                </View>
              </View>
            ) : (
              <Pressable
                style={({ pressed }) => [styles.configItem, pressed && { opacity: 0.8 }]}
                onPress={() => setChangingPass(true)}
              >
                <Text style={styles.configLabel}>🔑 Alterar senha</Text>
              </Pressable>
            )}

            <Pressable
              style={({ pressed }) => [styles.configItem, pressed && { opacity: 0.8 }]}
              onPress={() => void handleToggleBiometric()}
            >
              <Text style={styles.configLabel}>
                Biometria: {biometricOn ? "ligada" : "desligada"}
              </Text>
            </Pressable>

            <Pressable
              style={({ pressed }) => [styles.configItem, pressed && { opacity: 0.8 }]}
              onPress={() => lockVault()}
            >
              <Text style={styles.configLabel}>🔒 Travar agora</Text>
            </Pressable>
          </View>
        }
        renderItem={({ item }) => {
          const preview = item.body
            .replace(/[#>*`\-_[\]()!]/g, " ")
            .replace(/\s+/g, " ")
            .trim();
          return (
            <Pressable
              style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
              onPress={() => router.push(`/note/${item.id}`)}
              onLongPress={() => removeFromVault(item)}
              delayLongPress={350}
            >
              <Text style={styles.cardTitle} numberOfLines={1}>
                {item.title || "Sem título"}
              </Text>
              {preview.length > 0 && (
                <Text style={styles.cardPreview} numberOfLines={2}>
                  {preview}
                </Text>
              )}
              <Text style={styles.cardWhen}>{relativeDate(item.updated_at)}</Text>
            </Pressable>
          );
        }}
      />

      {loadError && (
        <Text style={styles.loadError}>{`Falha no cofre: ${loadError}`}</Text>
      )}
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
    gap: 12,
  },
  form: {
    padding: 28,
    alignSelf: "stretch",
    maxWidth: 440,
    width: "100%",
    marginHorizontal: "auto",
  },
  title: {
    color: "#fafafa",
    fontSize: 30,
    fontWeight: "800",
  },
  lockIcon: {
    fontSize: 44,
  },
  subtitle: {
    color: "#71717a",
    fontSize: 13.5,
    textAlign: "center",
  },
  warn: {
    color: "#fbbf24",
    fontSize: 12.5,
    textAlign: "center",
    lineHeight: 18,
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
    marginTop: 4,
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
    paddingHorizontal: 16,
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
  muted: {
    color: "#71717a",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 10,
    backgroundColor: "#18181b",
  },
  back: {
    color: "#fafafa",
    fontSize: 30,
    paddingHorizontal: 8,
  },
  headerTitle: {
    color: "#fafafa",
    fontSize: 18,
    fontWeight: "700",
    flex: 1,
    marginLeft: 6,
  },
  headerRight: {
    flexDirection: "row",
    gap: 20,
  },
  headerIcon: {
    color: "#d4d4d8",
    fontSize: 21,
  },
  list: {
    paddingHorizontal: 14,
    paddingTop: 12,
  },
  searchWrap: {
    gap: 10,
    marginBottom: 12,
  },
  emptyText: {
    color: "#71717a",
    textAlign: "center",
    paddingVertical: 40,
    paddingHorizontal: 40,
  },
  card: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#26262a",
    backgroundColor: "#18181b",
    paddingHorizontal: 15,
    paddingTop: 13,
    paddingBottom: 12,
    marginBottom: 10,
  },
  cardPressed: {
    opacity: 0.85,
  },
  cardTitle: {
    color: "#fafafa",
    fontWeight: "600",
    fontSize: 15,
  },
  cardPreview: {
    color: "#9b9ba3",
    fontSize: 13.5,
    lineHeight: 19,
    marginTop: 4,
  },
  cardWhen: {
    color: "#6b6b74",
    fontSize: 11.5,
    marginTop: 7,
  },
  config: {
    marginTop: 14,
    gap: 8,
  },
  configTitle: {
    color: "#71717a",
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  configItem: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#26262a",
    backgroundColor: "#18181b",
    paddingHorizontal: 15,
    paddingVertical: 13,
  },
  configLabel: {
    color: "#e4e4e7",
    fontSize: 14.5,
  },
  changeForm: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#2c2c31",
    backgroundColor: "#1c1c1f",
    padding: 12,
    gap: 10,
  },
  changeRow: {
    flexDirection: "row",
    gap: 10,
  },
  changeRowButton: {
    flex: 1,
    marginTop: 0,
  },
  loadError: {
    color: "#f87171",
    fontSize: 11.5,
    paddingHorizontal: 16,
    paddingBottom: 6,
  },
});
