import { View, StyleSheet } from "react-native";
import { AudioBar, FileChip } from "../AttachmentStrip";
import type { AttachmentRow } from "../../lib/db";

/**
 * Lista de áudios + arquivos no corpo da nota (barras largas estilo fotos).
 * Leitura: sem remoção e sem os arquivos REFERENCIADOS no corpo (viram chip
 * dentro da WebView via notasfile://). Edição: tudo removível.
 */
interface AttachmentChipsProps {
  audioAttachments: AttachmentRow[];
  fileAttachments: AttachmentRow[];
  onRemove?: (att: AttachmentRow) => void;
  /** ids de arquivos referenciados no corpo (não repetir chip avulso) */
  excludeFileIds?: string[];
}

export default function AttachmentChips({
  audioAttachments,
  fileAttachments,
  onRemove,
  excludeFileIds = [],
}: AttachmentChipsProps) {
  if (audioAttachments.length === 0 && fileAttachments.length === 0) return null;
  return (
    <View style={styles.audioChipsContainer}>
      {audioAttachments.map((audio) => (
        <AudioBar key={audio.id} att={audio} onRemove={onRemove} />
      ))}
      {fileAttachments
        .filter((file) => !excludeFileIds.includes(file.id))
        .map((file) => (
          <FileChip key={file.id} att={file} onRemove={onRemove} />
        ))}
    </View>
  );
}

const styles = StyleSheet.create({
  audioChipsContainer: {
    flexDirection: "column",
    gap: 8,
    marginBottom: 12,
  },
});
