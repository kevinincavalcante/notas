"use client";

import { useState, useEffect, useCallback } from "react";
import Header from "@/components/Header";
import QuickNoteCreator from "@/components/QuickNoteCreator";
import NoteCard from "@/components/NoteCard";
import NoteModal from "@/components/NoteModal";
import { Note, Attachment } from "@/types/note";
import { Pin, StickyNote, SearchX } from "lucide-react";

export default function DashboardPage() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [searchResults, setSearchResults] = useState<Note[] | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  const [loading, setLoading] = useState(true);

  // Carrega as notas iniciais
  const loadNotes = useCallback(async () => {
    try {
      const res = await fetch("/api/notes?archived=0");
      const data = await res.json();
      if (res.ok) {
        setNotes(data.notes || []);
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

  // Efeito da busca reativa FTS5 (com AbortController para evitar corrida de respostas)
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
      // Cancela a requisição pendente se a query mudou ou o componente desmontou
      controller.abort();
    };
  }, [searchQuery]);

  // PATCH compartilhado com verificação de sucesso (retorna true quando o banco confirmou)
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

  // Handler para nova nota criada no QuickNoteCreator
  function handleNoteCreated(newNote: Note) {
    setNotes((prev) => [newNote, ...prev]);
  }

  // Handler para atualizar cor
  async function handleChangeColor(noteId: string, color: string) {
    const previous = notes.find((n) => n.id === noteId);
    setNotes((prev) =>
      prev.map((n) => (n.id === noteId ? { ...n, color, updated_at: Date.now() } : n))
    );
    if (selectedNote && selectedNote.id === noteId) {
      setSelectedNote((prev) => (prev ? { ...prev, color } : null));
    }
    const ok = await patchNote(noteId, { color });
    if (!ok && previous) {
      // Falha no servidor: desfaz a mudança otimista para manter UI e banco em sincronia
      setNotes((prev) =>
        prev.map((n) =>
          n.id === noteId ? { ...n, color: previous.color, updated_at: previous.updated_at } : n
        )
      );
      if (selectedNote && selectedNote.id === noteId) {
        setSelectedNote((prev) => (prev ? { ...prev, color: previous.color } : null));
      }
    }
  }

  // Handler para alternar fixação
  async function handleTogglePin(noteId: string, currentPin: boolean) {
    const nextPin = !currentPin;
    setNotes((prev) =>
      prev.map((n) => (n.id === noteId ? { ...n, is_pinned: nextPin, updated_at: Date.now() } : n))
    );
    const ok = await patchNote(noteId, { is_pinned: nextPin });
    if (!ok) {
      // Falha no servidor: desfaz a mudança otimista
      setNotes((prev) =>
        prev.map((n) => (n.id === noteId ? { ...n, is_pinned: currentPin } : n))
      );
    }
  }

  // Handler para alternar arquivamento
  async function handleToggleArchive(noteId: string, currentArchive: boolean) {
    const nextArchive = !currentArchive;
    // Guarda a nota para restaurar caso o servidor falhe
    const removed = notes.find((n) => n.id === noteId);
    // Remove da lista do dashboard
    setNotes((prev) => prev.filter((n) => n.id !== noteId));
    const ok = await patchNote(noteId, { is_archived: nextArchive });
    if (!ok && removed) {
      // Falha no servidor: devolve a nota à lista na posição original
      setNotes((prev) => {
        const idx = prev.findIndex((n) => n.id === removed.id);
        if (idx !== -1) return prev;
        return [removed, ...prev];
      });
    }
  }

  // Handler para excluir nota
  async function handleDeleteNote(noteId: string) {
    if (!confirm("Deseja realmente excluir esta nota?")) return;
    // Guarda a nota e sua posição para restaurar em caso de falha
    const removed = notes.find((n) => n.id === noteId);
    setNotes((prev) => prev.filter((n) => n.id !== noteId));
    if (selectedNote && selectedNote.id === noteId) {
      setSelectedNote(null);
    }
    try {
      const res = await fetch(`/api/notes/${noteId}`, { method: "DELETE" });
      if (!res.ok && removed) {
        console.error("Falha ao excluir nota no servidor");
        setNotes((prev) => {
          const idx = prev.findIndex((n) => n.id === removed.id);
          if (idx !== -1) return prev;
          return [removed, ...prev];
        });
        if (selectedNote && selectedNote.id === noteId) {
          setSelectedNote(removed);
        }
      }
    } catch (err) {
      console.error("Erro ao excluir nota:", err);
      if (removed) {
        setNotes((prev) => {
          const idx = prev.findIndex((n) => n.id === removed.id);
          if (idx !== -1) return prev;
          return [removed, ...prev];
        });
        if (selectedNote && selectedNote.id === noteId) {
          setSelectedNote(removed);
        }
      }
    }
  }

  // Handler para salvar edições do modal
  async function handleUpdateNote(updatedFields: Partial<Note> & { skipPatch?: boolean }) {
    if (!selectedNote) return;
    const noteId = selectedNote.id;
    const { skipPatch, ...fields } = updatedFields;

    const previous = notes.find((n) => n.id === noteId);
    setNotes((prev) =>
      prev.map((n) => (n.id === noteId ? { ...n, ...fields, updated_at: Date.now() } : n))
    );

    // Se a restauração já atualizou o banco diretamente, não faz outro PATCH
    if (skipPatch) return;

    const ok = await patchNote(noteId, fields);
    if (!ok && previous) {
      // Falha no servidor: desfaz a mudança otimista
      const { updated_at, ...revertFields } = previous;
      void updated_at;
      setNotes((prev) =>
        prev.map((n) =>
          n.id === noteId ? { ...n, ...revertFields, updated_at: previous.updated_at } : n
        )
      );
    }
  }

  // Anexos no modal
  function handleAddAttachment(attachment: Attachment) {
    if (!selectedNote) return;
    const noteId = selectedNote.id;
    const updatedAttachments = [...(selectedNote.attachments || []), attachment];

    setSelectedNote({ ...selectedNote, attachments: updatedAttachments });
    setNotes((prev) =>
      prev.map((n) => (n.id === noteId ? { ...n, attachments: updatedAttachments } : n))
    );
  }

  function handleRemoveAttachment(attachmentId: string) {
    if (!selectedNote) return;
    const noteId = selectedNote.id;
    const updatedAttachments = (selectedNote.attachments || []).filter(
      (a) => a.id !== attachmentId
    );

    setSelectedNote({ ...selectedNote, attachments: updatedAttachments });
    setNotes((prev) =>
      prev.map((n) => (n.id === noteId ? { ...n, attachments: updatedAttachments } : n))
    );
  }

  const pinnedNotes = notes.filter((n) => n.is_pinned);
  const otherNotes = notes.filter((n) => !n.is_pinned);

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col">
      <Header searchQuery={searchQuery} onSearchChange={setSearchQuery} />

      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8">
        {/* Caixa de criação rápida estilo Keep (oculta durante busca) */}
        {!searchQuery && <QuickNoteCreator onNoteCreated={handleNoteCreated} />}

        {loading ? (
          <div className="flex justify-center items-center py-20 text-slate-400">
            Carregando notas...
          </div>
        ) : searchResults !== null ? (
          /* Visualização dos Resultados da Busca FTS5 */
          <div>
            <h2 className="text-xs font-semibold tracking-wider text-slate-500 uppercase mb-4">
              Resultados da Busca ({searchResults.length})
            </h2>

            {searchResults.length === 0 ? (
              <div className="text-center py-16 text-slate-400 flex flex-col items-center gap-2">
                <SearchX className="w-12 h-12 text-slate-300 dark:text-slate-600" />
                <p className="text-sm">Nenhuma nota encontrada para &quot;{searchQuery}&quot;.</p>
              </div>
            ) : (
              <div className="columns-1 sm:columns-2 md:columns-3 lg:columns-4 gap-4 space-y-4">
                {searchResults.map((note) => (
                  <div key={note.id} className="break-inside-avoid">
                    <NoteCard
                      note={note}
                      onClick={() => setSelectedNote(note)}
                      onTogglePin={(e) => {
                        e.stopPropagation();
                        handleTogglePin(note.id, note.is_pinned);
                      }}
                      onToggleArchive={(e) => {
                        e.stopPropagation();
                        handleToggleArchive(note.id, note.is_archived);
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
          </div>
        ) : (
          /* Visualização Padrão: Fixadas e Outras */
          <div className="space-y-8">
            {/* Notas Fixadas */}
            {pinnedNotes.length > 0 && (
              <div>
                <h2 className="text-xs font-bold tracking-wider text-slate-500 dark:text-slate-400 uppercase mb-3 flex items-center gap-1.5">
                  <Pin className="w-3.5 h-3.5 fill-current" />
                  Fixadas
                </h2>
                <div className="columns-1 sm:columns-2 md:columns-3 lg:columns-4 gap-4 space-y-4">
                  {pinnedNotes.map((note) => (
                    <div key={note.id} className="break-inside-avoid">
                      <NoteCard
                        note={note}
                        onClick={() => setSelectedNote(note)}
                        onTogglePin={(e) => {
                          e.stopPropagation();
                          handleTogglePin(note.id, note.is_pinned);
                        }}
                        onToggleArchive={(e) => {
                          e.stopPropagation();
                          handleToggleArchive(note.id, note.is_archived);
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
              </div>
            )}

            {/* Outras Notas */}
            {otherNotes.length > 0 && (
              <div>
                {pinnedNotes.length > 0 && (
                  <h2 className="text-xs font-bold tracking-wider text-slate-500 dark:text-slate-400 uppercase mb-3">
                    Outras
                  </h2>
                )}
                <div className="columns-1 sm:columns-2 md:columns-3 lg:columns-4 gap-4 space-y-4">
                  {otherNotes.map((note) => (
                    <div key={note.id} className="break-inside-avoid">
                      <NoteCard
                        note={note}
                        onClick={() => setSelectedNote(note)}
                        onTogglePin={(e) => {
                          e.stopPropagation();
                          handleTogglePin(note.id, note.is_pinned);
                        }}
                        onToggleArchive={(e) => {
                          e.stopPropagation();
                          handleToggleArchive(note.id, note.is_archived);
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
              </div>
            )}

            {notes.length === 0 && (
              <div className="text-center py-24 text-slate-400 flex flex-col items-center gap-3">
                <StickyNote className="w-14 h-14 text-slate-300 dark:text-slate-700" />
                <p className="text-base font-medium text-slate-500 dark:text-slate-400">
                  Nenhuma nota por enquanto.
                </p>
                <p className="text-xs text-slate-400">
                  Crie sua primeira nota usando a caixa acima!
                </p>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Modal de visualização e edição detalhada */}
      {selectedNote && (
        <NoteModal
          note={selectedNote}
          isOpen={Boolean(selectedNote)}
          onClose={() => setSelectedNote(null)}
          onUpdate={handleUpdateNote}
          onDelete={() => handleDeleteNote(selectedNote.id)}
          onAddAttachment={handleAddAttachment}
          onRemoveAttachment={handleRemoveAttachment}
        />
      )}
    </div>
  );
}
