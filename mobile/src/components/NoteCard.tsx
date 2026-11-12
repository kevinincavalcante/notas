import { Pressable, StyleSheet, Text, View } from "react-native";
import type { NoteRow } from "../lib/db";
import { colorBg } from "../lib/colors";

/** Bloco estilo OneNote: título + prévia do corpo (3 linhas) + tags. */
export default function NoteCard({
  note,
  tags,
  onPress,
  onLongPress,
}: {
  note: NoteRow;
  tags: string[];
  onPress: () => void;
  onLongPress: () => void;
}) {
  const preview = note.body.replace(/[#>*`\-_[\]()!]/g, " ").replace(/\s+/g, " ").trim();
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      style={({ pressed }) => [styles.block, { backgroundColor: colorBg(note.color) }, pressed && styles.pressed]}
    >
      <View style={styles.titleRow}>
        <Text style={styles.title} numberOfLines={1}>
          {note.title || "Sem título"}
        </Text>
        {Boolean(note.is_pinned) && <Text style={styles.pin}>📌</Text>}
      </View>
      {preview.length > 0 && <Text style={styles.preview} numberOfLines={3}>{preview}</Text>}
      {tags.length > 0 && (
        <View style={styles.tags}>
          {tags.slice(0, 3).map((name) => (
            <Text key={name} style={styles.tag}>
              {name}
            </Text>
          ))}
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  block: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#26262a",
    paddingHorizontal: 15,
    paddingTop: 13,
    paddingBottom: 14,
    marginBottom: 10,
  },
  pressed: {
    opacity: 0.85,
    transform: [{ scale: 0.99 }],
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  title: {
    color: "#fafafa",
    fontWeight: "600",
    fontSize: 15,
    flex: 1,
  },
  pin: {
    fontSize: 12,
  },
  preview: {
    color: "#9b9ba3",
    fontSize: 13.5,
    lineHeight: 20,
    marginTop: 4,
  },
  tags: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 9,
  },
  tag: {
    fontSize: 10.5,
    color: "#8f8f98",
    backgroundColor: "#242428",
    borderRadius: 99,
    overflow: "hidden",
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
});
