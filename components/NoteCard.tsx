"use client";

import { Pin, Archive, ArchiveRestore, Trash2, Image as ImageIcon } from "lucide-react";
import { Note } from "@/types/note";
import AudioPlayer from "./AudioPlayer";
import ColorPicker from "./ColorPicker";
import LinkPreview, { extractUrls } from "./LinkPreview";

interface NoteCardProps {
  note: Note;
  onClick: () => void;
  onTogglePin: (e: React.MouseEvent) => void;
  onToggleArchive: (e: React.MouseEvent) => void;
  onDelete: (e: React.MouseEvent) => void;
  onChangeColor: (color: string) => void;
}

export default function NoteCard({
  note,
  onClick,
  onTogglePin,
  onToggleArchive,
  onDelete,
  onChangeColor,
}: NoteCardProps) {
  const imageAttachments = note.attachments?.filter((a) => a.mime_type.startsWith("image/")) || [];
  const audioAttachments = note.attachments?.filter((a) => a.mime_type.startsWith("audio/")) || [];
  const detectedUrls = extractUrls(note.body);

  return (
    <div
      onClick={onClick}
      className={`group relative rounded-2xl border transition-all duration-200 hover:shadow-lg cursor-pointer overflow-hidden flex flex-col justify-between note-color-${note.color}`}
    >
      {/* Botão de Fixar */}
      <button
        type="button"
        onClick={onTogglePin}
        title={note.is_pinned ? "Desafixar nota" : "Fixar nota"}
        className={`absolute top-3 right-3 p-1.5 rounded-full transition z-10 ${
          note.is_pinned
            ? "text-amber-500 bg-amber-500/10"
            : "text-slate-400 opacity-0 group-hover:opacity-100 hover:text-slate-700 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/10"
        }`}
      >
        <Pin className={`w-4 h-4 ${note.is_pinned ? "fill-amber-500" : ""}`} />
      </button>

      <div>
        {/* Previews de Imagem */}
        {imageAttachments.length > 0 && (
          <div className="w-full max-h-56 overflow-hidden bg-black/5 dark:bg-black/20">
            {imageAttachments.slice(0, 1).map((img) => (
              <img
                key={img.id}
                src={`/api/attachments/${img.id}`}
                alt={img.file_name}
                loading="lazy"
                className="w-full h-auto object-cover max-h-56"
              />
            ))}
          </div>
        )}

        <div className="p-4 space-y-2.5">
          {/* Título */}
          {note.title && (
            <h3
              className="font-semibold text-slate-900 dark:text-white text-base leading-snug break-words"
              dangerouslySetInnerHTML={{
                __html: note.title_snippet || note.title,
              }}
            />
          )}

          {/* Corpo do texto */}
          {note.body && (
            <p
              className="text-slate-700 dark:text-slate-300 text-sm whitespace-pre-wrap break-words leading-relaxed line-clamp-6 font-normal"
              dangerouslySetInnerHTML={{
                __html: note.body_snippet || note.body,
              }}
            />
          )}

          {/* Marcadores automáticos */}
          {note.tags && note.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
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

          {/* Previews de Links Ricos (YouTube, Sites, Artigos) */}
          {detectedUrls.length > 0 && (
            <div className="pt-1 space-y-2">
              {detectedUrls.slice(0, 2).map((url) => (
                <LinkPreview key={url} url={url} />
              ))}
            </div>
          )}

          {/* Áudios */}
          {audioAttachments.length > 0 && (
            <div className="pt-1 space-y-2">
              {audioAttachments.map((audio) => (
                <AudioPlayer
                  key={audio.id}
                  src={`/api/attachments/${audio.id}`}
                  durationSeconds={audio.duration_seconds}
                  fileName={audio.file_name}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Barra de Ações Rápidas (visível ao hover) */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="px-3 py-2 flex items-center justify-between opacity-0 group-hover:opacity-100 transition-opacity border-t border-black/5 dark:border-white/5"
      >
        <div className="flex items-center gap-1">
          <ColorPicker selectedColor={note.color} onSelectColor={onChangeColor} />

          <button
            type="button"
            onClick={onToggleArchive}
            title={note.is_archived ? "Desarquivar" : "Arquivar"}
            className="p-1.5 text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/10 rounded-full transition"
          >
            {note.is_archived ? <ArchiveRestore className="w-4 h-4" /> : <Archive className="w-4 h-4" />}
          </button>
        </div>

        <button
          type="button"
          onClick={onDelete}
          title="Excluir nota"
          className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 rounded-full transition"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
