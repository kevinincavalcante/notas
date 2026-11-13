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
  Bold,
  Italic,
  Strikethrough,
  Heading2,
  List,
  ListOrdered,
  ListTodo,
  Quote,
  Code2,
  SquareCode,
  Link2,
  Minus,
  ImagePlus,
  Maximize2,
  Minimize2,
  Columns,
  Eye,
  PenLine,
  FileText,
} from "lucide-react";
import AudioPlayer from "./AudioPlayer";
import ColorPicker from "./ColorPicker";
import VoiceRecorder from "./VoiceRecorder";
import LinkPreview, { extractUrls } from "./LinkPreview";
import MarkdownView from "./MarkdownView";
import { useUI } from "./UIProvider";

interface NoteModalProps {
  note: Note;
  isOpen: boolean;
  onClose: () => void;
  onUpdate: (updatedNote: Partial<Note> & { skipPatch?: boolean }) => Promise<void>;
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
  const { confirm, showToast } = useUI();
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [color, setColor] = useState(note.color);
  const [isPinned, setIsPinned] = useState(note.is_pinned);
  const [isArchived, setIsArchived] = useState(note.is_archived);
  const [isRecording, setIsRecording] = useState(false);
  const [uploading, setUploading] = useState(false);

  // Modo de visualização estilo Notion/Obsidian: "split" (lado a lado), "edit" (foco na escrita) ou "preview" (leitura limpa)
  const [viewMode, setViewMode] = useState<"split" | "edit" | "preview">("split");
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Controle de Versões
  const [showHistory, setShowHistory] = useState(false);
  const [versions, setVersions] = useState<NoteVersion[]>([]);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const bodyTextareaRef = useRef<HTMLTextAreaElement>(null);
  const historyPushedRef = useRef(false);
  const isClosingRef = useRef(false);

  // Mantém referência dos dados mais recentes para salvar com precisão
  const latestStateRef = useRef({ title, body, color, isPinned, isArchived });
  useEffect(() => {
    latestStateRef.current = { title, body, color, isPinned, isArchived };
  }, [title, body, color, isPinned, isArchived]);

