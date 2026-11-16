import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import { shareAttachmentFile } from "../AttachmentStrip";
import AttachmentChips from "./AttachmentChips";
import KeepTopImage from "./KeepTopImage";
import { bodyToHtml } from "../../lib/markdown-html";
import type { LinkMeta } from "../../lib/link-meta";
import type { AttachmentRow } from "../../lib/db";

/**
 * Modo leitura da nota: preview markdown selecionável (estilo desktop).
 * WebView rola POR DENTRO — dentro de ScrollView ela colapsa a zero.
 * Cards de link estilo WhatsApp chegam prontos em `linkMetaMap` (buscados
 * pelo efeito da tela; notas do cofre vêm vazio).
 */
interface NoteReadModeProps {
  title: string;
  body: string;
  bodyImgUris: Record<string, string>;
  linkMetaMap: Record<string, LinkMeta>;
  bodyUrisSignature: string;
  bodyUrisPending: string[];
  imageAttachments: AttachmentRow[];
  audioAttachments: AttachmentRow[];
  fileAttachments: AttachmentRow[];
  attachments: AttachmentRow[];
  bodyImgIds: string[];
}

export default function NoteReadMode({
  title,
  body,
  bodyImgUris,
  linkMetaMap,
  bodyUrisSignature,
  bodyUrisPending,
  imageAttachments,
  audioAttachments,
  fileAttachments,
  attachments,
  bodyImgIds,
}: NoteReadModeProps) {
  return (
    <View style={{ flex: 1, paddingHorizontal: 20 }}>
      <Text selectable style={styles.readTitle}>
        {title || "Sem título"}
      </Text>
      {/* Áudio e arquivos no corpo da leitura (igual fotos inline) */}
      <AttachmentChips
        audioAttachments={audioAttachments}
        fileAttachments={fileAttachments}
        excludeFileIds={bodyImgIds}
      />
      {/* Mídias do corpo ainda baixando/decifrando: indicador + previews
          NATIVOS no lugar da WebView (instantâneos, sem depender dela) */}
      {bodyUrisPending.length > 0 ? (
        <View style={{ flex: 1 }}>
          <View style={styles.decryptingRow}>
            <ActivityIndicator size="small" color="#fbbf24" />
            <Text style={styles.decryptingText}>
              Descriptografando mídias… ({Math.max(0, imageAttachments.length - bodyUrisPending.length)}/{imageAttachments.length})
            </Text>
          </View>
          <ScrollView contentContainerStyle={{ paddingHorizontal: 0 }}>
            {imageAttachments.map((img) => (
              <KeepTopImage key={img.id} att={img} onRemove={() => {}} />
            ))}
          </ScrollView>
        </View>
      ) : (
      <WebView
        key={`read-${bodyUrisSignature}-${Object.keys(linkMetaMap).length}`}
        source={{ html: bodyToHtml(body, bodyImgUris, linkMetaMap), baseUrl: "file:///" }}
        style={styles.readBody}
        backgroundColor="transparent"
        javaScriptEnabled={false}
        originWhitelist={["*"]}
        allowFileAccess={true}
        setSupportMultipleWindows={false}
        onShouldStartLoadWithRequest={(req) => {
          // Chip de ARQUIVO no corpo: decifra em memória e abre o
          // compartilhar do Android (salvar em Arquivos, enviar...)
          if (req.url.startsWith("notasfile://")) {
            const id = req.url.replace("notasfile://", "").split("?")[0];
            const att = attachments.find((a) => a.id === id);
            if (att) void shareAttachmentFile(att);
            return false;
          }
          // Links do markdown (e cards de link) abrem no navegador do sistema
          if (req.url.startsWith("http")) {
            import("react-native").then(({ Linking }) => void Linking.openURL(req.url));
            return false;
          }
          return true;
        }}
      />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  readTitle: {
    color: "#fafafa",
    fontSize: 26,
    fontWeight: "700",
    marginBottom: 8,
    paddingHorizontal: 0,
  },
  readBody: {
    flex: 1,
    backgroundColor: "transparent",
  },
  decryptingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 10,
  },
  decryptingText: {
    color: "#a1a1aa",
    fontSize: 13,
  },
});
