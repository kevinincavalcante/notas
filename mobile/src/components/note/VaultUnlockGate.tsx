import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { isBiometricEnabled, resetVault, unlockVault, unlockWithBiometric } from "../../lib/vault";

/**
 * 🔒 Cofre travado dentro da nota: nenhuma nota cifrada é lida antes da
 * senha. Dona do estado do formulário (senha/busy/erro/biometria) — a tela
 * só informa o que fazer quando o destravar succeede (`onUnlocked`, que
 * recarrega a nota já decifrada).
 */
export default function VaultUnlockGate({
  onUnlocked,
  onBack,
}: {
  onUnlocked: () => Promise<void>;
  onBack: () => void;
}) {
  const router = useRouter();
  const [vaultPass, setVaultPass] = useState("");
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [vaultBusy, setVaultBusy] = useState(false);
  const [vaultBiometric, setVaultBiometric] = useState(false);

  useEffect(() => {
    void isBiometricEnabled().then(setVaultBiometric);
  }, []);

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
      await onUnlocked();
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
      await onUnlocked();
    } catch (e) {
      setVaultError(e instanceof Error ? e.message : String(e));
    } finally {
      setVaultBusy(false);
    }
  }

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

      <Pressable onPress={onBack} hitSlop={8}>
        <Text style={styles.link}>Voltar</Text>
      </Pressable>
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
});
