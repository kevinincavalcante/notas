"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { Note, Tag } from "@/types/note";
import {
  StickyNote,
  Search,
  Plus,
  Pin,
  X,
  Tag as TagIcon,
  LogOut,
  Mic,
  Image as ImageIcon,
  Archive,
} from "lucide-react";
import { useRouter } from "next/navigation";
import Link from "next/link";

interface SidebarProps {
  notes: Note[];
  selectedNoteId: string | null;
  onSelectNote: (note: Note) => void;
  onCreateNote: () => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  isOpen: boolean;
  onClose: () => void;
  activeTagFilter: string | null;
  onTagFilter: (tag: string | null) => void;
}

/**
 * Formata timestamp Unix (ms) em data relativa em português.
 */
function formatRelativeDate(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return "agora";
  if (minutes < 60) return `há ${minutes}min`;
  if (hours < 24) return `há ${hours}h`;
  if (days === 1) return "ontem";
  if (days < 7) return `há ${days}d`;

  const date = new Date(timestamp);
  const day = date.getDate();
  const months = [
    "jan", "fev", "mar", "abr", "mai", "jun",
    "jul", "ago", "set", "out", "nov", "dez",
  ];
  const month = months[date.getMonth()];

  if (days < 365) return `${day} ${month}`;
  return `${day} ${month} ${date.getFullYear()}`;
}

