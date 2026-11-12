import { useEffect, useState, useCallback } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import {
  cacheAttachment,
  cacheExists,
  cachePath,
  deleteAttachment,
  listAttachments,
} from "../lib/attachments";
import { onSynced } from "../lib/sync";
import type { AttachmentRow } from "../lib/db";

/** Faixa de anexos de uma nota — nos modos leitura e edição. */
export default function AttachmentStrip({
  noteId,
  canEdit,
}: {
  noteId: string;
  canEdit: boolean;
}) {
  const [items, setItems] = useState<AttachmentRow[]>([]);

  const reload = useCallback(() => {
    void listAttachments(noteId).then(setItems);
  }, [noteId]);

  useEffect(reload, [reload]);

  // upload/remoção/sync avisam — a faixa se atualiza na hora
  useEffect(() => onSynced(reload), [reload]);

  if (items.length === 0) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.strip}
      contentContainerStyle={styles.stripContent}
    >
      {items.map((att) => (
        <AttachmentChip
          key={att.id}
          att={att}
          canEdit={canEdit}
          onRemoved={(id) => setItems((prev) => prev.filter((a) => a.id !== id))}
        />
      ))}
    </ScrollView>
  );
}

function AttachmentChip({
  att,
  canEdit,
  onRemoved,
}: {
  att: AttachmentRow;
  canEdit: boolean;
  onRemoved: (id: string) => void;
}) {
  const isImage = att.mime_type.startsWith("image/");
  const isAudio = att.mime_type.startsWith("audio/");

  if (isImage) {
    return (
      <View style={styles.chipWrap}>
        <ThumbImage att={att} />
        {canEdit && <RemoveButton att={att} onRemoved={onRemoved} />}
      </View>
    );
  }
  if (isAudio) {
    return (
      <View style={styles.chipWrap}>
        <AudioChip att={att} />
        {canEdit && <RemoveButton att={att} onRemoved={onRemoved} />}
      </View>
    );
  }
  return (
    <View style={[styles.chipWrap, styles.fileChip]}>
      <Text style={styles.fileIcon}>📎</Text>
      <Text style={styles.fileName} numberOfLines={1}>{att.file_name}</Text>
      {canEdit && <RemoveButton att={att} onRemoved={onRemoved} />}
    </View>
  );
}

/** Miniatura de imagem — baixa do cache (sob demanda). */
function ThumbImage({ att }: { att: AttachmentRow }) {
  const [uri, setUri] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      if (await cacheExists.has(att.id, cachePath(att))) {
        setUri(cachePath(att));
      } else {
        setUri(await cacheAttachment(att));
      }
    })();
  }, [att.id]);

  if (!uri) {
    return (
      <View style={[styles.thumb, styles.thumbLoading]}>
        <ActivityIndicator size="small" />
      </View>
    );
  }
  return <Image source={{ uri }} style={styles.thumb} resizeMode="cover" />;
}

/** Chip de áudio com player (toque toca/pausa). */
function AudioChip({ att }: { att: AttachmentRow }) {
  const [uri, setUri] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const player = useAudioPlayer(uri ?? null);
  const status = useAudioPlayerStatus(player);

  useEffect(() => {
    (async () => {
      if (await cacheExists.has(att.id, cachePath(att))) {
        setUri(cachePath(att));
      } else {
        setUri(await cacheAttachment(att));
      }
      setReady(true);
    })();
  }, [att.id]);

  const playing = status?.playing ?? false;
  const dur = att.duration_seconds;
  const label = dur
    ? `${Math.floor(dur / 60)}:${String(Math.floor(dur % 60)).padStart(2, "0")}`
    : "áudio";

  return (
    <Pressable
      style={styles.audioChip}
      onPress={() => {
        if (!player || !uri) return;
        if (playing) player.pause();
        else player.play();
      }}
    >
      <Text style={styles.audioIcon}>{!ready || !uri ? "⏳" : playing ? "⏸" : "▶"}</Text>
      <Text style={styles.audioLabel} numberOfLines={1}>{label} · 🎙</Text>
    </Pressable>
  );
}

function RemoveButton({
  att,
  onRemoved,
}: {
  att: AttachmentRow;
  onRemoved: (id: string) => void;
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
          onRemoved(att.id);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Text style={styles.removeIcon}>✕</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  strip: {
    flexGrow: 0,
    flexShrink: 0,
    maxHeight: 100,
  },
  stripContent: {
    flexDirection: "row",
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
  chipWrap: {
    position: "relative",
  },
  thumb: {
    width: 72,
    height: 72,
    borderRadius: 12,
    backgroundColor: "#1c1c1f",
  },
  thumbLoading: {
    alignItems: "center",
    justifyContent: "center",
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
    height: 72,
    maxWidth: 200,
  },
  fileIcon: { fontSize: 18 },
  fileName: { color: "#e4e4e7", fontSize: 12.5, flexShrink: 1 },
  audioChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#1c1c1f",
    borderWidth: 1,
    borderColor: "#2c2c31",
    borderRadius: 12,
    paddingHorizontal: 14,
    height: 72,
  },
  audioIcon: { fontSize: 18, color: "#fbbf24" },
  audioLabel: { color: "#e4e4e7", fontSize: 13 },
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
