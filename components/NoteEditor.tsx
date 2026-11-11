"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Note, Attachment, NoteVersion } from "@/types/note";
import {
  Pin,
  Archive,
  ArchiveRestore,
  Trash2,
  Image as ImageIcon,
  Mic,
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
  Columns,
  Eye,
  PenLine,
  Check,
  Menu,
  Undo2,
  Redo2,
} from "lucide-react";
import AudioPlayer from "./AudioPlayer";
import ColorPicker from "./ColorPicker";
import VoiceRecorder from "./VoiceRecorder";
import LinkPreview, { extractUrls } from "./LinkPreview";
import MarkdownView from "./MarkdownView";
import VersionHistoryModal from "./VersionHistoryModal";
import { useUI } from "./UIProvider";

interface NoteEditorProps {
  note: Note;
  onUpdate: (updatedNote: Partial<Note> & { skipPatch?: boolean }) => Promise<void>;
  onDelete: () => Promise<void>;
  onToggleArchive: () => Promise<void>;
  onTogglePin: () => Promise<void>;
  onAddAttachment: (attachment: Attachment) => void;
  onRemoveAttachment: (attachmentId: string) => void;
  onMenuClick?: () => void;
}

export default function NoteEditor({
  note,
  onUpdate,
  onDelete,
  onToggleArchive,
  onTogglePin,
  onAddAttachment,
  onRemoveAttachment,
  onMenuClick,
}: NoteEditorProps) {
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [color, setColor] = useState(note.color);
  const [isPinned, setIsPinned] = useState(note.is_pinned);
  const [isArchived, setIsArchived] = useState(note.is_archived);
  const [isRecording, setIsRecording] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "unsaved">("saved");
  const { confirm, showToast } = useUI();

  // Pilha de Desfazer (Ctrl+Z) e Refazer (Ctrl+Y / Ctrl+Shift+Z)
  interface HistorySnapshot {
    body: string;
    cursorStart?: number;
    cursorEnd?: number;
  }
  const undoStackRef = useRef<HistorySnapshot[]>([]);
  const redoStackRef = useRef<HistorySnapshot[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const typingTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Modo de visualização estilo Joplin/Obsidian: "split" (lado a lado), "edit" (foco na escrita) ou "preview" (leitura limpa)
  const [viewMode, setViewMode] = useState<"split" | "edit" | "preview">("split");

  // Controle do Modal de Histórico de Versões
  const [showHistory, setShowHistory] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const bodyTextareaRef = useRef<HTMLTextAreaElement>(null);

  // Referência dos dados mais recentes para salvar com precisão
  const latestStateRef = useRef({ title, body, color, isPinned, isArchived, noteId: note.id });
  useEffect(() => {
    latestStateRef.current = { title, body, color, isPinned, isArchived, noteId: note.id };
  }, [title, body, color, isPinned, isArchived, note.id]);

  const saveTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Salva alterações pendentes
  const flushSave = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const current = latestStateRef.current;
    if (
      current.title !== note.title ||
      current.body !== note.body ||
      current.color !== note.color ||
      current.isPinned !== note.is_pinned ||
      current.isArchived !== note.is_archived
    ) {
      setSaveStatus("saving");
      await onUpdate({
        title: current.title,
        body: current.body,
        color: current.color,
        is_pinned: current.isPinned,
        is_archived: current.isArchived,
      });
      setSaveStatus("saved");
    }
  }, [note, onUpdate]);

  // Ao mudar de nota: salva a nota anterior (se tiver alterações) e carrega os novos dados
  const prevNoteIdRef = useRef(note.id);
  useEffect(() => {
    if (prevNoteIdRef.current !== note.id) {
      // Salva nota anterior antes de trocar
      const current = latestStateRef.current;
      if (
        current.title !== note.title ||
        current.body !== note.body ||
        current.color !== note.color
      ) {
        onUpdate({
          title: current.title,
          body: current.body,
          color: current.color,
          is_pinned: current.isPinned,
          is_archived: current.isArchived,
        });
      }
      prevNoteIdRef.current = note.id;

      // Reseta pilhas de desfazer/refazer para a nova nota
      undoStackRef.current = [];
      redoStackRef.current = [];
      setCanUndo(false);
      setCanRedo(false);

      // Reseta estado com a nova nota
      setTitle(note.title);
      setBody(repairImageTitles(note.body));
      setColor(note.color);
      setIsPinned(note.is_pinned);
      setIsArchived(note.is_archived);
      setShowHistory(false);
      setSaveStatus("saved");

      // No mobile, padrão é edit
      if (typeof window !== "undefined" && window.innerWidth < 768) {
        setViewMode("edit");
      }
    } else {
      // Atualizações de props vindas do pai
      setColor(note.color);
      setIsPinned(note.is_pinned);
      setIsArchived(note.is_archived);
    }
  }, [note, onUpdate]);

  // Debounced auto-save quando title ou body mudam
  const queueAutoSave = useCallback(() => {
    setSaveStatus("unsaved");
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      setSaveStatus("saving");
      const current = latestStateRef.current;
      await onUpdate({
        title: current.title,
        body: current.body,
        color: current.color,
        is_pinned: current.isPinned,
        is_archived: current.isArchived,
      });
      setSaveStatus("saved");
    }, 1200);
  }, [onUpdate]);

  function pushHistory(prevBody: string, cursorStart?: number, cursorEnd?: number) {
    undoStackRef.current.push({
      body: prevBody,
      cursorStart,
      cursorEnd,
    });
    if (undoStackRef.current.length > 50) {
      undoStackRef.current.shift();
    }
    redoStackRef.current = [];
    setCanUndo(true);
    setCanRedo(false);
  }

  const handleUndo = useCallback(() => {
    if (undoStackRef.current.length === 0) return;

    const previous = undoStackRef.current.pop()!;
    redoStackRef.current.push({
      body,
      cursorStart: bodyTextareaRef.current?.selectionStart,
      cursorEnd: bodyTextareaRef.current?.selectionEnd,
    });

    setBody(previous.body);
    latestStateRef.current.body = previous.body;
    setCanUndo(undoStackRef.current.length > 0);
    setCanRedo(true);
    queueAutoSave();

    requestAnimationFrame(() => {
      if (bodyTextareaRef.current && typeof previous.cursorStart === "number") {
        bodyTextareaRef.current.focus();
        bodyTextareaRef.current.setSelectionRange(
          previous.cursorStart,
          previous.cursorEnd ?? previous.cursorStart
        );
      }
    });
  }, [body, queueAutoSave]);

  const handleRedo = useCallback(() => {
    if (redoStackRef.current.length === 0) return;

    const next = redoStackRef.current.pop()!;
    undoStackRef.current.push({
      body,
      cursorStart: bodyTextareaRef.current?.selectionStart,
      cursorEnd: bodyTextareaRef.current?.selectionEnd,
    });

    setBody(next.body);
    latestStateRef.current.body = next.body;
    setCanUndo(true);
    setCanRedo(redoStackRef.current.length > 0);
    queueAutoSave();

    requestAnimationFrame(() => {
      if (bodyTextareaRef.current && typeof next.cursorStart === "number") {
        bodyTextareaRef.current.focus();
        bodyTextareaRef.current.setSelectionRange(
          next.cursorStart,
          next.cursorEnd ?? next.cursorStart
        );
      }
    });
  }, [body, queueAutoSave]);

  function handleTextareaKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
      e.preventDefault();
      handleUndo();
      return;
    }
    if (
      ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") ||
      ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "z")
    ) {
      e.preventDefault();
      handleRedo();
      return;
    }
  }

  function handleTitleChange(e: React.ChangeEvent<HTMLInputElement>) {
    setTitle(e.target.value);
    queueAutoSave();
  }

  function handleBodyChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const nextBody = e.target.value;
    const prevBody = body;

    // Se houve pausa de digitação ou início de digitação, grava snapshot para Ctrl+Z
    if (!typingTimerRef.current) {
      pushHistory(prevBody, e.target.selectionStart, e.target.selectionEnd);
    } else {
      clearTimeout(typingTimerRef.current);
    }

    typingTimerRef.current = setTimeout(() => {
      typingTimerRef.current = null;
    }, 600);

    setBody(nextBody);
    queueAutoSave();
  }

  async function handleRestoreVersion(version: NoteVersion) {
    try {
      const res = await fetch(`/api/notes/${note.id}/versions/${version.id}/restore`, {
        method: "POST",
      });
      const data = await res.json();
      if (res.ok) {
        const nextTitle = data.note?.title ?? data.restored?.title ?? version.title ?? "";
        const nextBody = data.note?.body ?? data.restored?.body ?? version.body ?? "";

        // Cancela qualquer timer de auto-save pendente para não sobrescrever com o texto antigo
        if (saveTimerRef.current) {
          clearTimeout(saveTimerRef.current);
          saveTimerRef.current = null;
        }

        // Atualiza estado local imediatamente
        setTitle(nextTitle);
        setBody(nextBody);
        setSaveStatus("saved");

        // Atualiza ref
        latestStateRef.current = {
          ...latestStateRef.current,
          title: nextTitle,
          body: nextBody,
        };

        // Notifica o pai para atualizar a lista na sidebar
        await onUpdate({
          title: nextTitle,
          body: nextBody,
          skipPatch: true,
        });
      } else {
        showToast("Erro ao restaurar versão: " + (data.error || "Erro desconhecido"), "error");
      }
    } catch (err) {
      console.error("Erro ao restaurar versão:", err);
      throw err;
    }
  }

  async function uploadImageFile(file: File, atIndex?: number | null) {
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
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

        await onUpdate({
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
      message: "Tem certeza que deseja remover este anexo da nota?",
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
      } else {
        showToast("Falha ao excluir anexo.", "error");
      }
    } catch (err) {
      console.error("Erro ao excluir anexo:", err);
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
    const selected = body.slice(start, end) || placeholder;
    pushHistory(body, start, end);
    const next = body.slice(0, start) + prefix + selected + suffix + body.slice(end);
    setBody(next);
    queueAutoSave();
    requestAnimationFrame(() => {
      el?.focus();
      const selStart = start + prefix.length;
      el?.setSelectionRange(selStart, selStart + selected.length);
    });
  }

  function insertLinePrefix(prefix: string) {
    const el = bodyTextareaRef.current;
    const start = el ? (el.selectionStart ?? body.length) : body.length;
    pushHistory(body, start, start);
    const lineStart = body.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    const next = body.slice(0, lineStart) + prefix + body.slice(lineStart);
    setBody(next);
    queueAutoSave();
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
    pushHistory(body, start, end);
    const next = body.slice(0, start) + text + body.slice(end);
    setBody(next);
    queueAutoSave();
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

  const imageAttachments =
    note.attachments?.filter(
      (a) =>
        a.mime_type.startsWith("image/") &&
        !body.includes(`/api/attachments/${a.id}`)
    ) || [];
  const audioAttachments = note.attachments?.filter((a) => a.mime_type.startsWith("audio/")) || [];
  const detectedUrls = extractUrls(body);

  const wordCount = body.trim() ? body.trim().split(/\s+/).length : 0;
  const charCount = body.length;

  return (
    <div
      className={`flex-1 h-full flex flex-col overflow-hidden note-color-${color}`}
      onPaste={handlePaste}
    >
      {/* Barra Superior Inline Estilo Obsidian */}
      <header className="px-4 py-2.5 flex items-center justify-between border-b border-black/5 dark:border-white/5 bg-white/40 dark:bg-black/20 backdrop-blur-sm select-none shrink-0">
        <div className="flex items-center gap-2">
          {onMenuClick && (
            <button
              type="button"
              onClick={onMenuClick}
              title="Abrir menu"
              className="p-1.5 rounded-lg text-slate-500 hover:text-slate-800 dark:hover:text-white md:hidden"
            >
              <Menu className="w-5 h-5" />
            </button>
          )}

          {/* Toggle de Modo: Editor / Dividido / Visualizar */}
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

          {/* Botão de Histórico */}
          <button
            type="button"
            onClick={() => setShowHistory(true)}
            title="Histórico de versões"
            className="p-2 rounded-xl transition flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/10"
          >
            <History className="w-4 h-4" />
            <span className="hidden sm:inline">Histórico</span>
          </button>
        </div>

        {/* Lado direito: status de salvamento + ações */}
        <div className="flex items-center gap-2">
          {/* Indicador de Salvamento */}
          <span className="text-[11px] font-mono text-slate-400 hidden sm:inline-flex items-center gap-1">
            {saveStatus === "saving" && <span className="text-amber-500">Salvando...</span>}
            {saveStatus === "saved" && (
              <span className="text-emerald-500 flex items-center gap-0.5">
                <Check className="w-3 h-3" /> Salvo
              </span>
            )}
            {saveStatus === "unsaved" && <span className="text-slate-400">Alterado</span>}
          </span>

          <button
            type="button"
            onClick={onTogglePin}
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
            onClick={onToggleArchive}
            title={isArchived ? "Desarquivar nota" : "Arquivar nota"}
            className="p-2 text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/10 rounded-xl transition"
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
      </header>

      {/* Toolbar de Formatação Markdown */}
      {viewMode !== "preview" && (
        <div className="px-4 py-1.5 border-b border-black/5 dark:border-white/5 bg-slate-50/50 dark:bg-slate-900/30 flex items-center gap-1 flex-wrap text-slate-600 dark:text-slate-300 select-none shrink-0">
          <button
            type="button"
            disabled={!canUndo}
            onClick={handleUndo}
            title="Desfazer (Ctrl+Z)"
            className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition disabled:opacity-25 disabled:pointer-events-none"
          >
            <Undo2 className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            disabled={!canRedo}
            onClick={handleRedo}
            title="Refazer (Ctrl+Y / Ctrl+Shift+Z)"
            className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition disabled:opacity-25 disabled:pointer-events-none"
          >
            <Redo2 className="w-3.5 h-3.5" />
          </button>

          <div className="w-px h-4 bg-black/10 dark:bg-white/10 mx-1" />

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
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {/* Cabeçalho do Documento: Título limpo estilo Notion */}
        <div className="px-6 pt-5 pb-2 shrink-0">
          <input
            type="text"
            value={title}
            onChange={handleTitleChange}
            onBlur={flushSave}
            placeholder="Sem título..."
            className="w-full text-2xl sm:text-3xl font-bold bg-transparent border-none outline-none text-slate-900 dark:text-white placeholder-slate-400 tracking-tight"
          />
        </div>

        {/* Marcadores / Tags da nota */}
        {note.tags && note.tags.length > 0 && (
          <div className="px-6 pb-2 flex flex-wrap gap-1.5 shrink-0">
            {note.tags.map((tag) => (
              <span
                key={tag.id}
                className={`text-[11px] leading-none font-medium px-2 py-1 rounded-full ${
                  tag.kind === "auto"
                    ? "bg-amber-400/15 text-amber-700 dark:text-amber-300"
                    : "bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200"
                }`}
              >
                {tag.name}
              </span>
            ))}
          </div>
        )}

        {/* Área Principal de Escrita / Leitura */}
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
          className="flex-1 min-h-0 flex px-6 pb-4 gap-6 relative overflow-hidden"
        >
          {/* Coluna do Editor */}
          {(viewMode === "split" || viewMode === "edit") && (
            <div className={`${viewMode === "split" ? "w-1/2" : "w-full"} flex flex-col h-full`}>
              <textarea
                ref={bodyTextareaRef}
                value={body}
                onChange={handleBodyChange}
                onKeyDown={handleTextareaKeyDown}
                onBlur={flushSave}
                placeholder="Escreva algo... (Cole imagens com Ctrl+V ou arraste do sistema, use markdown livremente)"
                className="w-full h-full p-4 text-sm font-mono bg-white/40 dark:bg-black/20 rounded-2xl border border-black/5 dark:border-white/5 outline-none resize-none text-slate-800 dark:text-slate-100 placeholder-slate-400 leading-relaxed focus:ring-1 focus:ring-amber-400/50 overflow-y-auto"
              />
            </div>
          )}

          {/* Divisória Vertical quando em modo Split */}
          {viewMode === "split" && (
            <div className="hidden md:block w-px bg-black/5 dark:border-white/5 self-stretch my-2 shrink-0" />
          )}

          {/* Coluna do Preview Markdown com previews de links integrados */}
          {(viewMode === "split" || viewMode === "preview") && (
            <div
              className={`${
                viewMode === "split" ? "w-1/2" : "w-full max-w-3xl mx-auto"
              } h-full p-4 overflow-y-auto bg-white/40 dark:bg-black/20 rounded-2xl border border-black/5 dark:border-white/5 space-y-6 flex flex-col`}
            >
              {/* Conteúdo Renderizado em Markdown */}
              <div className="flex-1">
                <MarkdownView content={body} onSetImageWidth={setImageWidth} />
              </div>

              {/* Previews de Links Ricos integrados diretamente dentro da coluna de preview */}
              {detectedUrls.length > 0 && (
                <div className="pt-4 border-t border-black/5 dark:border-white/5 space-y-3">
                  <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider block">
                    Prévia de links
                  </span>
                  <div className="space-y-3">
                    {detectedUrls.map((url) => (
                      <LinkPreview key={url} url={url} />
                    ))}
                  </div>
                </div>
              )}

              {/* Gravações de Voz integradas no preview */}
              {audioAttachments.length > 0 && (
                <div className="pt-4 border-t border-black/5 dark:border-white/5 space-y-2">
                  <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider block">
                    Áudios Gravados
                  </span>
                  <div className="space-y-2">
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
                <div className="pt-4 border-t border-black/5 dark:border-white/5 space-y-2">
                  <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider block">
                    Galeria de Anexos
                  </span>
                  <div className="grid grid-cols-2 gap-3">
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
        </div>

        {/* Gravador de Áudio ativo */}
        {isRecording && (
          <div className="px-6 pb-4 shrink-0">
            <VoiceRecorder
              onRecorded={handleVoiceRecorded}
              onCancel={() => setIsRecording(false)}
            />
          </div>
        )}

        {uploading && (
          <div className="mx-6 mb-4 flex items-center gap-2 p-3 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded-xl text-amber-700 dark:text-amber-300 text-xs font-medium shrink-0">
            <UploadCloud className="w-4 h-4 animate-bounce" />
            Processando e salvando na nuvem...
          </div>
        )}
      </div>

      {/* Rodapé de Status e Ações */}
      <footer className="px-4 py-2.5 flex items-center justify-between border-t border-black/5 dark:border-white/5 bg-white/40 dark:bg-black/20 backdrop-blur-sm select-none shrink-0">
        <div className="flex items-center gap-1 sm:gap-2">
          <ColorPicker
            selectedColor={color}
            onSelectColor={(newColor) => {
              setColor(newColor);
              onUpdate({ color: newColor });
            }}
          />

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
        </div>

        <div className="flex items-center gap-3">
          <div className="hidden sm:flex items-center gap-2 text-[11px] text-slate-400 font-mono">
            <span>{wordCount} palavras</span>
            <span>•</span>
            <span>{charCount} caracteres</span>
          </div>
        </div>
      </footer>

      {/* Modal Completo de Inspeção e Restauração de Histórico */}
      <VersionHistoryModal
        isOpen={showHistory}
        onClose={() => setShowHistory(false)}
        note={note}
        onRestore={handleRestoreVersion}
      />
    </div>
  );
}