import { Pressable, StyleSheet, Text, View } from "react-native";

/** Barra superior: avatar (config) à esquerda, ações à direita. */
export default function TopBar({
  user,
  onAvatar,
  right,
}: {
  user: string | null;
  onAvatar: () => void;
  right?: { label: string; onPress: () => void }[];
}) {
  return (
    <View style={styles.top}>
      <Pressable onPress={onAvatar} hitSlop={8}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{(user?.[0] || "?").toUpperCase()}</Text>
        </View>
      </Pressable>
      <View style={styles.right}>
        {right?.map((item) => (
          <Pressable key={item.label} onPress={item.onPress} hitSlop={8}>
            <Text style={styles.icon}>{item.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  top: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingTop: 12,
    paddingBottom: 8,
    backgroundColor: "#18181b",
  },
  avatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "#fbbf24",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    color: "#1c1917",
    fontWeight: "800",
    fontSize: 15,
  },
  right: {
    flexDirection: "row",
    gap: 22,
  },
  icon: {
    color: "#d4d4d8",
    fontSize: 21,
  },
});
