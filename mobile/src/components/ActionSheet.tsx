import { Modal, Pressable, StyleSheet, Text, View } from "react-native";

export interface ActionItem {
  label: string;
  onPress: () => void;
  destructive?: boolean;
}

/**
 * Menu de ações — aberto no long-press do bloco (e no ⋯ do editor):
 * Fixar/Desfixar, Arquivar/Desarquivar, Excluir.
 */
export default function ActionSheet({
  visible,
  items,
  onClose,
}: {
  visible: boolean;
  items: ActionItem[];
  onClose: () => void;
}) {
  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <View style={styles.sheet}>
          {items.map((item, i) => (
            <Pressable
              key={`${item.label}-${i}`}
              style={({ pressed }) => [styles.item, pressed && styles.itemPressed]}
              onPress={() => {
                onClose();
                item.onPress();
              }}
            >
              <Text style={[styles.itemText, item.destructive && styles.itemDestructive]}>
                {item.label}
              </Text>
            </Pressable>
          ))}
          <Pressable style={[styles.item, styles.cancel]} onPress={onClose}>
            <Text style={styles.cancelText}>Cancelar</Text>
          </Pressable>
        </View>
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
    paddingBottom: 18,
  },
  item: {
    paddingVertical: 15,
    paddingHorizontal: 22,
  },
  itemPressed: {
    backgroundColor: "#2a2a2f",
  },
  itemText: {
    color: "#fafafa",
    fontSize: 16,
  },
  itemDestructive: {
    color: "#f87171",
    fontWeight: "600",
  },
  cancel: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#2f2f35",
    marginTop: 4,
  },
  cancelText: {
    color: "#a1a1aa",
    fontSize: 16,
    textAlign: "center",
  },
});
