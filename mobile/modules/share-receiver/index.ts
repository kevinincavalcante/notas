import { requireNativeModule } from "expo-modules-core";

/**
 * Módulo local que recebe o intent de compartilhamento do Android
 * ("Compartilhar com → Notas"). O lado nativo (Kotlin) copia os arquivos
 * de content:// pro cache do app e entrega uri/name/mime pro JS.
 *
 * Contrato de entrega (não perder share no cold start):
 * - getShared(): lista os payloads ainda sem ack + o intent que abriu o app.
 *   Chamado no mount da Home, devolve [] na esmagadora maioria das vezes.
 * - onShareReceived: app já aberto, chegou novo share.
 * - ack(): só depois que o share virou nota. Antes disso o nativo mantém o
 *   payload na fila (Activity recriada devolve tudo no próximo getShared).
 */

export interface SharedFile {
  uri: string;
  name: string;
  mime: string;
}

export interface SharedPayload {
  id?: string;
  text: string | null;
  subject?: string | null;
  files: SharedFile[];
}

type ShareReceiverNative = {
  /** Payloads pendentes (+ intent de cold start), todos sem ack ainda */
  getShared(): Promise<unknown[]>;
  /** Marca como processado: o nativo remove os ids confirmados (ou tudo se vazio) */
  ack(ids?: string[] | null): Promise<void>;
} & {
  addListener(
    name: "onShareReceived",
    callback: (payload: SharedPayload) => void
  ): { remove(): void };
};

const native = (() => {
  try {
    return requireNativeModule<ShareReceiverNative>("ShareReceiver");
  } catch (e) {
    // Web/dev sem o módulo nativo (build antigo do APK): o share só não
    // chega — o resto do app continua funcionando.
    console.warn("ShareReceiver indisponível:", e);
    return null;
  }
})();

/**
 * `Map` cruza a ponte como ReadableMap e chega aqui como objeto comum —
 * normaliza os dois formatos (e descarta lixo em vez de quebrar a Home).
 */
function normalize(raw: unknown): SharedPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const id = typeof p.id === "string" && p.id ? p.id : undefined;
  const text = typeof p.text === "string" ? p.text : null;
  const subject = typeof p.subject === "string" ? p.subject : null;
  const files: SharedFile[] = Array.isArray(p.files)
    ? p.files.flatMap((f) => {
        if (!f || typeof f !== "object") return [];
        const file = f as Record<string, unknown>;
        if (typeof file.uri !== "string" || !file.uri) return [];
        return [
          {
            uri: file.uri,
            name: typeof file.name === "string" ? file.name : "",
            mime: typeof file.mime === "string" ? file.mime : "application/octet-stream",
          },
        ];
      })
    : [];
  if (!text?.trim() && !subject?.trim() && files.length === 0) return null;
  return { id, text, subject, files };
}

const ShareReceiver = {
  async getShared(): Promise<SharedPayload[]> {
    if (!native) return [];
    try {
      const raw = await native.getShared();
      if (!Array.isArray(raw)) return [];
      return raw.map(normalize).filter((p): p is SharedPayload => p !== null);
    } catch (e) {
      console.warn("ShareReceiver.getShared falhou:", e);
      return [];
    }
  },
  async ack(ids?: string[]): Promise<void> {
    if (!native) return;
    try {
      await native.ack(ids ?? null);
    } catch {
      // fica na fila nativa: pior caso, reentrega no próximo boot (idempotente)
    }
  },
  addListener(
    name: "onShareReceived",
    callback: (payload: SharedPayload) => void
  ): { remove(): void } {
    if (!native) return { remove() {} };
    return native.addListener(name, (raw) => {
      const payload = normalize(raw);
      if (payload) callback(payload);
    });
  },
};

export default ShareReceiver;
