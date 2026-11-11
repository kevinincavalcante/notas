"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Sidebar from "@/components/Sidebar";
import NoteEditor from "@/components/NoteEditor";
import { Note, Attachment, Tag } from "@/types/note";
import { StickyNote, Plus, Menu } from "lucide-react";
import { useUI } from "@/components/UIProvider";

export default function DashboardPage() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [searchResults, setSearchResults] = useState<Note[] | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTagFilter, setActiveTagFilter] = useState<string | null>(null);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const { confirm, showToast } = useUI();

  const loadNotes = useCallback(async () => {
    try {
      const res = await fetch("/api/notes?archived=0");
      const data = await res.json();
      if (res.ok && Array.isArray(data.notes)) {
        setNotes(data.notes);
        if (data.notes.length > 0 && typeof window !== "undefined" && window.innerWidth >= 768) {
          setSelectedNoteId((prev) => prev || data.notes[0].id);
        }
      }
    } catch (err) {
      console.error("Erro ao carregar notas:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadNotes();
  }, [loadNotes]);

  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults(null);
      return;
    }

    const controller = new AbortController();

    async function performSearch() {
      try {
        const res = await fetch(`/api/notes/search?q=${encodeURIComponent(searchQuery)}`, {
          signal: controller.signal,
        });
        const data = await res.json();
        if (res.ok) {
          setSearchResults(data.notes || []);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error("Erro na busca:", err);
      }
    }

    performSearch();
    return () => {
      controller.abort();
    };
  }, [searchQuery]);

  const displayedNotes = useMemo(() => {
    return searchResults !== null ? searchResults : notes;
  }, [notes, searchResults]);

  const selectedNote = useMemo(() => {
    if (!selectedNoteId) return null;
    return notes.find((n) => n.id === selectedNoteId) || null;
  }, [notes, selectedNoteId]);

  async function patchNote(
    noteId: string,
    fields: Record<string, unknown>
  ): Promise<{ ok: boolean; tags?: Tag[] }> {
    try {
      const res = await fetch(`/api/notes/${noteId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      });
      if (!res.ok) return { ok: false };
      const data = await res.json().catch(() => null);
      // Quando o corpo mudou, o servidor devolve as auto-tags recalculadas
      return { ok: true, tags: Array.isArray(data?.tags) ? data.tags : undefined };
    } catch (err) {
      console.error("Erro ao atualizar nota:", err);
      return { ok: false };
    }
  }

  async function handleCreateNote() {
    try {
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "",
          body: "",
          color: "default",
        }),
      });
      const data = await res.json();
      if (res.ok && data.note) {
        const newNote: Note = {
          ...data.note,
          attachments: [],
          tags: [],
        };
        setNotes((prev) => [newNote, ...prev]);
        setSelectedNoteId(newNote.id);
        setIsSidebarOpen(false);
      }
    } catch (err) {
      console.error("Erro ao criar nota:", err);
      showToast("Não foi possível criar uma nova nota.", "error");
    }
  }

  async function handleUpdateNote(updatedFields: Partial<Note> & { skipPatch?: boolean }) {
    if (!selectedNoteId) return;
    const noteId = selectedNoteId;
    const { skipPatch, ...fields } = updatedFields;

    const previous = notes.find((n) => n.id === noteId);
    setNotes((prev) =>
      prev.map((n) => (n.id === noteId ? { ...n, ...fields, updated_at: Date.now() } : n))
    );

    if (skipPatch) return;

    const result = await patchNote(noteId, fields);

    // Auto-tags recalculadas no servidor (ex: "Códigos") aparecem na hora
    if (result.ok && result.tags) {
      setNotes((prev) =>
        prev.map((n) => (n.id === noteId ? { ...n, tags: result.tags } : n))
      );
    }

    if (!result.ok && previous) {
      const { updated_at, ...revertFields } = previous;
      void updated_at;
      setNotes((prev) =>
        prev.map((n) =>
          n.id === noteId ? { ...n, ...revertFields, updated_at: previous.updated_at } : n
        )
      );
    }
  }

  async function handleTogglePin(targetNoteId?: string) {
    const noteId = targetNoteId || selectedNote?.id;
    if (!noteId) return;
    const target = notes.find((n) => n.id === noteId);
    if (!target) return;
    const nextPin = !target.is_pinned;

    setNotes((prev) =>
      prev.map((n) => (n.id === noteId ? { ...n, is_pinned: nextPin, updated_at: Date.now() } : n))
    );

    const ok = await patchNote(noteId, { is_pinned: nextPin });
    if (!ok) {
      setNotes((prev) =>
        prev.map((n) =>
          n.id === noteId ? { ...n, is_pinned: target.is_pinned } : n
        )
      );
    }
  }

  async function handleToggleArchive(targetNoteId?: string) {
    const noteId = targetNoteId || selectedNote?.id;
    if (!noteId) return;
    const target = notes.find((n) => n.id === noteId);
    if (!target) return;
    const nextArchive = !target.is_archived;

    setNotes((prev) => prev.filter((n) => n.id !== noteId));

    if (selectedNoteId === noteId) {
      const remaining = notes.filter((n) => n.id !== noteId);
      setSelectedNoteId(remaining.length > 0 ? remaining[0].id : null);
    }

    const ok = await patchNote(noteId, { is_archived: nextArchive });
    if (!ok) {
      setNotes((prev) => [target, ...prev]);
      if (selectedNoteId === null) {
        setSelectedNoteId(target.id);
      }
    }
  }

  async function handleDeleteNote(targetNoteId?: string) {
    const noteId = targetNoteId || selectedNote?.id;
    if (!noteId) return;

    const confirmed = await confirm({
      title: "Excluir nota",
      message: "Deseja realmente excluir esta nota? Os arquivos anexados e imagens também serão removidos do armazenamento.",
      confirmText: "Excluir",
      variant: "danger",
    });
    if (!confirmed) return;

    const removed = notes.find((n) => n.id === noteId);
    const remaining = notes.filter((n) => n.id !== noteId);

    setNotes(remaining);
    if (selectedNoteId === noteId) {
      setSelectedNoteId(remaining.length > 0 ? remaining[0].id : null);
    }

    try {
      const res = await fetch(`/api/notes/${noteId}`, { method: "DELETE" });
      if (!res.ok && removed) {
        setNotes((prev) => [removed, ...prev]);
        setSelectedNoteId(removed.id);
      }
    } catch (err) {
      console.error("Erro ao excluir nota:", err);
      if (removed) {
        setNotes((prev) => [removed, ...prev]);
        setSelectedNoteId(removed.id);
      }
    }
  }

  function handleAddAttachment(attachment: Attachment) {
    if (!selectedNoteId) return;
    const noteId = selectedNoteId;
    setNotes((prev) =>
      prev.map((n) => {
        if (n.id !== noteId) return n;
        const currentAtts = n.attachments || [];
        return { ...n, attachments: [...currentAtts, attachment] };
      })
    );
  }

  function handleRemoveAttachment(attachmentId: string) {
    if (!selectedNoteId) return;
    const noteId = selectedNoteId;
    setNotes((prev) =>
      prev.map((n) => {
        if (n.id !== noteId) return n;
        const currentAtts = n.attachments || [];
        return {
          ...n,
          attachments: currentAtts.filter((a) => a.id !== attachmentId),
        };
      })
    );
  }

  function handleSelectNote(note: Note) {
    setSelectedNoteId(note.id);
    setIsSidebarOpen(false);
  }

  return (
    <div className="h-dvh w-full flex overflow-hidden bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      <Sidebar
        notes={displayedNotes}
        selectedNoteId={selectedNoteId}
        onSelectNote={handleSelectNote}
        onCreateNote={handleCreateNote}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        isOpen={isSidebarOpen}
        onClose={() => setIsSidebarOpen(false)}
        activeTagFilter={activeTagFilter}
        onTagFilter={setActiveTagFilter}
        onTogglePin={handleTogglePin}
        onToggleArchive={handleToggleArchive}
        onDeleteNote={handleDeleteNote}
      />

      <main className="flex-1 h-full flex flex-col min-w-0 bg-slate-50 dark:bg-slate-950 overflow-hidden">
        {loading ? (
          <div className="flex-1 flex items-center justify-center text-slate-400 dark:text-slate-500 text-sm">
            Carregando suas notas...
          </div>
        ) : selectedNote ? (
          <NoteEditor
            key={selectedNote.id}
            note={selectedNote}
            onUpdate={handleUpdateNote}
            onDelete={() => handleDeleteNote(selectedNote.id)}
            onTogglePin={() => handleTogglePin(selectedNote.id)}
            onToggleArchive={() => handleToggleArchive(selectedNote.id)}
            onAddAttachment={handleAddAttachment}
            onRemoveAttachment={handleRemoveAttachment}
            onMenuClick={() => setIsSidebarOpen(true)}
          />
        ) : (
          <div className="flex-1 flex flex-col h-full">
            <div className="md:hidden p-3 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setIsSidebarOpen(true)}
                className="p-1.5 text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white rounded-lg transition"
              >
                <Menu className="w-5 h-5" />
              </button>
              <span className="font-semibold text-sm text-slate-800 dark:text-slate-300">Notas</span>
            </div>

            <div className="flex-1 flex flex-col items-center justify-center p-6 text-center select-none">
              <div className="w-16 h-16 bg-amber-400/10 text-amber-500 rounded-2xl flex items-center justify-center mb-4 shadow-xs border border-amber-400/20">
                <StickyNote className="w-8 h-8" />
              </div>
              <h2 className="text-lg font-semibold text-slate-900 dark:text-white mb-1">
                Nenhuma nota selecionada
              </h2>
              <p className="text-sm text-slate-600 dark:text-slate-400 max-w-sm mb-6 leading-relaxed">
                Selecione uma nota na lista lateral ou crie uma nova nota para começar a escrever.
              </p>
              <button
                type="button"
                onClick={handleCreateNote}
                className="flex items-center gap-2 px-4 py-2 bg-amber-400 hover:bg-amber-300 active:bg-amber-500 text-slate-950 font-semibold text-sm rounded-xl transition shadow-xs active:scale-95"
              >
                <Plus className="w-4 h-4" />
                Criar uma nota
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