  // Reseta os campos apenas ao abrir OUTRA nota (id muda)
  useEffect(() => {
    setTitle(note.title);
    setBody(repairImageTitles(note.body));
    setColor(note.color);
    setIsPinned(note.is_pinned);
    setIsArchived(note.is_archived);
    setShowHistory(false);
    isClosingRef.current = false;
    // Em telas pequenas (mobile), o padrão mais funcional é "edit"
    if (typeof window !== "undefined" && window.innerWidth < 768) {
      setViewMode("edit");
    } else {
      setViewMode("split");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id]);

  // Intercepta o botão "Voltar" do navegador/Android no celular para fechar a nota
  useEffect(() => {
    if (!isOpen) return;

    window.history.pushState({ noteModalOpen: true }, "");
    historyPushedRef.current = true;
    isClosingRef.current = false;

    const onPopState = () => {
      if (isClosingRef.current) return;
      isClosingRef.current = true;
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
    const next = !showHistory;
    setShowHistory(next);
    if (next) {
      loadVersions();
    }
  }

  async function handleRestoreVersion(version: NoteVersion) {
    setRestoringId(version.id);
    try {
      const res = await fetch(`/api/notes/${note.id}/versions/${version.id}/restore`, {
        method: "POST",
      });
      const data = await res.json();
      if (res.ok && data.note) {
        setTitle(data.note.title);
        setBody(data.note.body);
        setColor(data.note.color);
        setIsPinned(data.note.is_pinned);
        setIsArchived(data.note.is_archived);

        await onUpdate({
          title: data.note.title,
          body: data.note.body,
          color: data.note.color,
          is_pinned: data.note.is_pinned,
          is_archived: data.note.is_archived,
          skipPatch: true,
        });

        loadVersions();
      }
    } catch (err) {
      console.error("Erro ao restaurar versão:", err);
    } finally {
      setRestoringId(null);
    }
  }

  function closeAndSave() {
    const current = latestStateRef.current;
    if (
      current.title !== note.title ||
      current.body !== note.body ||
      current.color !== note.color ||
      current.isPinned !== note.is_pinned ||
      current.isArchived !== note.is_archived
    ) {
      onUpdate({
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
    if (isClosingRef.current) return;
    isClosingRef.current = true;
    if (historyPushedRef.current) {
      historyPushedRef.current = false;
      window.history.back();
    }
    closeAndSave();
  }

  async function uploadImageFile(file: File, atIndex?: number | null) {
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      // Envia ambos os formatos para garantir compatibilidade
      formData.append("noteId", note.id);
      formData.append("note_id", note.id);

      const res = await fetch("/api/attachments/upload", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();
      if (res.ok && data.attachment) {
        onAddAttachment(data.attachment);

        const el = bodyTextareaRef.current;
        const currentBody = latestStateRef.current.body;
        const insertPos =
          typeof atIndex === "number"
            ? atIndex
            : el && typeof el.selectionStart === "number"
            ? el.selectionStart
            : currentBody.length;

        const markdownImage = `\n\n![${data.attachment.file_name}](/api/attachments/${data.attachment.id})\n\n`;
        const updatedBody =
          currentBody.slice(0, insertPos) + markdownImage + currentBody.slice(insertPos);

        setBody(updatedBody);
        latestStateRef.current.body = updatedBody;

        onUpdate({
          title: latestStateRef.current.title,
          body: updatedBody,
          color: latestStateRef.current.color,
          is_pinned: latestStateRef.current.isPinned,
          is_archived: latestStateRef.current.isArchived,
        });

        requestAnimationFrame(() => {
          if (el) {
            const newPos = insertPos + markdownImage.length;
            el.focus();
            el.setSelectionRange(newPos, newPos);
          }
        });
      } else {
        showToast("Falha no upload: " + (data.error || "Erro desconhecido"), "error");
      }
    } catch (err) {
      console.error("Erro no upload de imagem:", err);
      showToast("Erro ao enviar a imagem.", "error");
    } finally {
      setUploading(false);
    }
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    await uploadImageFile(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handlePaste(e: React.ClipboardEvent) {
    const items = Array.from(e.clipboardData?.items || []);
    const imageItem = items.find((item) => item.type.startsWith("image/"));

    if (imageItem) {
      e.preventDefault();
      const file = imageItem.getAsFile();
      if (file) {
        await uploadImageFile(file);
      }
    }
  }

  async function handleVoiceRecorded(blob: Blob, durationSeconds: number) {
    setIsRecording(false);
    setUploading(true);

    try {
      const formData = new FormData();
      formData.append("file", blob, `audio-${Date.now()}.webm`);
      formData.append("noteId", note.id);
      formData.append("note_id", note.id);
      formData.append("duration", String(durationSeconds));
      formData.append("duration_seconds", String(durationSeconds));

      const res = await fetch("/api/attachments/upload", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();
      if (res.ok && data.attachment) {
        onAddAttachment(data.attachment);
      } else {
        showToast("Falha ao salvar áudio: " + (data.error || "Erro desconhecido"), "error");
      }
    } catch (err) {
      console.error("Erro no upload de voz:", err);
      showToast("Erro ao enviar áudio.", "error");
    } finally {
      setUploading(false);
    }
  }

  async function handleDeleteAttachment(attachmentId: string) {
    const confirmed = await confirm({
      title: "Remover anexo",
      message: "Tem certeza que deseja remover este anexo? O arquivo será excluído permanentemente.",
      confirmText: "Remover",
      variant: "danger",
    });
    if (!confirmed) return;

    try {
      const res = await fetch(`/api/attachments/${attachmentId}`, {
        method: "DELETE",
      });

      if (res.ok) {
        onRemoveAttachment(attachmentId);
        showToast("Anexo removido.", "info");
      } else {
        showToast("Falha ao excluir anexo.", "error");
      }
    } catch (err) {
      console.error("Erro ao excluir anexo:", err);
      showToast("Erro ao excluir anexo.", "error");
    }
  }

  function setImageWidth(src: string, percent: number) {
    const escapedSrc = src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`(!\\[[^\\]]*\\]\\(${escapedSrc})(?:\\s+"?\\d{1,3}%?"?)?\\)`, "g");
    const replacement = `$1 "${percent}")`;

    const nextBody = body.replace(regex, replacement);
    if (nextBody !== body) {
      setBody(nextBody);
      latestStateRef.current.body = nextBody;
      onUpdate({
        title: latestStateRef.current.title,
        body: nextBody,
        color: latestStateRef.current.color,
        is_pinned: latestStateRef.current.isPinned,
        is_archived: latestStateRef.current.isArchived,
      });
    }
  }

  function charIndexFromPointNative(el: HTMLTextAreaElement, clientX: number, clientY: number): number | null {
    const docAny = document as unknown as {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    if (typeof docAny.caretPositionFromPoint === "function") {
      const pos = docAny.caretPositionFromPoint(clientX, clientY);
      if (pos && (pos.offsetNode === el || pos.offsetNode.parentNode === el)) {
        return pos.offset;
      }
    }
    if (typeof docAny.caretRangeFromPoint === "function") {
      const range = docAny.caretRangeFromPoint(clientX, clientY);
      if (range && (range.startContainer === el || range.startContainer.parentNode === el)) {
        return range.startOffset;
      }
    }
    return null;
  }

  function charIndexFromPointMirror(el: HTMLTextAreaElement, clientX: number, clientY: number): number | null {
    try {
      const doc = el.ownerDocument;
      const win = doc.defaultView || window;
      const computed = win.getComputedStyle(el);
      const rect = el.getBoundingClientRect();

      const mirror = doc.createElement("div");
      const props = [
        "boxSizing", "width", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
        "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
        "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "lineHeight", "tabSize", "whiteSpace",
      ] as const;
      for (const p of props) {
        (mirror.style as unknown as Record<string, string>)[p] = computed[p];
      }
      mirror.style.position = "absolute";
      mirror.style.top = "-99999px";
      mirror.style.left = "-99999px";
      mirror.style.overflow = "hidden";
      mirror.style.wordWrap = "break-word";
      mirror.style.visibility = "hidden";
      doc.body.appendChild(mirror);

      const targetX = clientX - rect.left;
      const targetY = clientY - rect.top + el.scrollTop;
      const value = el.value;

      const markerTop = (i: number) => {
        const span = doc.createElement("span");
        mirror.replaceChildren(doc.createTextNode(value.slice(0, i)), span);
        return Math.round(span.getBoundingClientRect().top);
      };

      let lo = 0;
      let hi = value.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (markerTop(mid) <= Math.round(targetY)) lo = mid;
        else hi = mid - 1;
      }

      const lineTop = markerTop(lo);
      let lineStart = lo;
      while (lineStart > 0 && markerTop(lineStart - 1) === lineTop) lineStart--;
      let lineEnd = lo;
      while (lineEnd < value.length && markerTop(lineEnd + 1) === lineTop) lineEnd++;

      let best = lineStart;
      for (let i = lineStart; i <= lineEnd; i++) {
        const span = doc.createElement("span");
        mirror.replaceChildren(doc.createTextNode(value.slice(0, i)), span);
        if (span.getBoundingClientRect().left <= targetX) best = i;
        else break;
      }

      mirror.remove();
      return best;
    } catch {
      return null;
    }
  }

  function insertAroundSelection(prefix: string, suffix = "", placeholder = "") {
    const el = bodyTextareaRef.current;
    const start = el ? (el.selectionStart ?? body.length) : body.length;
    const end = el ? (el.selectionEnd ?? start) : body.length;
    const rawSelected = body.slice(start, end);

    let leading = "";
    let core = "";
    let trailing = "";

    if (start === end) {
      core = placeholder;
    } else {
      const match = rawSelected.match(/^(\s*)([\s\S]*?)(\s*)$/);
      if (match && match[2]) {
        leading = match[1];
        core = match[2];
        trailing = match[3];
      } else {
        core = rawSelected || placeholder;
      }
    }

    const next = body.slice(0, start) + leading + prefix + core + suffix + trailing + body.slice(end);
    setBody(next);
    requestAnimationFrame(() => {
      el?.focus();
      const selStart = start + leading.length + prefix.length;
      el?.setSelectionRange(selStart, selStart + core.length);
    });
  }

  function insertLinePrefix(prefix: string) {
    const el = bodyTextareaRef.current;
    const start = el ? (el.selectionStart ?? body.length) : body.length;
    const lineStart = body.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    setBody(body.slice(0, lineStart) + prefix + body.slice(lineStart));
    requestAnimationFrame(() => {
      el?.focus();
      const newPos = start + prefix.length;
      el?.setSelectionRange(newPos, newPos);
    });
  }

  function insertAtCursor(text: string) {
    const el = bodyTextareaRef.current;
    const start = el ? (el.selectionStart ?? body.length) : body.length;
    const end = el ? (el.selectionEnd ?? start) : body.length;
    const next = body.slice(0, start) + text + body.slice(end);
    setBody(next);
    requestAnimationFrame(() => {
      el?.focus();
      const newPos = start + text.length;
      el?.setSelectionRange(newPos, newPos);
    });
  }

  function repairImageTitles(bodyText: string): string {
    return bodyText.replace(
      /\((\/api\/attachments\/[^)\s]+|https?:\/\/[^)\s]+)"(\d{1,3})"\)/g,
      '$1 "$2")'
    );
  }

  async function handleDrop(e: React.DragEvent) {
    const files = Array.from(e.dataTransfer?.files || []).filter((f) =>
      f.type.startsWith("image/")
    );
    if (files.length === 0) return;
    e.preventDefault();

    const el = bodyTextareaRef.current;
    let dropIndex: number | null = null;
    if (el && e.target === el) {
      dropIndex =
        charIndexFromPointNative(el, e.clientX, e.clientY) ??
        charIndexFromPointMirror(el, e.clientX, e.clientY);
    }

    for (const file of files) {
      await uploadImageFile(file, dropIndex);
    }
  }

  if (!isOpen) return null;

  const imageAttachments =
    note.attachments?.filter(
      (a) =>
        a.mime_type.startsWith("image/") &&
        !body.includes(`/api/attachments/${a.id}`)
    ) || [];
  const audioAttachments = note.attachments?.filter((a) => a.mime_type.startsWith("audio/")) || [];
  const detectedUrls = extractUrls(body);

  // Contagem rápida de palavras e caracteres para visualização profissional
  const wordCount = body.trim() ? body.trim().split(/\s+/).length : 0;
  const charCount = body.length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 md:p-6 bg-slate-950/70 backdrop-blur-md cursor-pointer animate-in fade-in duration-150"
      onClick={handleManualClose}
      onPaste={handlePaste}
    >
      <div
        className={`w-full transition-all duration-200 ${
          isFullscreen
            ? "max-w-full h-[98vh] rounded-2xl"
            : "max-w-5xl h-[88vh] rounded-2xl md:rounded-3xl"
        } shadow-2xl border flex flex-col overflow-hidden cursor-default note-color-${color}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Barra Superior Estilo Caderno / Obsidian */}
        <header className="px-4 py-3 flex items-center justify-between border-b border-black/5 dark:border-white/5 bg-white/40 dark:bg-black/20 backdrop-blur-sm select-none">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 bg-black/5 dark:bg-white/5 p-1 rounded-xl text-xs font-medium">
              <button
                type="button"
                onClick={() => setViewMode("edit")}
                title="Modo Edição"
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition ${
                  viewMode === "edit"
                    ? "bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs font-semibold"
                    : "text-slate-500 hover:text-slate-900 dark:hover:text-slate-200"
                }`}
              >
                <PenLine className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Editor</span>
              </button>

              <button
                type="button"
                onClick={() => setViewMode("split")}
                title="Visualização Lado a Lado (Split)"
                className={`hidden md:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition ${
                  viewMode === "split"
                    ? "bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs font-semibold"
                    : "text-slate-500 hover:text-slate-900 dark:hover:text-slate-200"
                }`}
              >
                <Columns className="w-3.5 h-3.5" />
                <span>Dividido</span>
              </button>

              <button
                type="button"
                onClick={() => setViewMode("preview")}
                title="Modo Leitura / Preview"
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition ${
                  viewMode === "preview"
                    ? "bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs font-semibold"
                    : "text-slate-500 hover:text-slate-900 dark:hover:text-slate-200"
                }`}
              >
                <Eye className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Visualizar</span>
              </button>
            </div>

            <button
              type="button"
              onClick={toggleHistory}
              title="Histórico de versões"
              className={`p-2 rounded-xl transition flex items-center gap-1.5 text-xs font-medium ${
                showHistory
                  ? "bg-amber-500 text-slate-950 font-semibold shadow-xs"
                  : "text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/10"
              }`}
            >
              <History className="w-4 h-4" />
              <span className="hidden sm:inline">Histórico</span>
            </button>
          </div>

          <div className="flex items-center gap-1 sm:gap-2">
            <button
              type="button"
              onClick={() => setIsPinned(!isPinned)}
              title={isPinned ? "Desafixar nota" : "Fixar nota"}
              className={`p-2 rounded-xl transition ${
                isPinned
                  ? "text-amber-500 bg-amber-500/15"
                  : "text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/10"
              }`}
            >
              <Pin className={`w-4 h-4 ${isPinned ? "fill-amber-500" : ""}`} />
            </button>

            <button
              type="button"
              onClick={() => setIsFullscreen(!isFullscreen)}
              title={isFullscreen ? "Restaurar janela" : "Tela cheia"}
              className="hidden sm:flex p-2 text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/10 rounded-xl transition"
            >
              {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </button>

            <button
              type="button"
              onClick={handleManualClose}
              title="Fechar (Esc)"
              className="p-2 text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/10 rounded-xl transition"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* Histórico Retrátil */}
        {showHistory && (
          <div className="p-4 bg-black/5 dark:bg-black/30 border-b border-black/10 dark:border-white/10 max-h-56 overflow-y-auto space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-amber-500" />
                Versões Anteriores ({versions.length})
              </h4>
              <button
                type="button"
                onClick={() => setShowHistory(false)}
                className="text-xs text-slate-500 hover:text-slate-900 dark:hover:text-white"
              >
                Ocultar
              </button>
            </div>

            {loadingVersions ? (
              <div className="text-xs text-slate-500 py-3 text-center">Carregando histórico...</div>
            ) : versions.length === 0 ? (
              <div className="text-xs text-slate-400 py-2 italic">Nenhuma versão anterior registrada para esta nota.</div>
            ) : (
              <div className="space-y-2">
                {versions.map((v) => (
                  <div
                    key={v.id}
                    className="p-2.5 rounded-xl bg-white/70 dark:bg-slate-800/70 border border-black/5 dark:border-white/5 flex items-start justify-between gap-3 text-xs shadow-xs"
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

        {/* Toolbar de Formatação Markdown (visível apenas quando o editor está ativo) */}
        {viewMode !== "preview" && (
          <div className="px-4 py-2 border-b border-black/5 dark:border-white/5 bg-slate-50/50 dark:bg-slate-900/30 flex items-center gap-1 flex-wrap text-slate-600 dark:text-slate-300 select-none">
            <button type="button" onClick={() => insertAroundSelection("**", "**", "negrito")} title="Negrito" className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition"><Bold className="w-3.5 h-3.5" /></button>
            <button type="button" onClick={() => insertAroundSelection("*", "*", "itálico")} title="Itálico" className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition"><Italic className="w-3.5 h-3.5" /></button>
            <button type="button" onClick={() => insertAroundSelection("~~", "~~", "riscado")} title="Riscado" className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition"><Strikethrough className="w-3.5 h-3.5" /></button>
            <button type="button" onClick={() => insertAroundSelection("`", "`", "código")} title="Código inline" className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition"><Code2 className="w-3.5 h-3.5" /></button>
            <button type="button" onClick={() => insertAroundSelection("```\n", "\n```", "código aqui")} title="Bloco de código" className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition"><SquareCode className="w-3.5 h-3.5" /></button>

            <div className="w-px h-4 bg-black/10 dark:bg-white/10 mx-1" />

            <button type="button" onClick={() => insertLinePrefix("## ")} title="Título H2" className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition"><Heading2 className="w-3.5 h-3.5" /></button>
            <button type="button" onClick={() => insertLinePrefix("- ")} title="Lista com marcadores" className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition"><List className="w-3.5 h-3.5" /></button>
            <button type="button" onClick={() => insertLinePrefix("1. ")} title="Lista numerada" className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition"><ListOrdered className="w-3.5 h-3.5" /></button>
            <button type="button" onClick={() => insertLinePrefix("- [ ] ")} title="Tarefa (Checkbox)" className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition"><ListTodo className="w-3.5 h-3.5" /></button>
            <button type="button" onClick={() => insertLinePrefix("> ")} title="Citação" className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition"><Quote className="w-3.5 h-3.5" /></button>

            <div className="w-px h-4 bg-black/10 dark:bg-white/10 mx-1" />

            <button type="button" onClick={() => insertAroundSelection("[", "](https://)", "link")} title="Inserir link" className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition"><Link2 className="w-3.5 h-3.5" /></button>
            <button type="button" onClick={() => insertAtCursor("\n---\n")} title="Linha divisória" className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition"><Minus className="w-3.5 h-3.5" /></button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              title="Inserir imagem no texto"
              className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition text-amber-600 dark:text-amber-400"
            >
              <ImagePlus className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Área Central: Documento Caderno */}
        <div className="flex-1 flex flex-col min-h-0 overflow-y-auto">
          {/* Cabeçalho do Documento: Título limpo estilo Notion */}
          <div className="px-6 pt-5 pb-3">
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Sem título..."
              className="w-full text-2xl sm:text-3xl font-bold bg-transparent border-none outline-none text-slate-900 dark:text-white placeholder-slate-400 tracking-tight"
            />
          </div>

          {/* Área Principal de Escrita / Leitura */}
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
            className="flex-1 min-h-[300px] flex px-6 pb-6 gap-6 relative"
          >
            {/* Coluna do Editor */}
            {(viewMode === "split" || viewMode === "edit") && (
              <div className={`${viewMode === "split" ? "w-1/2" : "w-full"} flex flex-col h-full`}>
                <textarea
                  ref={bodyTextareaRef}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="Escreva algo..."
                  className="w-full h-full p-4 text-sm font-mono bg-white/40 dark:bg-black/20 rounded-2xl border border-black/5 dark:border-white/5 outline-none resize-none text-slate-800 dark:text-slate-100 placeholder-slate-400 leading-relaxed focus:ring-1 focus:ring-amber-400/50"
                />
              </div>
            )}

            {/* Divisória Vertical quando em modo Split */}
            {viewMode === "split" && (
              <div className="hidden md:block w-px bg-black/5 dark:border-white/5 self-stretch my-2" />
            )}

            {/* Coluna do Preview Markdown */}
            {(viewMode === "split" || viewMode === "preview") && (
              <div
                className={`${
                  viewMode === "split" ? "w-1/2" : "w-full max-w-3xl mx-auto"
                } h-full p-4 overflow-y-auto bg-white/40 dark:bg-black/20 rounded-2xl border border-black/5 dark:border-white/5`}
              >
                <MarkdownView content={body} onSetImageWidth={setImageWidth} />
              </div>
            )}
          </div>

          {/* Seção Extra: Anexos e Links ricos em acordião ou bloco limpo */}
          {(imageAttachments.length > 0 || audioAttachments.length > 0 || detectedUrls.length > 0) && (
            <div className="px-6 pb-6 space-y-4 border-t border-black/5 dark:border-white/5 pt-4 bg-black/5 dark:bg-black/10">
              {/* Previews de Links Ricos */}
              {detectedUrls.length > 0 && (
                <div className="space-y-2">
                  <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">
                    Links no texto
                  </span>
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                    {detectedUrls.map((url) => (
                      <LinkPreview key={url} url={url} />
                    ))}
                  </div>
                </div>
              )}

              {/* Gravações de Voz */}
              {audioAttachments.length > 0 && (
                <div className="space-y-2">
                  <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">
                    Áudios Gravados
                  </span>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {audioAttachments.map((audio) => (
                      <div
                        key={audio.id}
                        className="flex items-center gap-2 p-2 rounded-xl bg-white/60 dark:bg-slate-800/60 border border-black/5 dark:border-white/5"
                      >
                        <div className="flex-1 min-w-0">
                          <AudioPlayer
                            src={`/api/attachments/${audio.id}`}
                            durationSeconds={audio.duration_seconds}
                            fileName={audio.file_name}
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => handleDeleteAttachment(audio.id)}
                          className="p-1.5 text-slate-400 hover:text-red-500 transition rounded-lg"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Imagens anexadas avulsas (que não estão embutidas no markdown) */}
              {imageAttachments.length > 0 && (
                <div className="space-y-2">
                  <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">
                    Galeria de Anexos
                  </span>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                    {imageAttachments.map((img) => (
                      <div
                        key={img.id}
                        className="relative group rounded-xl overflow-hidden border border-black/10 aspect-video bg-black/5"
                      >
                        <img
                          src={`/api/attachments/${img.id}`}
                          alt={img.file_name}
                          className="w-full h-full object-cover"
                        />
                        <button
                          type="button"
                          onClick={() => handleDeleteAttachment(img.id)}
                          className="absolute top-1.5 right-1.5 p-1 bg-black/70 text-white rounded-lg opacity-0 group-hover:opacity-100 transition hover:bg-red-600"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Gravador de Áudio ativo */}
          {isRecording && (
            <div className="px-6 pb-4">
              <VoiceRecorder
                onRecorded={handleVoiceRecorded}
                onCancel={() => setIsRecording(false)}
              />
            </div>
          )}

          {uploading && (
            <div className="mx-6 mb-4 flex items-center gap-2 p-3 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded-xl text-amber-700 dark:text-amber-300 text-xs font-medium">
              <UploadCloud className="w-4 h-4 animate-bounce" />
              Processando e salvando na nuvem...
            </div>
          )}
        </div>

        {/* Rodapé de Status e Ações */}
        <footer className="px-4 py-3 flex items-center justify-between border-t border-black/5 dark:border-white/5 bg-white/40 dark:bg-black/20 backdrop-blur-sm select-none">
          <div className="flex items-center gap-1 sm:gap-2">
            <ColorPicker selectedColor={color} onSelectColor={setColor} />

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              title="Anexar imagem"
              className="p-2 text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/10 rounded-xl transition"
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
              className="p-2 text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/10 rounded-xl transition"
            >
              <Mic className="w-4 h-4" />
            </button>

            <button
              type="button"
              onClick={() => setIsArchived(!isArchived)}
              title={isArchived ? "Desarquivar nota" : "Arquivar nota"}
              className="p-2 text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/10 rounded-xl transition"
            >
              {isArchived ? <ArchiveRestore className="w-4 h-4" /> : <Archive className="w-4 h-4" />}
            </button>

            <button
              type="button"
              onClick={onDelete}
              title="Excluir nota"
              className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40 rounded-xl transition"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden sm:flex items-center gap-2 text-[11px] text-slate-400 font-mono">
              <span>{wordCount} palavras</span>
              <span>•</span>
              <span>{charCount} caracteres</span>
            </div>

            <button
              type="button"
              onClick={handleManualClose}
              className="px-4 py-1.5 bg-slate-900 hover:bg-slate-800 dark:bg-white dark:hover:bg-slate-100 text-white dark:text-slate-900 rounded-xl font-semibold text-xs transition shadow-xs"
            >
              Salvar e fechar
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
