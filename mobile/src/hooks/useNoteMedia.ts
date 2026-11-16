import { useRef, useState } from "react";
import { Alert } from "react-native";
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import {
  useAudioRecorder,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from "expo-audio";
import { notifyLocalChange } from "../lib/sync";
import {
  displayUriFor,
  uploadAttachment,
  deleteAttachment,
  type UploadInput,
} from "../lib/attachments";
import { getVaultDek } from "../lib/vault";
import { decryptString, isEncrypted } from "../../../lib/vault-crypto";
import type { AttachmentRow, NoteRow } from "../lib/db";

/**
 * Toda a lógica de MÍDIA da nota: câmera/galeria, gravação de voz, uploads
 * serializados e remoção de anexo. Código movido verbatim da tela — os
 * contratos das Lições Críticas (docs/LICOES-MIDIA-COFRE.md) valem aqui:
 *
 * - `mediaInFlightRef` (RETORNADO — o flushSave/descarte de nota vazia da
 *   tela lê o MESMO ref) impede autosave/background de descartar a nota
 *   enquanto há câmera/galeria/gravação/cifragem em andamento
 * - Ids capturados no INÍCIO do fluxo (savedRef pode ser zerado durante await)
 * - Rejeição nunca engolida: toda falha termina em Alert.alert
 * - Uploads serializados por cadeia de promises (nada de descarte silencioso)
 */
interface UseNoteMediaArgs {
  savedRef: { current: NoteRow | null };
  vaultRef: { current: boolean };
  latestRef: { current: { title: string; body: string; color: string } };
  touch: (field: "title" | "body", value: string) => void;
  loadAtts: () => void;
  scheduleQuiet: () => void;
  setAttachments: (updater: (prev: AttachmentRow[]) => AttachmentRow[]) => void;
}

export function useNoteMedia({
  savedRef,
  vaultRef,
  latestRef,
  touch,
  loadAtts,
  scheduleQuiet,
  setAttachments,
}: UseNoteMediaArgs) {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [recording, setRecording] = useState(false);
  const [busyAtt, setBusyAtt] = useState(false);
  const recordStartRef = useRef(0);

  // Mídia "em voo" (câmera/galeria abertas, gravando ou cifrando/upload).
  // O autosave em background (AppState) não pode descartar a nota como
  // "vazia" nesse período: abrir a câmera levava o app pro fundo, o flush
  // apagava a nota nova antes do anexo do cofre terminar de ser cifrado/salvo
  // e o fluxo morria em silêncio (savedRef nulo) — "nada acontece".
  const mediaInFlightRef = useRef(0);

  // Uploads serializados: o guard antigo "busyAtt → return null" DESCARTAVA
  // o anexo em silêncio quando dois fluxos se cruzavam (foto + áudio)
  const uploadChainRef = useRef<Promise<unknown>>(Promise.resolve());

  async function runUpload(input: UploadInput): Promise<AttachmentRow | null> {
    const run = async (): Promise<AttachmentRow | null> => {
      setBusyAtt(true);
      try {
        const att = await uploadAttachment(input);
        // Reflete na hora no editor + pré-aquece o cache de exibição do anexo
        // novo (o chip/foto aparece sem esperar o próximo sync)
        loadAtts();
        if (att) void displayUriFor(att);
        return att;
      } catch (e) {
        Alert.alert("Anexo", e instanceof Error ? e.message : String(e));
        return null;
      } finally {
        setBusyAtt(false);
      }
    };
    const next = uploadChainRef.current.then(run, run);
    uploadChainRef.current = next.catch(() => {});
    return next;
  }

  async function handleRemoveAttachment(att: AttachmentRow) {
    try {
      await deleteAttachment(att);
      setAttachments((prev) => prev.filter((a) => a.id !== att.id));
      const regex = new RegExp(`!?\\[[^\\]]*\\]\\(/api/attachments/${att.id}\\)\\n*`, "g");
      const current = latestRef.current.body || "";
      const nextBody = current.replace(regex, "").trim();
      if (nextBody !== current) {
        touch("body", nextBody);
      }
      notifyLocalChange();
      scheduleQuiet();
    } catch (e) {
      console.warn("Falha ao remover anexo:", e);
    }
  }

  async function pickImage(useCamera: boolean) {
    if (!savedRef.current) return;
    // Captura o id AGORA: abrir a câmera/galeria joga o app pro fundo e o
    // autosave roda — não depender de savedRef depois desse ponto.
    const noteId = savedRef.current.id;
    // Cofre: DEK tem que estar em memória ANTES de abrir a câmera — a Activity
    // do Android suspende o app e, se o auto-lock tiver zerado a chave, o
    // upload falharia silencioso lá na frente. Falha cedo, mensagem clara.
    if (vaultRef.current && !getVaultDek()) {
      Alert.alert(
        "Cofre travado",
        "O cofre foi travado (auto-lock). Saia da nota e destrave o cofre para anexar mídia.",
        [{ text: "OK" }]
      );
      return;
    }
    // Permissões ANTES de abrir a câmera/galeria — negação sem mensagem
    // confunde o usuário com "mídia não salva".
    if (useCamera) {
      const cam = await ImagePicker.requestCameraPermissionsAsync();
      if (!cam.granted) {
        Alert.alert(
          "Permissão de câmera",
          "O app não tem permissão para usar a câmera. Libere em Ajustes → Apps → Notas → Permissões.",
          [{ text: "OK" }]
        );
        return;
      }
    }
    // A partir daqui a câmera/galeria abre e o app vai pro fundo: o
    // mediaInFlightRef mantém a nota viva até o anexo estar registrado
    mediaInFlightRef.current += 1;
    try {
      const result = useCamera
        ? await ImagePicker.launchCameraAsync({ quality: 0.9 })
        : await ImagePicker.launchImageLibraryAsync({ quality: 0.9, selectionLimit: 5 });
      if (result.canceled || result.assets.length === 0) return;

      for (const asset of result.assets) {
        // Compressão no cliente (1600px/webp) — sobe pequeno, sharp afina no servidor
        let uri = asset.uri;
        let fileName = asset.fileName || `foto-${Date.now()}.jpg`;
        let mimeType = asset.mimeType || "image/jpeg";
        if (mimeType.startsWith("image/")) {
          try {
            const out = await ImageManipulator.manipulateAsync(
              asset.uri,
              [{ resize: { width: 1600 } }],
              { compress: 0.8, format: ImageManipulator.SaveFormat.WEBP }
            );
            uri = out.uri;
            fileName = fileName.replace(/\.[^.]+$/, "") + ".webp";
            mimeType = "image/webp";
          } catch (e) {
            console.warn("Compressão falhou, enviando original:", e);
          }
        }
        const att = await runUpload({
          uri,
          fileName,
          mimeType,
          noteId,
          // Nota do cofre: bytes/nome/mime saem cifrados (runUpload só repassa)
          encrypted: vaultRef.current || Boolean(savedRef.current?.is_vault) || undefined,
        });
        if (att) {
          // O file_name do anexo cifrado volta encriptado — o markdown do corpo
          // mantém o nome legível (a troca de uri é só na exibição, via displayUriFor)
          const dek = getVaultDek();
          const displayName =
            dek && isEncrypted(att.file_name)
              ? (() => {
                  try {
                    return decryptString(dek, att.file_name);
                  } catch {
                    return "arquivo";
                  }
                })()
              : att.file_name;
          // Insere a foto no corpo da nota como Markdown estilo Keep/Joplin
          const imgMarkdown = `\n\n![${displayName}](/api/attachments/${att.id})\n\n`;
          const currentBody = latestRef.current.body || "";
          const nextBody = currentBody ? `${currentBody.trimEnd()}${imgMarkdown}` : imgMarkdown.trim();
          touch("body", nextBody);
          loadAtts();
        }
      }
    } catch (e) {
      // Nunca em silêncio: o `void pickImage()` engolia rejeições e o usuário
      // só via "nada acontece" — qualquer falha inesperada vira alerta.
      console.warn("Falha ao anexar mídia:", e);
      Alert.alert("Anexo", e instanceof Error ? e.message : String(e));
    } finally {
      mediaInFlightRef.current -= 1;
    }
  }

  async function toggleRecording() {
    if (!savedRef.current) return;
    // Captura o id AGORA: o autosave em background pode rodar durante a
    // gravação/criptografia e não depender de savedRef depois desse ponto.
    const noteId = savedRef.current.id;
    if (recording) {
      setRecording(false);
      try {
        await recorder.stop();
        const uri = recorder.uri;
        if (uri) {
          await runUpload({
            uri,
            fileName: `audio-${Date.now()}.m4a`,
            mimeType: "audio/mp4",
            noteId,
            durationSeconds: (Date.now() - recordStartRef.current) / 1000,
            // Nota do cofre: áudio também sai cifrado
            encrypted: vaultRef.current || Boolean(savedRef.current?.is_vault) || undefined,
          });
        }
      } catch (e) {
        console.warn("Falha ao salvar gravação:", e);
        Alert.alert("Erro ao salvar áudio", e instanceof Error ? e.message : String(e));
      } finally {
        // Só solta a nota "em voo" depois do anexo registrado (fim da
        // criptografia/upload local) — o descarte de nota vazia espera
        mediaInFlightRef.current = Math.max(0, mediaInFlightRef.current - 1);
      }
      return;
    }
    // Cofre: DEK em memória ANTES de gravar (mesma proteção do pickImage)
    if (vaultRef.current && !getVaultDek()) {
      Alert.alert(
        "Cofre travado",
        "O cofre foi travado (auto-lock). Saia da nota e destrave o cofre para gravar áudio.",
        [{ text: "OK" }]
      );
      return;
    }
    // A gravação segura a nota "em voo" desde o início (o teclado fecha ao
    // tocar no 🎙 e o autosave disparava o descarte da nota vazia no meio)
    mediaInFlightRef.current += 1;
    let started = false;
    try {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(
          "Permissão de microfone",
          "O app não tem permissão para usar o microfone. Libere em Ajustes → Apps → Notas → Permissões para gravar notas de voz.",
          [{ text: "OK" }]
        );
        return;
      }
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      recordStartRef.current = Date.now();
      setRecording(true);
      started = true;
    } catch (e) {
      console.warn("Falha ao gravar:", e);
      Alert.alert("Erro ao gravar áudio", e instanceof Error ? e.message : String(e));
    } finally {
      if (!started) mediaInFlightRef.current = Math.max(0, mediaInFlightRef.current - 1);
    }
  }

  return {
    recording,
    busyAtt,
    /** MESMO ref usado pelo flushSave da tela (descarte de nota vazia) */
    mediaInFlightRef,
    pickImage,
    toggleRecording,
    handleRemoveAttachment,
  };
}
