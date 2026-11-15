import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import * as Sharing from "expo-sharing";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import * as FileSystem from "expo-file-system/legacy";
import {
  displayUriFor,
  deleteAttachment,
} from "../lib/attachments";
import { decryptAttachmentRow, getVaultDek } from "../lib/vault";
import { decryptString, isEncrypted } from "../../../lib/vault-crypto";
import type { AttachmentRow } from "../lib/db";

/**
 * Anexos que moram no CORPO da nota (igual as fotos no topo):
 * - AudioBar: barra larga de áudio com player e progresso
 * - FileChip: chip compacto pra outros arquivos (pdf, zip...)
 * Fotos nunca passam por aqui (vivem no markdown/topo).
 */

function formatSeconds(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Barra larga de áudio no corpo da nota — toca/pausa, com progresso. */
export function AudioBar({
  att,
  onRemove,
}: {
  att: AttachmentRow;
  onRemove?: (att: AttachmentRow) => void;
}) {
  const [uri, setUri] = useState<string | null>(null);
  const player = useAudioPlayer(uri ?? null);
  const status = useAudioPlayerStatus(player);

  useEffect(() => {
    // displayUriFor decide sozinho: anexo comum vai pro cache de sempre,
    // anexo do cofre é decifrado na hora (dek em memória)
    void displayUriFor(att).then((u) => setUri(u));
  }, [att.id]);

  const playing = status?.playing ?? false;
  const total = att.duration_seconds || status?.duration || 0;
  const current = status?.currentTime ?? 0;
  const progress = total > 0 ? Math.min(1, current / total) : 0;
  const label = total > 0 ? formatSeconds(total) : "áudio";

  return (
    <View style={styles.audioBar}>
      <Pressable
        style={({ pressed }) => [styles.playBtn, pressed && { opacity: 0.8 }]}
        onPress={() => {
          if (!player || !uri) return;
          if (playing) player.pause();
          else player.play();
        }}
        hitSlop={4}
      >
        <Text style={styles.playIcon}>{!uri ? "⏳" : playing ? "⏸" : "▶"}</Text>
      </Pressable>

      <View style={styles.audioCenter}>
        <View style={styles.audioMetaRow}>
          <Text style={styles.audioTitle} numberOfLines={1}>🎙 Nota de voz</Text>
          <Text style={styles.audioTime}>{label}</Text>
        </View>
        <View style={styles.audioTrack}>
          <View style={[styles.audioTrackFill, { width: `${progress * 100}%` }]} />
        </View>
      </View>

      {onRemove && <RemoveButton att={att} onRemoved={() => onRemove(att)} />}
    </View>
  );
}

/** Chip compacto de arquivo genérico (não-imagem, não-áudio). */
/** Salvar/compartilhar anexo: decifra em memória (se for do cofre), grava
 *  no cache com o NOME REAL e abre o compartilhar do Android ("Salvar em
 *  Arquivos", enviar por app...). O ciphertext nunca toca o disco. */
export async function shareAttachmentFile(att: AttachmentRow): Promise<void> {
  const uri = await displayUriFor(att);
  if (!uri) {
    Alert.alert("Arquivo", "Não foi possível preparar o arquivo — o cofre está travado?");
    return;
  }
  const dek = getVaultDek();
  let realName = att.file_name || `arquivo-${att.id.slice(0, 8)}`;
  if (isEncrypted(realName) && dek) {
    try {
      realName = decryptString(dek, realName);
    } catch {
      realName = "arquivo";
    }
  }
  const safeName = realName.replace(/[/\\:*?"<>|]/g, "_");
  const dest = `${FileSystem.cacheDirectory}${safeName}`;
  await FileSystem.deleteAsync(dest, { idempotent: true });
  await FileSystem.copyAsync({ from: uri, to: dest });
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(dest, {
      dialogTitle: "Salvar arquivo",
      mimeType:
        att.mime_type && !isEncrypted(att.mime_type)
          ? att.mime_type
          : "application/octet-stream",
    });
  } else {
    Alert.alert("Arquivo", `Salvo em: ${dest}`);
  }
}

export function FileChip({
  att,
  onRemove,
}: {
  att: AttachmentRow;
  onRemove?: (att: AttachmentRow) => void;
}) {
  // Anexo do cofre: nome chega cifrado — mostra decifrado quando há dek
  const [name, setName] = useState(att.file_name);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const dek = getVaultDek();
    if (!dek) {
      setName(att.file_name);
      return;
    }
    setName(decryptAttachmentRow(dek, att).file_name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [att.id, att.file_name]);

  async function handleShare() {
    if (busy) return;
    setBusy(true);
    try {
      await shareAttachmentFile(att);
    } catch (e) {
      Alert.alert("Arquivo", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Pressable
      style={({ pressed }) => [styles.fileChip, pressed && { opacity: 0.85 }]}
      onPress={() => void handleShare()}
    >
      <Text style={styles.fileIcon}>📎</Text>
      <Text style={styles.fileName} numberOfLines={1}>{name}</Text>
      {busy ? (
        <ActivityIndicator size="small" color="#fbbf24" />
      ) : (
        <Text style={styles.fileSaveIcon}>⬇</Text>
      )}
      {onRemove && <RemoveButton att={att} onRemoved={() => onRemove(att)} />}
    </Pressable>
  );
}

function RemoveButton({
  att,
  onRemoved,
}: {
  att: AttachmentRow;
  onRemoved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Pressable
      style={styles.removeBtn}
      hitSlop={6}
      onPress={async () => {
        if (busy) return;
        setBusy(true);
        try {
          await deleteAttachment(att);
          onRemoved();
        } finally {
          setBusy(false);
        }
      }}
    >
      <Text style={styles.removeIcon}>✕</Text>
    </Pressable>
  );
}

export function LoadingAudio() {
  return <ActivityIndicator size="small" color="#fbbf24" />;
}

const styles = StyleSheet.create({
  audioBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#1c1c1f",
    borderWidth: 1,
    borderColor: "#2c2c31",
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  playBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#fbbf24",
    alignItems: "center",
    justifyContent: "center",
  },
  playIcon: { fontSize: 16, color: "#18181b", fontWeight: "700" },
  audioCenter: {
    flex: 1,
    gap: 6,
  },
  audioMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  audioTitle: { color: "#e4e4e7", fontSize: 13.5 },
  audioTime: { color: "#a1a1aa", fontSize: 12, fontVariant: ["tabular-nums"] },
  audioTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: "#2c2c31",
    overflow: "hidden",
  },
  audioTrackFill: {
    height: 4,
    borderRadius: 2,
    backgroundColor: "#fbbf24",
  },
  fileChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#1c1c1f",
    borderWidth: 1,
    borderColor: "#2c2c31",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    maxWidth: 220,
  },
  fileIcon: { fontSize: 16 },
  fileSaveIcon: { fontSize: 15, color: "#fbbf24" },
  fileName: { color: "#e4e4e7", fontSize: 12.5, flexShrink: 1 },
  removeBtn: {
    position: "absolute",
    top: -6,
    right: -6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "#ef4444",
    alignItems: "center",
    justifyContent: "center",
  },
  removeIcon: { color: "#fff", fontSize: 11, fontWeight: "700" },
});
