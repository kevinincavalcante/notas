import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { fetchVersions, restoreVersion, type NoteVersionItem } from "../lib/versions";

/**
 * Histórico de versões estilo desktop: lista → pré-visualiza → restaura.
 * O servidor snapshot o estado atual antes de restaurar (nada se perde).
 */

function formatWhen(ts: number): string {
  const d = new Date(ts);
  const hoje = new Date();
  const mesmoDia = d.toDateString() === hoje.toDateString();
  const hora = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (mesmoDia) return `hoje às ${hora}`;
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")} às ${hora}`;
}

export default function VersionHistorySheet({
  visible,
  noteId,
  onClose,
  onRestored,
}: {
  visible: boolean;
  noteId: string;
  onClose: () => void;
  onRestored: () => void;
}) {
  const [versions, setVersions] = useState<NoteVersionItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<NoteVersionItem | null>(null);
  const [restoring, setRestoring] = useState(false);

  const load = useCallback(async () => {
    if (!noteId) return;
    setLoading(true);
    setSelected(null);
    try {
      setVersions(await fetchVersions(noteId));
    } catch (e) {
      Alert.alert("Histórico", e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [noteId]);

  useEffect(() => {
    if (visible) void load();
  }, [visible, load]);

  async function handleRestore(version: NoteVersionItem) {
    if (restoring) return;
    setRestoring(true);
    try {
      await restoreVersion(noteId, version.id);
      onRestored();
      onClose();
    } catch (e) {
      Alert.alert("Histórico", e instanceof Error ? e.message : String(e));
    } finally {
      setRestoring(false);
    }
  }

  return (
    <Modal transparent visible={visible} animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>Histórico de versões</Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <Text style={styles.closeIcon}>✕</Text>
            </Pressable>
          </View>

          {loading ? (
            <View style={styles.center}>
              <ActivityIndicator size="small" color="#fbbf24" />
            </View>
          ) : selected ? (
            <View style={styles.previewWrap}>
              <Pressable onPress={() => setSelected(null)} hitSlop={8}>
                <Text style={styles.backLink}>‹ Todas as versões</Text>
              </Pressable>
              <Text style={styles.previewTitle} numberOfLines={2}>
                {selected.title || "Sem título"}
              </Text>
              <Text style={styles.previewWhen}>salva {formatWhen(selected.created_at)}</Text>
              <View style={styles.previewBodyWrap}>
                <Text selectable style={styles.previewBody}>
                  {selected.body || "(corpo vazio)"}
                </Text>
              </View>
              <Pressable
                style={({ pressed }) => [styles.restoreBtn, pressed && { opacity: 0.85 }]}
                onPress={() => void handleRestore(selected)}
                disabled={restoring}
              >
                {restoring ? (
                  <ActivityIndicator size="small" color="#18181b" />
                ) : (
                  <Text style={styles.restoreText}>Restaurar esta versão</Text>
                )}
              </Pressable>
            </View>
          ) : versions.length === 0 ? (
            <View style={styles.center}>
              <Text style={styles.emptyText}>Nenhuma versão ainda —{"\n"}cada alteração salva cria uma.</Text>
            </View>
          ) : (
            <FlatList
              data={versions}
              keyExtractor={(v) => v.id}
              style={styles.list}
              renderItem={({ item }) => (
                <Pressable
                  style={({ pressed }) => [styles.versionItem, pressed && styles.itemPressed]}
                  onPress={() => setSelected(item)}
                >
                  <Text style={styles.itemWhen}>salva {formatWhen(item.created_at)}</Text>
                  <Text style={styles.itemTitle} numberOfLines={1}>
                    {item.title || "Sem título"}
                  </Text>
                  <Text style={styles.itemSnippet} numberOfLines={2}>
                    {item.body ? item.body.replace(/[#*_>\-]{1,3}\s?/g, "").slice(0, 120) : "(corpo vazio)"}
                  </Text>
                </Pressable>
              )}
            />
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: "#1f1f23",
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    height: "80%",
    paddingBottom: 18,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#2f2f35",
  },
  title: { color: "#fafafa", fontSize: 17, fontWeight: "600" },
  closeIcon: { color: "#a1a1aa", fontSize: 18 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8 },
  emptyText: { color: "#a1a1aa", fontSize: 13.5, textAlign: "center" },
  list: { flex: 1 },
  versionItem: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#2a2a2f",
  },
  itemPressed: { backgroundColor: "#2a2a2f" },
  itemWhen: { color: "#a1a1aa", fontSize: 12, marginBottom: 3 },
  itemTitle: { color: "#fafafa", fontSize: 15, fontWeight: "600", marginBottom: 2 },
  itemSnippet: { color: "#71717a", fontSize: 13 },
  previewWrap: { flex: 1, paddingHorizontal: 20, paddingTop: 14 },
  backLink: { color: "#fbbf24", fontSize: 13.5, marginBottom: 12 },
  previewTitle: { color: "#fafafa", fontSize: 18, fontWeight: "700" },
  previewWhen: { color: "#a1a1aa", fontSize: 12, marginTop: 4 },
  previewBodyWrap: {
    flex: 1,
    marginTop: 12,
    backgroundColor: "#18181b",
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: "#2c2c31",
  },
  previewBody: { color: "#d4d4d8", fontSize: 14, lineHeight: 21 },
  restoreBtn: {
    backgroundColor: "#fbbf24",
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 12,
  },
  restoreText: { color: "#18181b", fontWeight: "700", fontSize: 15 },
});
