"use client";

import { useState, useEffect, useCallback } from "react";
import Header from "@/components/Header";
import NoteCard from "@/components/NoteCard";
import NoteModal from "@/components/NoteModal";
import { Note, Attachment } from "@/types/note";
import { Archive, SearchX } from "lucide-react";

export default function ArchivePage() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  const [loading, setLoading] = useState(true);

  const loadNotes = useCallback(async () => {
    try {
      const res = await fetch("/api/notes?archived=1");
      const data = await res.json();
      if (res.ok) {
        setNotes(data.notes || []);
      }
    } catch (err) {
      console.error("Erro ao carregar notas arquivadas:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadNotes();
  }, [loadNotes]);

  // Handler para desmarcar arquivamento
  async function handleToggleArchive(noteId: string) {
    setNotes((prev) => prev.filter((n) => n.id !== noteId));
    await fetch(`/api/notes/${noteId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_archived: false }),
    });
  }

  async function handleChangeColor(noteId: string, color: string) {
    setNotes((prev) =>
      prev.map((n) => (n.id === noteId ? { ...n, color, updated_at: Date.now() } : n))
    );
    await fetch(`/api/notes/${noteId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ color }),
    });
  }

  async function handleDeleteNote(noteId: string) {
    if (!confirm("Deseja realmente excluir permanentemente esta nota?")) return;
    setNotes((prev) => prev.filter((n) => n.id !== noteId));
    if (selectedNote && selectedNote.id === noteId) {
      setSelectedNote(null);
    }
    await fetch(`/api/notes/${noteId}`, { method: "DELETE" });
  }

  async function handleUpdateNote(updatedFields: Partial<Note> & { skipPatch?: boolean }) {
    if (!selectedNote) return;
    const noteId = selectedNote.id;
    const { skipPatch, ...fields } = updatedFields;

    if (fields.is_archived === false) {
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
      setSelectedNote(null);
    } else {
      setNotes((prev) =>
        prev.map((n) => (n.id === noteId ? { ...n, ...fields, updated_at: Date.now() } : n))
      );
    }

    if (skipPatch) return;

    await fetch(`/api/notes/${noteId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
  }

  const filteredNotes = notes.filter((n) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q);
  });

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col">
      <Header searchQuery={searchQuery} onSearchChange={setSearchQuery} />

      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8">
        <div className="mb-6 flex items-center gap-2 text-slate-700 dark:text-slate-300">
          <Archive className="w-5 h-5 text-amber-500" />
          <h1 className="text-xl font-bold">Arquivo de Notas</h1>
        </div>

        {loading ? (
          <div className="flex justify-center items-center py-20 text-slate-400">
            Carregando notas arquivadas...
          </div>
        ) : filteredNotes.length === 0 ? (
          <div className="text-center py-24 text-slate-400 flex flex-col items-center gap-3">
            {searchQuery ? (
              <>
                <SearchX className="w-12 h-12 text-slate-300 dark:text-slate-700" />
                <p className="text-sm">Nenhuma nota arquivada com &quot;{searchQuery}&quot;.</p>
              </>
            ) : (
              <>
                <Archive className="w-14 h-14 text-slate-300 dark:text-slate-700" />
                <p className="text-base font-medium text-slate-500 dark:text-slate-400">
                  Nenhuma nota arquivada.
                </p>
                <p className="text-xs text-slate-400">
                  Notas que você arquivar aparecerão aqui.
                </p>
              </>
            )}
          </div>
        ) : (
          <div className="columns-1 sm:columns-2 md:columns-3 lg:columns-4 gap-4 space-y-4">
            {filteredNotes.map((note) => (
              <div key={note.id} className="break-inside-avoid">
                <NoteCard
                  note={note}
                  onClick={() => setSelectedNote(note)}
                  onTogglePin={() => {}}
                  onToggleArchive={(e) => {
                    e.stopPropagation();
                    handleToggleArchive(note.id);
                  }}
                  onDelete={(e) => {
                    e.stopPropagation();
                    handleDeleteNote(note.id);
                  }}
                  onChangeColor={(color) => handleChangeColor(note.id, color)}
                />
              </div>
            ))}
          </div>
        )}
      </main>

      {selectedNote && (
        <NoteModal
          note={selectedNote}
          isOpen={Boolean(selectedNote)}
          onClose={() => setSelectedNote(null)}
          onUpdate={handleUpdateNote}
          onDelete={() => handleDeleteNote(selectedNote.id)}
          onAddAttachment={() => {}}
          onRemoveAttachment={() => {}}
        />
      )}
    </div>
  );
}
