"use client";

import { useState, useRef, useEffect } from "react";
import { Pin, Image as ImageIcon, Mic, Check, X } from "lucide-react";
import ColorPicker from "./ColorPicker";
import VoiceRecorder from "./VoiceRecorder";
import LinkPreview, { extractUrls } from "./LinkPreview";
import { Note } from "@/types/note";
import { useUI } from "./UIProvider";

interface QuickNoteCreatorProps {
  onNoteCreated: (note: Note) => void;
}

export default function QuickNoteCreator({ onNoteCreated }: QuickNoteCreatorProps) {
  const { showToast } = useUI();
  const [isExpanded, setIsExpanded] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [color, setColor] = useState("default");
  const [isPinned, setIsPinned] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [pendingAudio, setPendingAudio] = useState<{ blob: Blob; duration: number } | null>(null);
  const [pendingImages, setPendingImages] = useState<File[]>([]);
  const [imagePreviews, setImagePreviews] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        if (isExpanded) {
          handleSaveAndClose();
        }
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isExpanded, title, body, color, isPinned, pendingAudio, pendingImages]);

  function handleImageSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    setPendingImages((prev) => [...prev, ...files]);

    const newPreviews = files.map((file) => URL.createObjectURL(file));
    setImagePreviews((prev) => [...prev, ...newPreviews]);
    setIsExpanded(true);
  }

  // Suporte a colar imagem (Ctrl+V) direto do Flameshot ou clipboard
  function handlePaste(e: React.ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;

    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          const namedFile = new File([file], `screenshot_${Date.now()}.png`, {
            type: file.type || "image/png",
          });
          files.push(namedFile);
        }
      }
    }

    if (files.length > 0) {
      e.preventDefault();
      setPendingImages((prev) => [...prev, ...files]);
      const newPreviews = files.map((f) => URL.createObjectURL(f));
      setImagePreviews((prev) => [...prev, ...newPreviews]);
      setIsExpanded(true);
    }
  }

  function handleRemovePendingImage(index: number) {
    setPendingImages((prev) => prev.filter((_, i) => i !== index));
    setImagePreviews((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSaveAndClose() {
    if (
      !title.trim() &&
      !body.trim() &&
      pendingImages.length === 0 &&
      !pendingAudio
    ) {
      resetForm();
      return;
    }

    setIsSubmitting(true);
    try {
      // 1. Cria a nota no Turso
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          body,
          color,
          is_pinned: isPinned,
          is_archived: false,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      const createdNote: Note = data.note;
      createdNote.attachments = [];

      // 2. Se houver imagens pendentes, faz o upload para o R2
      for (const img of pendingImages) {
        const formData = new FormData();
        formData.append("file", img);
        formData.append("noteId", createdNote.id);

        try {
          const uploadRes = await fetch("/api/attachments/upload", {
            method: "POST",
            body: formData,
          });
          const uploadData = await uploadRes.json();
          if (uploadRes.ok) {
            createdNote.attachments.push(uploadData.attachment);
          }
        } catch (uploadErr) {
          console.warn("Erro no upload da imagem:", uploadErr);
        }
      }

      // 3. Se houver áudio gravado, faz o upload para o R2
      if (pendingAudio) {
        const audioFile = new File(
          [pendingAudio.blob],
          `audio_${Date.now()}.webm`,
          { type: pendingAudio.blob.type }
        );
        const formData = new FormData();
        formData.append("file", audioFile);
        formData.append("noteId", createdNote.id);
        formData.append("duration", pendingAudio.duration.toString());

        try {
          const uploadRes = await fetch("/api/attachments/upload", {
            method: "POST",
            body: formData,
          });
          const uploadData = await uploadRes.json();
          if (uploadRes.ok) {
            createdNote.attachments.push(uploadData.attachment);
          }
        } catch (audioErr) {
          console.warn("Erro no upload do áudio:", audioErr);
        }
      }

      onNoteCreated(createdNote);
      resetForm();
    } catch (err) {
      console.error(err);
      showToast("Erro ao criar nota.", "error");
    } finally {
      setIsSubmitting(false);
    }
  }

  function resetForm() {
    setTitle("");
    setBody("");
    setColor("default");
    setIsPinned(false);
    setPendingImages([]);
    setImagePreviews([]);
    setPendingAudio(null);
    setIsRecording(false);
    setIsExpanded(false);
  }

  const detectedUrls = extractUrls(body);

  return (
    <div
      className="w-full max-w-xl mx-auto mb-8 px-4"
      ref={containerRef}
      onPaste={handlePaste}
    >
      <div
        className={`rounded-2xl border transition-all duration-200 shadow-md ${
          isExpanded ? "shadow-xl" : "hover:shadow-lg"
        } note-color-${color}`}
      >
        {/* Previews de imagem antes de salvar com botão para remover */}
        {imagePreviews.length > 0 && (
          <div className="p-3 grid grid-cols-2 gap-2 border-b border-black/5 dark:border-white/5">
            {imagePreviews.map((src, i) => (
              <div key={i} className="relative group rounded-xl overflow-hidden">
                <img
                  src={src}
                  alt="Prévia"
                  className="w-full h-32 object-cover rounded-xl"
                />
                <button
                  type="button"
                  onClick={() => handleRemovePendingImage(i)}
                  className="absolute top-1.5 right-1.5 p-1 bg-black/70 hover:bg-red-600 text-white rounded-full transition"
                  title="Remover imagem"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        {isExpanded ? (
          <div>
            {/* Header com Título e Pin */}
            <div className="p-4 pb-2 flex items-center justify-between">
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Título"
                className="w-full font-semibold text-base bg-transparent border-none outline-none text-slate-900 dark:text-white placeholder-slate-400"
              />
              <button
                type="button"
                onClick={() => setIsPinned(!isPinned)}
                className={`p-1.5 rounded-full transition ${
                  isPinned
                    ? "text-amber-500 bg-amber-500/10"
                    : "text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/10"
                }`}
              >
                <Pin className={`w-4 h-4 ${isPinned ? "fill-amber-500" : ""}`} />
              </button>
            </div>

            {/* Corpo */}
            <div className="px-4 py-2">
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Criar uma nota..."
                rows={3}
                autoFocus
                className="w-full text-sm bg-transparent border-none outline-none resize-none text-slate-700 dark:text-slate-200 placeholder-slate-400 leading-relaxed font-normal"
              />
            </div>

            {/* Prévia de Links detectados enquanto digita */}
            {detectedUrls.length > 0 && (
              <div className="px-4 pb-3 space-y-2">
                {detectedUrls.slice(0, 1).map((url) => (
                  <LinkPreview key={url} url={url} />
                ))}
              </div>
            )}

            {/* Gravador de voz em andamento */}
            {isRecording && (
              <div className="px-4 pb-3">
                <VoiceRecorder
                  onRecorded={(blob, duration) => {
                    setPendingAudio({ blob, duration });
                    setIsRecording(false);
                  }}
                  onCancel={() => setIsRecording(false)}
                />
              </div>
            )}

            {pendingAudio && (
              <div className="px-4 pb-3 flex items-center gap-2 text-xs text-amber-700 dark:text-amber-400 bg-amber-500/10 p-2 rounded-xl mx-4 mb-2">
                <Check className="w-4 h-4" />
                Áudio de voz pronto ({pendingAudio.duration}s)
              </div>
            )}

            {/* Barra de ações inferior */}
            <div className="px-4 py-2.5 flex items-center justify-between border-t border-black/5 dark:border-white/5">
              <div className="flex items-center gap-1">
                <ColorPicker selectedColor={color} onSelectColor={setColor} />

                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  title="Inserir imagem"
                  className="p-1.5 text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/10 rounded-full transition"
                >
                  <ImageIcon className="w-4 h-4" />
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={handleImageSelect}
                />

                <button
                  type="button"
                  onClick={() => setIsRecording(true)}
                  title="Gravar áudio"
                  className="p-1.5 text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/10 rounded-full transition"
                >
                  <Mic className="w-4 h-4" />
                </button>
              </div>

              <button
                type="button"
                disabled={isSubmitting}
                onClick={handleSaveAndClose}
                className="px-4 py-1.5 text-xs font-semibold bg-slate-900 hover:bg-slate-800 dark:bg-white dark:hover:bg-slate-100 text-white dark:text-slate-900 rounded-lg transition disabled:opacity-50"
              >
                {isSubmitting ? "Salvando..." : "Fechar"}
              </button>
            </div>
          </div>
        ) : (
          <div
            onClick={() => setIsExpanded(true)}
            className="p-3.5 px-5 flex items-center justify-between cursor-text"
          >
            <span className="text-slate-500 dark:text-slate-400 text-sm font-medium">
              Criar uma nota...
            </span>
            <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                onClick={() => {
                  setIsExpanded(true);
                  setTimeout(() => fileInputRef.current?.click(), 50);
                }}
                className="p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/10 rounded-full transition"
              >
                <ImageIcon className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsExpanded(true);
                  setIsRecording(true);
                }}
                className="p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/10 rounded-full transition"
              >
                <Mic className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
