"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Sidebar from "@/components/Sidebar";
import NoteEditor from "@/components/NoteEditor";
import { Note, Attachment } from "@/types/note";
import { StickyNote, Plus, Menu } from "lucide-react";

export default function DashboardPage() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [searchResults, setSearchResults] = useState<Note[] | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTagFilter, setActiveTagFilter] = useState<string | null>(null);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  // Carrega as notas iniciais
  const loadNotes = useCallback(async () => {
    try {
      const res = await fetch("/api/notes?archived=0");
      const data = await res.json();
      if (res.ok && Array.isArray(data.notes)) {
        setNotes(data.notes);
        // Seleciona a primeira nota no desktop caso nenhuma esteja selecionada
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

  // Busca reativa FTS5
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

  // Lista de notas a exibir (busca ou lista geral)
  const displayedNotes = useMemo(() => {
    return searchResults !== null ? searchResults : notes;
  }, [notes, searchResults]);

  // Nota selecionada atual (mantém sincronizada com a lista de notas)
  const selectedNote = useMemo(() => {
    if (!selectedNoteId) return null;
    return notes.find((n) => n.id === selectedNoteId) || null;
  }, [notes, selectedNoteId]);

  // PATCH compartilhado
  async function patchNote(noteId: string, fields: Record<string, unknown>): Promise<boolean> {
    try {
      const res = await fetch(`/api/notes/${noteId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      });
      return res.ok;
    } catch (err) {
      console.error("Erro ao atualizar nota:", err);
      return false;
    }
  }

  // Criar uma nova nota
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
        setIsSidebarOpen(false); // Fecha sidebar no mobile para mostrar o editor
      }
    } catch (err) {
      console.error("Erro ao criar nota:", err);
      alert("Erro ao criar nova nota.");
    }
  }

  // Atualizar nota (do NoteEditor)
  async function handleUpdateNote(updatedFields: Partial<Note> & { skipPatch?: boolean }) {
    if (!selectedNoteId) return;
    const noteId = selectedNoteId;
    const { skipPatch, ...fields } = updatedFields;

    const previous = notes.find((n) => n.id === noteId);
    setNotes((prev) =>
      prev.map((n) => (n.id === noteId ? { ...n, ...fields, updated_at: Date.now() } : n))
    );

    if (skipPatch) return;

    const ok = await patchNote(noteId, fields);
    if (!ok && previous) {
      // Falha no servidor: desfaz otimismo
      const { updated_at, ...revertFields } = previous;
      void updated_at;
      setNotes((prev) =>
        prev.map((n) =>
          n.id === noteId ? { ...n, ...revertFields, updated_at: previous.updated_at } : n
        )
      );
    }
  }

  // Alternar fixação
  async function handleTogglePin() {
    if (!selectedNote) return;
    const noteId = selectedNote.id;
    const nextPin = !selectedNote.is_pinned;

    setNotes((prev) =>
      prev.map((n) => (n.id === noteId ? { ...n, is_pinned: nextPin, updated_at: Date.now() } : n))
    );

    const ok = await patchNote(noteId, { is_pinned: nextPin });
    if (!ok) {
      setNotes((prev) =>
        prev.map((n) =>
          n.id === noteId ? { ...n, is_pinned: selectedNote.is_pinned } : n
        )
      );
    }
  }

  // Alternar arquivamento
  async function handleToggleArchive() {
    if (!selectedNote) return;
    const noteId = selectedNote.id;
    const nextArchive = !selectedNote.is_archived;

    // Remove da lista
    const removed = selectedNote;
    setNotes((prev) => prev.filter((n) => n.id !== noteId));

    // Seleciona a próxima nota se houver
    const remaining = notes.filter((n) => n.id !== noteId);
    setSelectedNoteId(remaining.length > 0 ? remaining[0].id : null);

    const ok = await patchNote(noteId, { is_archived: nextArchive });
    if (!ok && removed) {
      setNotes((prev) => [removed, ...prev]);
      setSelectedNoteId(removed.id);
    }
  }

  // Excluir nota
  async function handleDeleteNote() {
    if (!selectedNote) return;
    if (!confirm("Deseja realmente excluir esta nota?")) return;

    const noteId = selectedNote.id;
    const removed = selectedNote;
    const remaining = notes.filter((n) => n.id !== noteId);

    setNotes(remaining);
    setSelectedNoteId(remaining.length > 0 ? remaining[0].id : null);

    try {
      const res = await fetch(`/api/notes/${noteId}`, { method: "DELETE" });
      if (!res.ok) {
        setNotes((prev) => [removed, ...prev]);
        setSelectedNoteId(removed.id);
      }
    } catch (err) {
      console.error("Erro ao excluir nota:", err);
      setNotes((prev) => [removed, ...prev]);
      setSelectedNoteId(removed.id);
    }
  }

  // Anexos
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
    <div className="h-dvh w-full flex overflow-hidden bg-slate-950 text-slate-100">
      {/* ── Sidebar de Navegação (estilo Obsidian / Joplin) ── */}
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
      />

      {/* ── Área Principal / Editor ── */}
      <main className="flex-1 h-full flex flex-col min-w-0 bg-slate-950 overflow-hidden">
        {loading ? (
          <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">
            Carregando suas notas...
          </div>
        ) : selectedNote ? (
          <NoteEditor
            key={selectedNote.id}
            note={selectedNote}
            onUpdate={handleUpdateNote}
            onDelete={handleDeleteNote}
            onTogglePin={handleTogglePin}
            onToggleArchive={handleToggleArchive}
            onAddAttachment={handleAddAttachment}
            onRemoveAttachment={handleRemoveAttachment}
            onMenuClick={() => setIsSidebarOpen(true)}
          />
        ) : (
          <div className="flex-1 flex flex-col h-full">
            {/* Header mobile para abrir menu quando nenhuma nota está aberta */}
            <div className="md:hidden p-3 border-b border-slate-800 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setIsSidebarOpen(true)}
                className="p-1.5 text-slate-400 hover:text-white rounded-lg transition"
              >
                <Menu className="w-5 h-5" />
              </button>
              <span className="font-semibold text-sm text-slate-300">Notas</span>
            </div>

            {/* Estado Vazio */}
            <div className="flex-1 flex flex-col items-center justify-center p-6 text-center select-none">
              <div className="w-16 h-16 bg-amber-400/10 text-amber-400 rounded-2xl flex items-center justify-center mb-4 shadow-sm border border-amber-400/20">
                <StickyNote className="w-8 h-8" />
              </div>
              <h2 className="text-lg font-semibold text-white mb-1">
                Nenhuma nota selecionada
              </h2>
              <p className="text-sm text-slate-400 max-w-sm mb-6 leading-relaxed">
                Selecione uma nota na lista lateral ou crie uma nova nota para começar a escrever.
              </p>
              <button
                type="button"
                onClick={handleCreateNote}
                className="flex items-center gap-2 px-4 py-2 bg-amber-400 hover:bg-amber-300 text-slate-950 font-semibold text-sm rounded-xl transition shadow-sm active:scale-95"
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
