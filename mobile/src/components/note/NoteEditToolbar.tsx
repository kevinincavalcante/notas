import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { NOTE_COLOR_IDS, NOTE_COLOR_SWATCH } from "../../lib/colors";

/** Banner visual durante a gravação de voz. */
export function RecordingBanner({ onStop }: { onStop: () => void }) {
  return (
    <View style={styles.recordingBanner}>
      <View style={styles.recordingDot} />
      <Text style={styles.recordingText}>Gravando nota de voz...</Text>
      <Pressable style={styles.recordingStopBtn} onPress={onStop}>
        <Text style={styles.recordingStopText}>Parar</Text>
      </Pressable>
    </View>
  );
}

/**
 * Barra inferior estilo Keep: mídia + 🎨 paleta + ⋯ menu.
 * A lógica (câmera, gravação, autosave da cor) fica na tela — aqui é só
 * a superfície de toque.
 */
interface NoteEditToolbarProps {
  showColors: boolean;
  onToggleColors: () => void;
  busyAtt: boolean;
  recording: boolean;
  onPickImage: (useCamera: boolean) => void;
  onToggleRecording: () => void;
  onPickColor: (id: string) => void;
  onOpenSheet: () => void;
  color: string;
  bottomInset: number;
}

export default function NoteEditToolbar({
  showColors,
  onToggleColors,
  busyAtt,
  recording,
  onPickImage,
  onToggleRecording,
  onPickColor,
  onOpenSheet,
  color,
  bottomInset,
}: NoteEditToolbarProps) {
  return (
    <View style={[styles.toolbar, { paddingBottom: bottomInset + 8 }]}>
      {showColors && (
        <View style={styles.swatches}>
          {NOTE_COLOR_IDS.map((id) => (
            <Pressable
              key={id}
              onPress={() => onPickColor(id)}
              style={[
                styles.swatch,
                { backgroundColor: NOTE_COLOR_SWATCH[id] },
                color === id && styles.swatchActive,
              ]}
            />
          ))}
        </View>
      )}
      <View style={styles.toolbarRow}>
        <View style={styles.toolGroup}>
          {busyAtt ? (
            <View style={styles.toolBtn}>
              <ActivityIndicator size="small" color="#fbbf24" />
            </View>
          ) : (
            <>
              <Pressable onPress={() => onPickImage(true)} hitSlop={6} style={({ pressed }) => [styles.toolBtn, pressed && { opacity: 0.8 }]}>
                <Text style={styles.toolIcon}>📷</Text>
              </Pressable>
              <Pressable onPress={() => onPickImage(false)} hitSlop={6} style={({ pressed }) => [styles.toolBtn, pressed && { opacity: 0.8 }]}>
                <Text style={styles.toolIcon}>🖼️</Text>
              </Pressable>
              <Pressable
                onPress={onToggleRecording}
                hitSlop={6}
                style={({ pressed }) => [styles.toolBtn, recording && styles.recordingBtn, pressed && { opacity: 0.8 }]}
              >
                <Text style={styles.toolIcon}>{recording ? "⏹" : "🎙"}</Text>
              </Pressable>
              <Pressable onPress={onToggleColors} hitSlop={6} style={({ pressed }) => [styles.toolBtn, pressed && { opacity: 0.8 }]}>
                <Text style={styles.toolIcon}>🎨</Text>
                <View style={[styles.toolDot, { backgroundColor: NOTE_COLOR_SWATCH[color] }]} />
              </Pressable>
            </>
          )}
        </View>
        <Pressable
          onPress={onOpenSheet}
          hitSlop={6}
          style={({ pressed }) => [styles.toolBtn, pressed && { opacity: 0.8 }]}
        >
          <Text style={styles.toolIcon}>⋯</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  swatches: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    paddingVertical: 12,
  },
  swatch: {
    width: 26,
    height: 26,
    borderRadius: 13,
  },
  swatchActive: {
    borderWidth: 2,
    borderColor: "#fbbf24",
  },
  toolbar: {
    backgroundColor: "#18181b",
    borderTopWidth: 1,
    borderTopColor: "#26262a",
    paddingTop: 8,
    paddingHorizontal: 14,
  },
  toolbarRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  toolGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  recordingBtn: {
    backgroundColor: "#450a0a",
    borderColor: "#ef4444",
  },
  toolBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#1c1c1f",
    borderWidth: 1,
    borderColor: "#2c2c31",
    alignItems: "center",
    justifyContent: "center",
  },
  toolIcon: {
    fontSize: 17,
    color: "#d4d4d8",
  },
  toolDot: {
    position: "absolute",
    right: 6,
    bottom: 6,
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: "#101012",
  },
  recordingBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#450a0a",
    borderWidth: 1,
    borderColor: "#ef4444",
    borderRadius: 12,
    marginHorizontal: 16,
    marginBottom: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  recordingDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#ef4444",
    marginRight: 8,
  },
  recordingText: {
    color: "#fecaca",
    fontSize: 13,
    fontWeight: "600",
    flex: 1,
  },
  recordingStopBtn: {
    backgroundColor: "#ef4444",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  recordingStopText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "700",
  },
});
