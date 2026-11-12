"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import Sidebar from "@/components/Sidebar";
import NoteEditor from "@/components/NoteEditor";
import TabStrip from "@/components/TabStrip";
import { Note, Attachment, Tag } from "@/types/note";
import { StickyNote, Plus, Menu } from "lucide-react";
import { useUI } from "@/components/UIProvider";

export default function DashboardPage() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [searchResults, setSearchResults] = useState<Note[] | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTagFilter, setActiveTagFilter] = useState<string | null>(null);
  // Abas estilo browser (desktop): várias notas abertas de uma vez.
  // selectedNoteId continua existindo como alias da aba ativa.
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const { confirm, showToast } = useUI();

  // Espelho sempre-fresco do notes (usado em paths async de save/exclusão,
  // ex: flush de save no unmount de uma aba recém-excluída)
  const notesRef = useRef<Note[]>([]);
  useEffect(() => {
    notesRef.current = notes;
  }, [notes]);

  const selectedNoteId = activeTabId;

  /** Abre uma nota em nova aba (não fecha a atual) e ativa ela. */
  function openTabNew(noteId: string) {
    setOpenTabs((prev) => (prev.includes(noteId) ? prev : [...prev, noteId]));
    setActiveTabId(noteId);
  }

  /** Ativa a aba da nota se já aberta; senão abre em nova aba. */
  function openTab(noteId: string) {
    if (openTabs.includes(noteId)) {
      setActiveTabId(noteId);
    } else {
      openTabNew(noteId);
    }
  }

  /** Fecha uma aba; se era a ativa, ativa a vizinha. No-op se não está aberta. */
  function closeTab(tabId: string) {
    if (!openTabs.includes(tabId)) return;
    const idx = openTabs.indexOf(tabId);
    const rest = openTabs.filter((t) => t !== tabId);
    setOpenTabs(rest);
    if (activeTabId === tabId) {
      setActiveTabId(rest.length > 0 ? rest[Math.min(idx, rest.length - 1)] : null);
    }
  }

  function closeActiveTab() {
    if (activeTabId) closeTab(activeTabId);
  }

  function cycleTab(dir: 1 | -1) {
    if (openTabs.length < 2 || !activeTabId) return;
    const idx = openTabs.indexOf(activeTabId);
    const next = openTabs[(idx + dir + openTabs.length) % openTabs.length];
    setActiveTabId(next);
  }

  const loadNotes = useCallback(async () => {
    try {
      const res = await fetch("/api/notes?archived=0");
      const data = await res.json();
      if (res.ok && Array.isArray(data.notes)) {
        setNotes(data.notes);
        if (data.notes.length > 0 && typeof window !== "undefined" && window.innerWidth >= 768) {
          // Desktop: abre a primeira nota como aba inicial (só no boot)
          setOpenTabs((prev) => (prev.length > 0 ? prev : [data.notes[0].id]));
          setActiveTabId((prev) => prev ?? data.notes[0].id);
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

  // Comandos de aba vindos do menu nativo do Electron (Ctrl+N/W/Tab).
  // Uma única assinatura IPC; handlers sempre-frescos via ref.
  const tabHandlersRef = useRef({
    new: () => {},
    close: () => {},
    next: () => {},
    prev: () => {},
  });
  tabHandlersRef.current = { new: handleCreateNote, close: closeActiveTab, next: () => cycleTab(1), prev: () => cycleTab(-1) };

  useEffect(() => {
    const api = (
      window as unknown as {
        notasDesktop?: { onTabCommand: (cb: (cmd: string) => void) => void };
      }
    ).notasDesktop;
    if (!api?.onTabCommand) return;
    api.onTabCommand((cmd) => {
      const handler = tabHandlersRef.current[cmd as keyof typeof tabHandlersRef.current];
      if (handler) handler();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedNote = useMemo(() => {
    if (!selectedNoteId) return null;
    return notes.find((n) => n.id === selectedNoteId) || null;
  }, [notes, selectedNoteId]);

  const tabsData = useMemo(
    () =>
      openTabs.map((id) => ({
        id,
        title: notes.find((n) => n.id === id)?.title || "",
      })),
    [openTabs, notes]
  );

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
        // Aba nova: a atual continua aberta (Ctrl+N no Electron usa isto)
        openTabNew(newNote.id);
        setIsSidebarOpen(false);
      }
    } catch (err) {
      console.error("Erro ao criar nota:", err);
      showToast("Não foi possível criar uma nova nota.", "error");
    }
  }

  async function handleUpdateNote(
    updatedFields: Partial<Note> & { skipPatch?: boolean },
    targetNoteId: string | null = selectedNoteId
  ) {
    const noteId = targetNoteId;
    if (!noteId) return;
    const { skipPatch, ...fields } = updatedFields;

    const previous = notesRef.current.find((n) => n.id === noteId);
    setNotes((prev) =>
      prev.map((n) => (n.id === noteId ? { ...n, ...fields, updated_at: Date.now() } : n))
    );

    if (skipPatch) return;

    // Nota pode ter sido excluída no meio (flush de save no unmount da aba):
    // nesse caso não patcha nem reverte
    if (!notesRef.current.some((n) => n.id === noteId)) return;

    const result = await patchNote(noteId, fields);

    // Auto-tags recalculadas no servidor (ex: "Códigos") aparecem na hora
    if (result.ok && result.tags) {
      setNotes((prev) =>
        prev.map((n) => (n.id === noteId ? { ...n, tags: result.tags } : n))
      );
    }

    if (!result.ok && previous && notesRef.current.some((n) => n.id === noteId)) {
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
    closeTab(noteId);

    const ok = await patchNote(noteId, { is_archived: nextArchive });
    if (!ok) {
      setNotes((prev) => [target, ...prev]);
      if (!notesRef.current.some((n) => n.id === noteId) || openTabs.length === 0) {
        openTabNew(target.id);
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
    closeTab(noteId);

    try {
      const res = await fetch(`/api/notes/${noteId}`, { method: "DELETE" });
      if (!res.ok && removed) {
        setNotes((prev) => [removed, ...prev]);
        openTabNew(removed.id);
      }
    } catch (err) {
      console.error("Erro ao excluir nota:", err);
      if (removed) {
        setNotes((prev) => [removed, ...prev]);
        openTabNew(removed.id);
      }
    }
  }

  function handleAddAttachment(attachment: Attachment, targetNoteId?: string | null) {
    const noteId = targetNoteId ?? selectedNoteId;
    if (!noteId) return;
    setNotes((prev) =>
      prev.map((n) => {
        if (n.id !== noteId) return n;
        const currentAtts = n.attachments || [];
        return { ...n, attachments: [...currentAtts, attachment] };
      })
    );
  }

  function handleRemoveAttachment(attachmentId: string, targetNoteId?: string | null) {
    const noteId = targetNoteId ?? selectedNoteId;
    if (!noteId) return;
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
    // Estilo browser: nota já aberta vira a aba ativa; senão abre em nova aba
    openTab(note.id);
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
        ) : (
          <>
            <TabStrip
              tabs={tabsData}
              activeId={selectedNoteId}
              onSelect={(id) => setActiveTabId(id)}
              onClose={closeTab}
            />

            <div className="flex-1 flex flex-col min-h-0">
              {/* Uma instância de editor por aba aberta — escondidas com display:none
                  preservam scroll, undo/redo e cursor de cada nota */}
              {openTabs.map((tabId) => {
                const note = notes.find((n) => n.id === tabId);
                if (!note) return null;
                const isActive = tabId === selectedNoteId;
                return (
                  <div
                    key={tabId}
                    className={isActive ? "flex-1 flex flex-col min-h-0" : "hidden"}
                  >
                    <NoteEditor
                      note={note}
                      onUpdate={(fields) => handleUpdateNote(fields, tabId)}
                      onDelete={() => handleDeleteNote(tabId)}
                      onTogglePin={() => handleTogglePin(tabId)}
                      onToggleArchive={() => handleToggleArchive(tabId)}
                      onAddAttachment={(attachment) => handleAddAttachment(attachment, tabId)}
                      onRemoveAttachment={(attachmentId) =>
                        handleRemoveAttachment(attachmentId, tabId)
                      }
                      onMenuClick={() => setIsSidebarOpen(true)}
                    />
                  </div>
                );
              })}

              {openTabs.length === 0 && (
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
            </div>
          </>
        )}
      </main>
    </div>
  );
}
