import { useEffect, useState } from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from "react-native";
import { displayUriFor } from "../../lib/attachments";
import type { AttachmentRow } from "../../lib/db";

/** Preview amplo de imagem no topo estilo Google Keep (Print 2) */
export default function KeepTopImage({
  att,
  onRemove,
}: {
  att: AttachmentRow;
  onRemove: () => void;
}) {
  const [uri, setUri] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    // displayUriFor resolve o cache local e, pro anexo do cofre, decifra
    // antes de mostrar (dek em memória)
    void displayUriFor(att).then((resolved) => {
      if (active) setUri(resolved);
    });
    return () => {
      active = false;
    };
  }, [att.id, att.storage_key]);

  if (!uri) {
    return (
      <View style={[styles.topImage, styles.topImageLoading]}>
        <ActivityIndicator size="small" color="#fbbf24" />
      </View>
    );
  }

  return (
    <View style={styles.topImageWrap}>
      <Image source={{ uri }} style={styles.topImage} resizeMode="cover" />
      <Pressable style={styles.topImageRemove} onPress={onRemove} hitSlop={8}>
        <Text style={styles.topImageRemoveText}>✕</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  topImageWrap: {
    position: "relative",
    borderRadius: 16,
    overflow: "hidden",
    backgroundColor: "#1c1c1f",
    borderWidth: 1,
    borderColor: "#27272a",
  },
  topImage: {
    width: "100%",
    height: 250,
    borderRadius: 16,
  },
  topImageLoading: {
    alignItems: "center",
    justifyContent: "center",
  },
  topImageRemove: {
    position: "absolute",
    top: 10,
    right: 10,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "rgba(0,0,0,0.65)",
    alignItems: "center",
    justifyContent: "center",
  },
  topImageRemoveText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "700",
  },
});
