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
  Link2,
  Minus,
  ImagePlus,
} from "lucide-react";
import AudioPlayer from "./AudioPlayer";
import ColorPicker from "./ColorPicker";
import VoiceRecorder from "./VoiceRecorder";
import LinkPreview, { extractUrls } from "./LinkPreview";
import MarkdownView from "./MarkdownView";

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
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [color, setColor] = useState(note.color);
  const [isPinned, setIsPinned] = useState(note.is_pinned);
  const [isArchived, setIsArchived] = useState(note.is_archived);
  const [isRecording, setIsRecording] = useState(false);
  const [uploading, setUploading] = useState(false);
  // Abas de edição/preview no mobile (no desktop a divisão fica lado a lado)
  const [mobileTab, setMobileTab] = useState<"edit" | "preview">("edit");

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

  useEffect(() => {
    setTitle(note.title);
    setBody(note.body);
    setColor(note.color);
    setIsPinned(note.is_pinned);
    setIsArchived(note.is_archived);
    setShowHistory(false);
    setMobileTab("edit");
    isClosingRef.current = false;
  }, [note]);

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

        // Atualiza referências locais para evitar disparar PATCH ao fechar
        note.title = data.restored.title;
        note.body = data.restored.body;
        latestStateRef.current = {
          ...latestStateRef.current,
          title: data.restored.title,
          body: data.restored.body,
        };

        // Atualiza o card no dashboard sem gerar requisição PATCH redundante
        await onUpdate({
          title: data.restored.title,
          body: data.restored.body,
          skipPatch: true,
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
    if (isClosingRef.current) return;
    isClosingRef.current = true;

    if (historyPushedRef.current) {
      historyPushedRef.current = false;
      window.history.back();
    }
    closeAndSave();
  }

  async function uploadImageFile(file: File, insertIndex?: number | null) {
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
        // Insere a referência da imagem no corpo (aparece renderizada no preview)
        if (data.attachment.mime_type?.startsWith("image/")) {
          insertAtCursor(
            `\n![${data.attachment.file_name}](/api/attachments/${data.attachment.id})\n`,
            insertIndex
          );
        }
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

  // ===== Ferramentas de edição Markdown =====

  /**
   * Índice de caractere a partir do ponto do mouse, usando as APIs nativas
   * de caret (funciona em vários navegadores para textarea).
   * Retorna null se não conseguir medir — o chamador faz fallback.
   */
  function charIndexFromPointNative(
    el: HTMLTextAreaElement,
    clientX: number,
    clientY: number
  ): number | null {
    try {
      const doc = el.ownerDocument as Document & {
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
        caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
      };
      if (doc.caretRangeFromPoint) {
        const range = doc.caretRangeFromPoint(clientX, clientY);
        if (range && range.startContainer === el) {
          return Math.min(range.startOffset, el.value.length);
        }
      }
      if (doc.caretPositionFromPoint) {
        const pos = doc.caretPositionFromPoint(clientX, clientY);
        if (pos && pos.offsetNode === el) {
          return Math.min(pos.offset, el.value.length);
        }
      }
    } catch {
      // ignora, tenta o espelho
    }
    return null;
  }

  /**
   * Fallback: mede a posição do caret com um "div espelho" que replica a
   * quebra de linha do textarea (busca binária por linha, depois por coluna).
   */
  function charIndexFromPointMirror(
    el: HTMLTextAreaElement,
    clientX: number,
    clientY: number
  ): number | null {
    try {
      const doc = el.ownerDocument;
      const win = doc.defaultView;
      if (!win) return null;
      const cs = win.getComputedStyle(el);
      const rect = el.getBoundingClientRect();

      const mirror = doc.createElement("div");
      mirror.style.position = "fixed";
      mirror.style.left = `${rect.left}px`;
      mirror.style.top = `${rect.top}px`;
      mirror.style.width = `${rect.width}px`;
      mirror.style.boxSizing = "border-box";
      mirror.style.fontFamily = cs.fontFamily;
      mirror.style.fontSize = cs.fontSize;
      mirror.style.fontWeight = cs.fontWeight;
      mirror.style.lineHeight = cs.lineHeight;
      mirror.style.letterSpacing = cs.letterSpacing;
      mirror.style.padding = cs.padding;
      mirror.style.whiteSpace = "pre-wrap";
      mirror.style.wordWrap = "break-word";
      mirror.style.visibility = "hidden";
      doc.body.appendChild(mirror);

      // Alvo: x/y relativos ao conteúdo (desconta scroll do textarea)
      const targetX = clientX - rect.left;
      const targetY = clientY - rect.top + el.scrollTop;
      const value = el.value;

      // topo do marcador inserido após os primeiros `i` caracteres
      const markerTop = (i: number) => {
        const span = doc.createElement("span");
        mirror.replaceChildren(doc.createTextNode(value.slice(0, i)), span);
        return Math.round(span.getBoundingClientRect().top);
      };

      // Busca binária: maior índice cuja linha começa acima do alvo
      let lo = 0;
      let hi = value.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (markerTop(mid) <= Math.round(targetY)) lo = mid;
        else hi = mid - 1;
      }

      // Linha do índice encontrado: limita pelos extremos com o mesmo topo
      const lineTop = markerTop(lo);
      let lineStart = lo;
      while (lineStart > 0 && markerTop(lineStart - 1) === lineTop) lineStart--;
      let lineEnd = lo;
      while (lineEnd < value.length && markerTop(lineEnd + 1) === lineTop) lineEnd++;

      // Dentro da linha, escolhe pela coluna X
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

  /** Envolve a seleção (ou insere placeholder) com sintaxe markdown e mantém o texto selecionado. */
  function insertAroundSelection(prefix: string, suffix = "", placeholder = "") {
    const el = bodyTextareaRef.current;
    const start = el ? (el.selectionStart ?? body.length) : body.length;
    const end = el ? (el.selectionEnd ?? start) : body.length;
    const selected = body.slice(start, end) || placeholder;
    const next = body.slice(0, start) + prefix + selected + suffix + body.slice(end);
    setBody(next);
    requestAnimationFrame(() => {
      el?.focus();
      const selStart = start + prefix.length;
      el?.setSelectionRange(selStart, selStart + selected.length);
    });
  }

  /** Insere um prefixo no início da linha atual (listas, citações, títulos). */
  function insertLinePrefix(prefix: string) {
    const el = bodyTextareaRef.current;
    const start = el ? (el.selectionStart ?? body.length) : body.length;
    const lineStart = body.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    setBody(body.slice(0, lineStart) + prefix + body.slice(lineStart));
    requestAnimationFrame(() => {
      el?.focus();
      const pos = start + prefix.length;
      el?.setSelectionRange(pos, pos);
    });
  }

  /**
   * Insere texto na posição do cursor (editor focado), no índice indicado
   * (ex: ponto do drop de imagem) ou no fim do corpo como último recurso.
   */
  function insertAtCursor(text: string, atIndex?: number | null) {
    const el = bodyTextareaRef.current;
    let start: number;
    let end: number;
    let focused = false;

    if (typeof atIndex === "number") {
      start = Math.max(0, Math.min(atIndex, body.length));
      end = start;
    } else {
      focused = Boolean(el && document.activeElement === el);
      start = focused ? (el!.selectionStart ?? body.length) : body.length;
      end = focused ? (el!.selectionEnd ?? start) : body.length;
    }

    // Sem foco explícito (anexo no fim), separa com quebra de linha
    const separator = typeof atIndex !== "number" && !focused && body.trim().length > 0 ? "\n" : "";
    const fullText = separator + text;
    setBody(body.slice(0, start) + fullText + body.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      const pos = start + fullText.length;
      el?.setSelectionRange(pos, pos);
    });
  }

  /** Permite soltar imagens direto no editor (arrastar e soltar) — Office style: entra onde soltou. */
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
        // Imagens já inseridas no corpo (![...](/api/attachments/id)) ficam
        // apenas no editor/preview — não repetem na grade de anexos
        !body.includes(`/api/attachments/${a.id}`)
    ) || [];
  const audioAttachments = note.attachments?.filter((a) => a.mime_type.startsWith("audio/")) || [];
  const detectedUrls = extractUrls(body);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs cursor-pointer"
      onClick={handleManualClose}
      onPaste={handlePaste}
    >
      <div
        className={`w-full max-w-2xl md:max-w-4xl max-h-[90vh] rounded-2xl shadow-2xl border flex flex-col overflow-hidden cursor-default note-color-${color}`}
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

          {/* Editor/Preview dividido (estilo Joplin) */}
          <div className="md:hidden flex gap-1 w-max p-1 rounded-xl bg-slate-100 dark:bg-slate-800/80 text-xs font-medium">
            <button
              type="button"
              onClick={() => setMobileTab("edit")}
              aria-pressed={mobileTab === "edit"}
              className={`px-3 py-1.5 rounded-lg transition ${
                mobileTab === "edit"
                  ? "bg-white dark:bg-slate-900 shadow-sm text-slate-900 dark:text-white"
                  : "text-slate-500 dark:text-slate-400"
              }`}
            >
              Editar
            </button>
            <button
              type="button"
              onClick={() => setMobileTab("preview")}
              aria-pressed={mobileTab === "preview"}
              className={`px-3 py-1.5 rounded-lg transition ${
                mobileTab === "preview"
                  ? "bg-white dark:bg-slate-900 shadow-sm text-slate-900 dark:text-white"
                  : "text-slate-500 dark:text-slate-400"
              }`}
            >
              Preview
            </button>
          </div>

          {/* Barra de ferramentas Markdown */}
          <div
            className={`${
              mobileTab === "edit" ? "flex" : "hidden"
            } md:flex items-center gap-0.5 flex-wrap p-1 rounded-xl bg-slate-100 dark:bg-slate-800/80 text-slate-600 dark:text-slate-300`}
          >
            <button type="button" onClick={() => insertAroundSelection("**", "**", "negrito")} title="Negrito" className="p-2 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 transition"><Bold className="w-4 h-4" /></button>
            <button type="button" onClick={() => insertAroundSelection("*", "*", "itálico")} title="Itálico" className="p-2 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 transition"><Italic className="w-4 h-4" /></button>
            <button type="button" onClick={() => insertAroundSelection("~~", "~~", "riscado")} title="Riscado" className="p-2 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 transition"><Strikethrough className="w-4 h-4" /></button>
            <button type="button" onClick={() => insertAroundSelection("`", "`", "código")} title="Código" className="p-2 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 transition"><Code2 className="w-4 h-4" /></button>

            <div className="w-px h-5 bg-slate-300 dark:bg-slate-600 mx-1" />

            <button type="button" onClick={() => insertLinePrefix("## ")} title="Título de seção" className="p-2 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 transition"><Heading2 className="w-4 h-4" /></button>
            <button type="button" onClick={() => insertLinePrefix("- ")} title="Lista com marcadores" className="p-2 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 transition"><List className="w-4 h-4" /></button>
            <button type="button" onClick={() => insertLinePrefix("1. ")} title="Lista numerada" className="p-2 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 transition"><ListOrdered className="w-4 h-4" /></button>
            <button type="button" onClick={() => insertLinePrefix("- [ ] ")} title="Item de tarefa" className="p-2 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 transition"><ListTodo className="w-4 h-4" /></button>
            <button type="button" onClick={() => insertLinePrefix("> ")} title="Citação" className="p-2 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 transition"><Quote className="w-4 h-4" /></button>

            <div className="w-px h-5 bg-slate-300 dark:bg-slate-600 mx-1" />

            <button type="button" onClick={() => insertAroundSelection("[", "](https://)", "texto do link")} title="Inserir link" className="p-2 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 transition"><Link2 className="w-4 h-4" /></button>
            <button type="button" onClick={() => insertAtCursor("\n---\n")} title="Linha divisória" className="p-2 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 transition"><Minus className="w-4 h-4" /></button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              title="Enviar imagem (clique ou arraste para o editor)"
              className="p-2 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 transition"
            >
              <ImagePlus className="w-4 h-4" />
            </button>
          </div>

          {/* Editor/Preview dividido (estilo Joplin) — arraste imagens direto no editor */}
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
            className="md:h-[52vh] md:grid md:grid-cols-2 md:divide-x md:divide-slate-200 dark:md:divide-slate-600 border border-black/5 dark:border-white/10 rounded-xl md:rounded-2xl overflow-hidden bg-white/40 dark:bg-black/10"
          >
            <textarea
              ref={bodyTextareaRef}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Criar uma nota... (Markdown suportado: **negrito**, listas, tabelas...)"
              rows={10}
              className={`${
                mobileTab === "edit" ? "block" : "hidden"
              } md:block md:h-full min-h-[280px] w-full p-4 text-base md:text-sm md:font-mono bg-transparent border-none outline-none resize-none text-slate-700 dark:text-slate-200 placeholder-slate-400 leading-relaxed font-normal`}
            />
            <div
              className={`${
                mobileTab === "preview" ? "block" : "hidden"
              } md:block md:h-full min-h-[280px] p-4 overflow-y-auto`}
            >
              <MarkdownView content={body} />
            </div>
          </div>

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
