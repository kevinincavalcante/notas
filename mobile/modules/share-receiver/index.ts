import { requireNativeModule } from "expo-modules-core";

/**
 * Módulo local que recebe o intent de compartilhamento do Android
 * ("Compartilhar com → Notas"). O lado nativo (Kotlin) copia os arquivos
 * de content:// pro cache do app e entrega uri/name/mime pro JS.
 */

export interface SharedFile {
  uri: string;
  name: string;
  mime: string;
}

export interface SharedPayload {
  text: string | null;
  subject?: string | null;
  files: SharedFile[];
}

type ShareReceiverNative = {
  /** Intent de cold-start: itens compartilhados que abriram o app (ou null) */
  getShared(): Promise<SharedPayload | null>;
} & {
  addListener(
    name: "onShareReceived",
    callback: (payload: SharedPayload) => void
  ): { remove(): void };
};

export default requireNativeModule("ShareReceiver") as unknown as ShareReceiverNative;
