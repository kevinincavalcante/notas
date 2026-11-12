import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { TagRow } from "../lib/db";

/**
 * Chips de marcadores na horizontal (o lugar da "lista de blocos" do
 * OneNote). "Recentes" = todas; tocar numa tag filtra os blocos.
 * O fade na borda direita indica que dá pra deslizar.
 */
export default function ChipsRow({
  tags,
  active,
  onSelect,
}: {
  tags: TagRow[];
  active: string | null;
  onSelect: (tagId: string | null) => void;
}) {
  return (
    <View style={styles.fadeWrap}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chips}
      >
        <Chip label="Recentes" active={active === null} onPress={() => onSelect(null)} />
        {tags.map((tag) => (
          <Chip
            key={tag.id}
            label={tag.name}
            active={active === tag.id}
            onPress={() => onSelect(tag.id)}
          />
        ))}
      </ScrollView>
    </View>
  );
}

function Chip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, active && styles.chipActive]}
      hitSlop={4}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fadeWrap: {
    backgroundColor: "#18181b",
    position: "relative",
  },
  chips: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 10,
    paddingTop: 4,
  },
  chip: {
    flexShrink: 0,
    paddingHorizontal: 15,
    paddingVertical: 8,
    borderRadius: 99,
    backgroundColor: "#232326",
    borderWidth: 1,
    borderColor: "transparent",
    maxWidth: 160,
  },
  chipActive: {
    backgroundColor: "#fbbf24",
  },
  chipText: {
    color: "#a1a1aa",
    fontSize: 13.5,
  },
  chipTextActive: {
    color: "#1c1917",
    fontWeight: "700",
  },
});
