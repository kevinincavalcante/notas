"use client";

import { useState, useRef, useEffect } from "react";
import { Note, Attachment, NoteVersion } from "@/types/note";
import {
  Pin,
  Archive,
  ArchiveRestore,
  Trash2,
  Image as ImageIcon,
  Mic,
  X,
  UploadCloud,
  History,
  RotateCcw,
  Clock,
} from "lucide-react";
import AudioPlayer from "./AudioPlayer";
import ColorPicker from "./ColorPicker";
import VoiceRecorder from "./VoiceRecorder";
import LinkPreview, { extractUrls } from "./LinkPreview";

interface NoteModalProps {
  note: Note;
  isOpen: boolean;
  onClose: () => void;
  onUpdate: (updatedNote: Partial<Note>) => Promise<void>;
  onDelete: () => Promise<void>;
  onAddAttachment: (attachment: Attachment) => void;
  onRemoveAttachment: (attachmentId: string) => void;
}

export default function NoteModal({
  note,
  isOpen,
  onClose,
  onUpdate,
  onDelete,
  onAddAttachment,
  onRemoveAttachment,
}: NoteModalProps) {
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [color, setColor] = useState(note.color);
  const [isPinned, setIsPinned] = useState(note.is_pinned);
  const [isArchived, setIsArchived] = useState(note.is_archived);
  const [isRecording, setIsRecording] = useState(false);
  const [uploading, setUploading] = useState(false);

  // Controle de Versões
  const [showHistory, setShowHistory] = useState(false);
  const [versions, setVersions] = useState<NoteVersion[]>([]);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const historyPushedRef = useRef(false);

  // Mantém referência dos dados mais recentes para salvar com precisão
  const latestStateRef = useRef({ title, body, color, isPinned, isArchived });
  useEffect(() => {
    latestStateRef.current = { title, body, color, isPinned, isArchived };
  }, [title, body, color, isPinned, isArchived]);

  useEffect(() => {
    setTitle(note.title);
    setBody(note.body);
    setColor(note.color);
    setIsPinned(note.is_pinned);
    setIsArchived(note.is_archived);
    setShowHistory(false);
  }, [note]);

  // Intercepta o botão "Voltar" do navegador/Android no celular para fechar a nota
  useEffect(() => {
    if (!isOpen) return;

    window.history.pushState({ noteModalOpen: true }, "");
    historyPushedRef.current = true;

    const onPopState = () => {
      historyPushedRef.current = false;
      closeAndSave();
    };

    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
    };
  }, [isOpen]);

  // Carrega versões quando o painel de histórico é aberto
  async function loadVersions() {
    setLoadingVersions(true);
    try {
      const res = await fetch(`/api/notes/${note.id}/versions`);
      const data = await res.json();
      if (res.ok) {
        setVersions(data.versions || []);
      }
    } catch (err) {
      console.error("Erro ao carregar histórico de versões:", err);
    } finally {
      setLoadingVersions(false);
    }
  }

  function toggleHistory() {
    if (!showHistory) {
      loadVersions();
    }
    setShowHistory(!showHistory);
  }

  async function handleRestoreVersion(version: NoteVersion) {
    if (!confirm(`Deseja restaurar a versão de ${new Date(version.created_at).toLocaleString("pt-BR")}?`)) {
      return;
    }

    setRestoringId(version.id);
    try {
      const res = await fetch(`/api/notes/${note.id}/versions/${version.id}/restore`, {
        method: "POST",
      });
      const data = await res.json();
      if (res.ok && data.restored) {
        setTitle(data.restored.title);
        setBody(data.restored.body);
        await onUpdate({
          title: data.restored.title,
          body: data.restored.body,
        });
        await loadVersions();
      } else {
        alert(data.error || "Erro ao restaurar versão");
      }
    } catch (err) {
      console.error(err);
      alert("Falha ao restaurar versão.");
    } finally {
      setRestoringId(null);
    }
  }

  async function closeAndSave() {
    const current = latestStateRef.current;
    if (
      current.title !== note.title ||
      current.body !== note.body ||
      current.color !== note.color ||
      current.isPinned !== note.is_pinned ||
      current.isArchived !== note.is_archived
    ) {
      await onUpdate({
        title: current.title,
        body: current.body,
        color: current.color,
        is_pinned: current.isPinned,
        is_archived: current.isArchived,
      });
    }
    onClose();
  }

  function handleManualClose() {
    if (historyPushedRef.current) {
      historyPushedRef.current = false;
      window.history.back();
    }
    closeAndSave();
  }

  async function uploadImageFile(file: File) {
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("noteId", note.id);

      const res = await fetch("/api/attachments/upload", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "Erro no upload");
      } else {
        onAddAttachment(data.attachment);
      }
    } catch (err) {
      console.error(err);
      alert("Falha ao enviar arquivo.");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    await uploadImageFile(file);
  }

  // Suporte a colar imagem (Ctrl+V) direto do Flameshot ou clipboard
  function handlePaste(e: React.ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          const namedFile = new File([file], `screenshot_${Date.now()}.png`, {
            type: file.type || "image/png",
          });
          uploadImageFile(namedFile);
        }
      }
    }
  }

  async function handleVoiceRecorded(blob: Blob, durationSeconds: number) {
    setIsRecording(false);
    setUploading(true);

    try {
      const file = new File([blob], `audio_${Date.now()}.webm`, { type: blob.type });
      const formData = new FormData();
      formData.append("file", file);
      formData.append("noteId", note.id);
      formData.append("duration", durationSeconds.toString());

      const res = await fetch("/api/attachments/upload", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "Erro ao salvar áudio");
      } else {
        onAddAttachment(data.attachment);
      }
    } catch (err) {
      console.error(err);
      alert("Falha ao enviar áudio.");
    } finally {
      setUploading(false);
    }
  }

  async function handleDeleteAttachment(attachmentId: string) {
    if (!confirm("Deseja realmente remover este anexo?")) return;
    try {
      await fetch(`/api/attachments/${attachmentId}`, { method: "DELETE" });
      onRemoveAttachment(attachmentId);
    } catch (err) {
      console.error(err);
      alert("Erro ao remover anexo");
    }
  }

  if (!isOpen) return null;

  const imageAttachments = note.attachments?.filter((a) => a.mime_type.startsWith("image/")) || [];
  const audioAttachments = note.attachments?.filter((a) => a.mime_type.startsWith("audio/")) || [];
  const detectedUrls = extractUrls(body);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs cursor-pointer"
      onClick={handleManualClose}
      onPaste={handlePaste}
    >
      <div
        className={`w-full max-w-2xl max-h-[90vh] rounded-2xl shadow-2xl border flex flex-col overflow-hidden cursor-default note-color-${color}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header com Pin, Histórico e Fechar */}
        <div className="p-4 flex items-center justify-between border-b border-black/5 dark:border-white/5">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setIsPinned(!isPinned)}
              title={isPinned ? "Desafixar" : "Fixar"}
              className={`p-2 rounded-full transition ${
                isPinned
                  ? "text-amber-500 bg-amber-500/10"
                  : "text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/10"
              }`}
            >
              <Pin className={`w-5 h-5 ${isPinned ? "fill-amber-500" : ""}`} />
            </button>

            <button
              type="button"
              onClick={toggleHistory}
              title="Histórico de versões"
              className={`p-2 rounded-full transition flex items-center gap-1.5 text-xs font-medium ${
                showHistory
                  ? "bg-amber-500 text-slate-950 font-semibold"
                  : "text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/10"
              }`}
            >
              <History className="w-4 h-4" />
              <span className="hidden sm:inline">Histórico</span>
            </button>
          </div>

          <button
            type="button"
            onClick={handleManualClose}
            className="p-2 text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/10 rounded-full transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Painel de Histórico de Versões (retrátil) */}
        {showHistory && (
          <div className="p-4 bg-black/5 dark:bg-black/30 border-b border-black/10 dark:border-white/10 max-h-60 overflow-y-auto space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-amber-500" />
                Versões Anteriores ({versions.length})
              </h4>
              <button
                type="button"
                onClick={() => setShowHistory(false)}
                className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              >
                Ocultar
              </button>
            </div>

            {loadingVersions ? (
              <div className="text-xs text-slate-400 py-4 text-center">
                Carregando versões anteriores...
              </div>
            ) : versions.length === 0 ? (
              <div className="text-xs text-slate-500 dark:text-slate-400 py-3 text-center italic">
                Nenhuma versão anterior gravada ainda. Novas versões são salvas automaticamente a cada alteração no texto.
              </div>
            ) : (
              <div className="space-y-2">
                {versions.map((v) => (
                  <div
                    key={v.id}
                    className="p-2.5 rounded-xl bg-white/70 dark:bg-slate-800/70 border border-black/5 dark:border-white/5 flex items-start justify-between gap-3 text-xs"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-slate-900 dark:text-white truncate">
                        {v.title || "Sem título"}
                      </div>
                      <div className="text-slate-500 dark:text-slate-400 text-[11px] line-clamp-2 mt-0.5 whitespace-pre-wrap font-normal">
                        {v.body || "Vazio"}
                      </div>
                      <div className="text-[10px] text-amber-600 dark:text-amber-400 mt-1 font-mono">
                        {new Date(v.created_at).toLocaleString("pt-BR", {
                          dateStyle: "short",
                          timeStyle: "short",
                        })}
                      </div>
                    </div>

                    <button
                      type="button"
                      disabled={restoringId === v.id}
                      onClick={() => handleRestoreVersion(v)}
                      title="Restaurar esta versão"
                      className="shrink-0 p-1.5 px-2.5 bg-amber-500 hover:bg-amber-600 text-slate-950 font-semibold rounded-lg flex items-center gap-1 text-[11px] transition disabled:opacity-50"
                    >
                      <RotateCcw className="w-3 h-3" />
                      {restoringId === v.id ? "Restaurando..." : "Restaurar"}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Conteúdo rolável */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {/* Previews de Imagem */}
          {imageAttachments.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {imageAttachments.map((img) => (
                <div key={img.id} className="relative group rounded-xl overflow-hidden border border-black/10">
                  <img
                    src={`/api/attachments/${img.id}`}
                    alt={img.file_name}
                    className="w-full h-44 object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => handleDeleteAttachment(img.id)}
                    className="absolute top-2 right-2 p-1.5 bg-black/60 text-white rounded-lg opacity-0 group-hover:opacity-100 transition hover:bg-red-600"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Inputs de Título e Corpo */}
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Título"
            className="w-full text-xl font-bold bg-transparent border-none outline-none text-slate-900 dark:text-white placeholder-slate-400"
          />

          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Criar uma nota..."
            rows={6}
            className="w-full text-base bg-transparent border-none outline-none resize-none text-slate-700 dark:text-slate-200 placeholder-slate-400 leading-relaxed font-normal"
          />

          {/* Previews de Links Ricos (YouTube, Sites, etc.) */}
          {detectedUrls.length > 0 && (
            <div className="space-y-3 pt-2 border-t border-black/5 dark:border-white/5">
              <h4 className="text-xs font-semibold text-slate-500 uppercase">Links Detectados</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {detectedUrls.map((url) => (
                  <LinkPreview key={url} url={url} />
                ))}
              </div>
            </div>
          )}

          {/* Áudios */}
          {audioAttachments.length > 0 && (
            <div className="space-y-2 pt-2 border-t border-black/5 dark:border-white/5">
              <h4 className="text-xs font-semibold text-slate-500 uppercase">Gravações de Voz</h4>
              {audioAttachments.map((audio) => (
                <div key={audio.id} className="flex items-center gap-2">
                  <div className="flex-1">
                    <AudioPlayer
                      src={`/api/attachments/${audio.id}`}
                      durationSeconds={audio.duration_seconds}
                      fileName={audio.file_name}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDeleteAttachment(audio.id)}
                    className="p-2 text-slate-400 hover:text-red-500 transition"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Gravador de Áudio ativo */}
          {isRecording && (
            <VoiceRecorder
              onRecorded={handleVoiceRecorded}
              onCancel={() => setIsRecording(false)}
            />
          )}

          {uploading && (
            <div className="flex items-center gap-2 p-3 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded-xl text-amber-700 dark:text-amber-300 text-xs font-medium">
              <UploadCloud className="w-4 h-4 animate-bounce" />
              Otimizando e enviando captura para o Cloudflare R2...
            </div>
          )}
        </div>

        {/* Rodapé de Ações */}
        <div className="p-4 flex items-center justify-between border-t border-black/5 dark:border-white/5 bg-black/5 dark:bg-black/20">
          <div className="flex items-center gap-2">
            <ColorPicker selectedColor={color} onSelectColor={setColor} />

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              title="Adicionar imagem"
              className="p-2 text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/10 rounded-full transition"
            >
              <ImageIcon className="w-4 h-4" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleFileUpload}
            />

            <button
              type="button"
              onClick={() => setIsRecording(true)}
              title="Gravar áudio"
              className="p-2 text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/10 rounded-full transition"
            >
              <Mic className="w-4 h-4" />
            </button>

            <button
              type="button"
              onClick={() => setIsArchived(!isArchived)}
              title={isArchived ? "Desarquivar nota" : "Arquivar nota"}
              className="p-2 text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/10 rounded-full transition"
            >
              {isArchived ? <ArchiveRestore className="w-4 h-4" /> : <Archive className="w-4 h-4" />}
            </button>

            <button
              type="button"
              onClick={onDelete}
              title="Excluir nota"
              className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40 rounded-full transition"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>

          <button
            type="button"
            onClick={handleManualClose}
            className="px-5 py-2 bg-slate-900 hover:bg-slate-800 dark:bg-white dark:hover:bg-slate-100 text-white dark:text-slate-900 rounded-xl font-medium text-sm transition"
          >
            Concluir
          </button>
        </div>
      </div>
    </div>
  );
}