/**
 * Remove sintaxe markdown para exibir um preview limpo.
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // imagens
    .replace(/\[[^\]]*\]\([^)]*\)/g, (m) => m.replace(/\[([^\]]*)\]\([^)]*\)/, "$1")) // links
    .replace(/#{1,6}\s+/g, "") // headings
    .replace(/[*_~`]/g, "") // bold, italic, strikethrough, code
    .replace(/>\s+/g, "") // blockquotes
    .replace(/[-*+]\s+/g, "") // unordered list
    .replace(/\d+\.\s+/g, "") // ordered list
    .replace(/\n+/g, " ") // newlines
    .trim();
}

export default function Sidebar({
  notes,
  selectedNoteId,
  onSelectNote,
  onCreateNote,
  searchQuery,
  onSearchChange,
  isOpen,
  onClose,
  activeTagFilter,
  onTagFilter,
}: SidebarProps) {
  const [localQuery, setLocalQuery] = useState(searchQuery);
  const router = useRouter();

  // Sincroniza query local com o pai
  useEffect(() => {
    setLocalQuery(searchQuery);
  }, [searchQuery]);

  // Debounce de busca (250ms)
  useEffect(() => {
    const timer = setTimeout(() => {
      onSearchChange(localQuery);
    }, 250);
    return () => clearTimeout(timer);
  }, [localQuery, onSearchChange]);

  // Aplica filtro de tag se ativo
  const filteredNotes = useMemo(() => {
    if (!activeTagFilter) return notes;
    return notes.filter((n) => n.tags?.some((t) => t.name === activeTagFilter));
  }, [notes, activeTagFilter]);

  // Separa fixadas / normais
  const pinnedNotes = useMemo(
    () => filteredNotes.filter((n) => n.is_pinned),
    [filteredNotes]
  );
  const otherNotes = useMemo(
    () => filteredNotes.filter((n) => !n.is_pinned),
    [filteredNotes]
  );

  // Coleta tags únicas de TODAS as notas (não filtradas)
  const allTags = useMemo(() => {
    const tagMap = new Map<string, Tag>();
    for (const note of notes) {
      if (note.tags) {
        for (const tag of note.tags) {
          if (!tagMap.has(tag.name)) {
            tagMap.set(tag.name, tag);
          }
        }
      }
    }
    return Array.from(tagMap.values()).sort((a, b) =>
      a.name.localeCompare(b.name, "pt-BR")
    );
  }, [notes]);

  const handleLogout = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      router.push("/login");
      router.refresh();
    } catch (e) {
      console.error(e);
    }
  }, [router]);

  const handleSelectNote = useCallback(
    (note: Note) => {
      onSelectNote(note);
      onClose(); // fecha sidebar no mobile
    },
    [onSelectNote, onClose]
  );

  return (
    <>
      {/* Backdrop para mobile */}
      {isOpen && (
        <div
          onClick={onClose}
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm md:hidden"
          aria-hidden="true"
        />
      )}

      {/* Sidebar */}
      <aside
        className={`
          fixed top-0 left-0 z-50 h-dvh w-[280px] flex flex-col
          bg-slate-900 border-r border-slate-800
          transition-transform duration-300 ease-in-out
          md:relative md:translate-x-0 md:z-auto
          ${isOpen ? "translate-x-0" : "-translate-x-full"}
        `}
      >
        {/* ── Topo: Logo + Fechar (mobile) ── */}
        <div className="flex items-center justify-between px-4 pt-4 pb-2 shrink-0">
          <div className="flex items-center gap-2.5 group">
            <div className="w-8 h-8 bg-amber-400 text-slate-950 rounded-lg flex items-center justify-center font-bold shadow-sm">
              <StickyNote className="w-4 h-4" />
            </div>
            <span className="font-bold text-lg text-amber-400 tracking-tight">
              Notas
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-500 hover:text-white rounded-lg md:hidden transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* ── Busca ── */}
        <div className="px-3 pb-2 shrink-0">
          <div className="relative flex items-center">
            <Search className="w-4 h-4 text-slate-500 absolute left-3 pointer-events-none" />
            <input
              type="text"
              value={localQuery}
              onChange={(e) => setLocalQuery(e.target.value)}
              placeholder="Pesquisar notas..."
              className="w-full pl-9 pr-8 py-2 bg-slate-800 border border-transparent focus:border-slate-700 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none transition"
            />
            {localQuery && (
              <button
                type="button"
                onClick={() => {
                  setLocalQuery("");
                  onSearchChange("");
                }}
                className="absolute right-2.5 p-0.5 text-slate-500 hover:text-slate-300"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* ── Botão Nova Nota ── */}
        <div className="px-3 pb-3 shrink-0">
          <button
            type="button"
            onClick={onCreateNote}
            className="w-full flex items-center justify-center gap-2 py-2 bg-amber-400 hover:bg-amber-300 text-slate-950 font-semibold text-sm rounded-lg transition active:scale-[0.98] shadow-sm"
          >
            <Plus className="w-4 h-4" />
            Nova Nota
          </button>
        </div>

        {/* ── Lista de Notas ── */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden px-1.5 space-y-3">
          {/* Fixadas */}
          {pinnedNotes.length > 0 && (
            <div>
              <h3 className="px-2.5 pt-1 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500 flex items-center gap-1">
                <Pin className="w-3 h-3 text-amber-400 fill-amber-400" />
                Fixadas
              </h3>
              <ul className="space-y-0.5">
                {pinnedNotes.map((note) => (
                  <NoteItem
                    key={note.id}
                    note={note}
                    isSelected={note.id === selectedNoteId}
                    onSelect={handleSelectNote}
                  />
                ))}
              </ul>
            </div>
          )}

          {/* Todas */}
          <div>
            <h3 className="px-2.5 pt-1 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              {pinnedNotes.length > 0 ? "Outras" : "Todas"}
            </h3>
            {otherNotes.length === 0 && pinnedNotes.length === 0 ? (
              <p className="px-3 py-6 text-sm text-slate-600 text-center">
                {searchQuery || activeTagFilter
                  ? "Nenhuma nota encontrada"
                  : "Nenhuma nota ainda. Crie uma!"}
              </p>
            ) : (
              <ul className="space-y-0.5">
                {otherNotes.map((note) => (
                  <NoteItem
                    key={note.id}
                    note={note}
                    isSelected={note.id === selectedNoteId}
                    onSelect={handleSelectNote}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* ── Tags ── */}
        {allTags.length > 0 && (
          <div className="px-3 py-2.5 border-t border-slate-800 shrink-0">
            <div className="flex items-center gap-1.5 mb-2">
              <TagIcon className="w-3.5 h-3.5 text-slate-500" />
              <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                Marcadores
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
              {activeTagFilter && (
                <button
                  type="button"
                  onClick={() => onTagFilter(null)}
                  className="text-[11px] leading-none font-medium px-2 py-1 rounded-full bg-slate-700 text-slate-300 hover:bg-slate-600 transition"
                >
                  Todos ×
                </button>
              )}
              {allTags.map((tag) => {
                const isActive = activeTagFilter === tag.name;
                return (
                  <button
                    key={tag.id}
                    type="button"
                    onClick={() =>
                      onTagFilter(isActive ? null : tag.name)
                    }
                    className={`text-[11px] leading-none font-medium px-2 py-1 rounded-full transition ${
                      isActive
                        ? "bg-amber-400 text-slate-950 font-semibold"
                        : tag.kind === "auto"
                          ? "bg-amber-400/15 text-amber-300 hover:bg-amber-400/25"
                          : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                    }`}
                  >
                    {tag.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Rodapé: Arquivo + Logout ── */}
        <div className="px-3 py-2 border-t border-slate-800 shrink-0 flex items-center justify-between">
          <Link
            href="/archive"
            className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition py-1 px-2 rounded-lg hover:bg-slate-800"
          >
            <Archive className="w-3.5 h-3.5" />
            <span>Arquivo</span>
          </Link>

          <button
            type="button"
            onClick={handleLogout}
            className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-red-400 transition py-1 px-2 rounded-lg hover:bg-slate-800"
            title="Sair"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Sair</span>
          </button>
        </div>
      </aside>
    </>
  );
}

/**
 * Item individual de nota na listagem da Sidebar
 */
function NoteItem({
  note,
  isSelected,
  onSelect,
}: {
  note: Note;
  isSelected: boolean;
  onSelect: (note: Note) => void;
}) {
  const preview = useMemo(() => {
    const raw = note.body_snippet || note.body || "";
    return stripMarkdown(raw);
  }, [note.body, note.body_snippet]);

  const hasAudio = note.attachments?.some((a) =>
    a.mime_type.startsWith("audio/")
  );
  const hasImage = note.attachments?.some((a) =>
    a.mime_type.startsWith("image/")
  );

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(note)}
        className={`
          w-full text-left px-3 py-2.5 rounded-lg transition-all flex flex-col gap-0.5
          ${
            isSelected
              ? "border-l-2 border-amber-400 bg-slate-800/80 text-white pl-2.5 shadow-sm"
              : "border-l-2 border-transparent text-slate-300 hover:bg-slate-800/40 hover:text-white"
          }
        `}
      >
        {/* Linha superior: Título + Badges de anexo + Data */}
        <div className="flex items-center justify-between gap-1.5 w-full">
          <div className="flex items-center gap-1.5 min-w-0 flex-1">
            {note.is_pinned && (
              <Pin className="w-3 h-3 text-amber-400 fill-amber-400 shrink-0" />
            )}
            <span
              className={`text-sm truncate leading-snug ${
                isSelected ? "font-semibold text-white" : "font-medium"
              }`}
            >
              {note.title.trim() || "Sem título"}
            </span>
          </div>

          <span className="text-[10px] text-slate-500 shrink-0 font-mono">
            {formatRelativeDate(note.updated_at || note.created_at)}
          </span>
        </div>

        {/* Linha inferior: Preview do corpo + Ícones de anexo */}
        <div className="flex items-center justify-between gap-1 text-[11px] text-slate-500 w-full">
          <p className="truncate flex-1 min-w-0">
            {preview || <span className="italic">Nota vazia</span>}
          </p>

          <div className="flex items-center gap-1 shrink-0 text-slate-500">
            {hasImage && <ImageIcon className="w-3 h-3" />}
            {hasAudio && <Mic className="w-3 h-3" />}
          </div>
        </div>
      </button>
    </li>
  );
}
