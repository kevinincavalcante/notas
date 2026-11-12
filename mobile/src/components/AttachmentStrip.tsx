import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import {
  cacheAttachment,
  cacheExists,
  cachePath,
  deleteAttachment,
} from "../lib/attachments";
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
    (async () => {
      if (await cacheExists.has(att.id, cachePath(att))) {
        setUri(cachePath(att));
      } else {
        setUri(await cacheAttachment(att));
      }
    })();
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
export function FileChip({
  att,
  onRemove,
}: {
  att: AttachmentRow;
  onRemove?: (att: AttachmentRow) => void;
}) {
  return (
    <View style={styles.fileChip}>
      <Text style={styles.fileIcon}>📎</Text>
      <Text style={styles.fileName} numberOfLines={1}>{att.file_name}</Text>
      {onRemove && <RemoveButton att={att} onRemoved={() => onRemove(att)} />}
    </View>
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
