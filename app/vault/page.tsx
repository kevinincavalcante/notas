"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Header from "@/components/Header";
import NoteModal from "@/components/NoteModal";
import Sidebar from "@/components/Sidebar";
import TabStrip from "@/components/TabStrip";
import { Note } from "@/types/note";
import { useUI } from "@/components/UIProvider";
import { useVault } from "@/components/VaultProvider";
import { decryptNote, getVaultMediaUrl } from "@/lib/vault-client";
import {
  Lock,
  LockOpen,
  Loader2,
  Menu,
  Plus,
  SearchX,
  Vault,
  KeyRound,
  Unlock,
  X,
} from "lucide-react";

/**
 * Aba Cofre — área de notas criptografadas com AES-256-GCM (modelo B:
 * cifra 100% no cliente). O servidor só conhece ciphertext; a DEK fica em
 * memória enquanto o cofre está destravado (auto-lock por inatividade).
 */
export default function VaultPage() {
  const { confirm, showToast } = useUI();
  const vault = useVault();

  const [notes, setNotes] = useState<Note[]>([]); // sempre descriptografadas na UI
  const [, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  const [creating, setCreating] = useState(false);
  const [, setChangingPw] = useState(false);
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [newPw2, setNewPw2] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);

  // ---- Casca idêntica à tela inicial (UI only) -------------------------------
  // Abas estilo browser + Sidebar: NENHUMA lógica do cofre muda — o editor
  // continua sendo o NoteModal (que cifra/decifra no cliente)
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [showPwForm, setShowPwForm] = useState(false);

  // Desbloqueio direto na página
  const [unlockPw, setUnlockPw] = useState("");
  const [unlockBusy, setUnlockBusy] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);

  async function handlePageUnlock() {
    if (unlockBusy || !unlockPw) return;
    setUnlockBusy(true);
    setUnlockError(null);
    await new Promise((r) => setTimeout(r, 60));
    try {
      const ok = await vault.unlock(unlockPw);
      if (!ok) {
        setUnlockError("Senha incorreta.");
      } else {
        setUnlockPw("");
      }
    } finally {
      setUnlockBusy(false);
    }
  }

  async function handleResetVaultPrompt() {
    const ok = await confirm({
      title: "Redefinir cofre",
      message: "Isso apagará todas as notas do cofre e permitirá cadastrar uma nova senha. Deseja continuar?",
      confirmText: "Redefinir",
      variant: "danger",
    });
    if (!ok) return;
    const resetOk = await vault.resetVault();
    if (resetOk) {
      setUnlockPw("");
      setUnlockError(null);
    }
  }

  // ---- Navegação estilo tela inicial (abas + modal) --------------------------
  // Abrir nota = aba nova + modal do editor seguro. Fechar o modal mantém a
  // aba (igual ao editor da tela inicial); fechar a aba ativa ativa a vizinha.
  const activeNote = useMemo(
    () => (activeTabId ? notes.find((n) => n.id === activeTabId) || null : null),
    [notes, activeTabId]
  );

  function openNote(note: Note) {
    setSelectedNote(note);
    setIsSidebarOpen(false);
    setOpenTabs((prev) => (prev.includes(note.id) ? prev : [...prev, note.id]));
    setActiveTabId(note.id);
  }

  function selectTab(id: string) {
    const n = notes.find((item) => item.id === id);
    if (!n) return;
    setActiveTabId(id);
    setSelectedNote(n);
  }

  function closeTab(tabId: string) {
    if (!openTabs.includes(tabId)) return;
    const idx = openTabs.indexOf(tabId);
    const rest = openTabs.filter((t) => t !== tabId);
    setOpenTabs(rest);
    if (activeTabId === tabId) {
      const next = rest.length > 0 ? rest[Math.min(idx, rest.length - 1)] : null;
      setActiveTabId(next);
      setSelectedNote(next ? notes.find((n) => n.id === next) || null : null);
    }
  }

  const tabsData = useMemo(
    () =>
      openTabs
        // abas de notas que deixaram de existir (exclusão/sync) somem da faixa
        .filter((id) => notes.some((n) => n.id === id))
        .map((id) => {
          const n = notes.find((item) => item.id === id);
          return { id, title: n?.title || "", color: n?.color };
        }),
    [openTabs, notes]
  );

  /** Fecha a aba da nota removida/excluída e ativa a vizinha (UI only). */
  function closeTabForRemoved(noteId: string) {
    if (!openTabs.includes(noteId)) return;
    const idx = openTabs.indexOf(noteId);
    const rest = openTabs.filter((t) => t !== noteId);
    setOpenTabs(rest);
    if (activeTabId === noteId) {
      const next = rest.length > 0 ? rest[Math.min(idx, rest.length - 1)] : null;
      setActiveTabId(next);
      setSelectedNote(next ? notes.find((n) => n.id === next) || null : null);
    }
  }

  // blob URLs das mídias dos cards (imagens/áudio cifrados)
  const [cardMedia, setCardMedia] = useState<Record<string, string>>({});
  const mediaNonce = useRef(0);

  const loadNotes = useCallback(async (): Promise<Note[]> => {
    if (!vault.dek) {
      setNotes([]);
      setCardMedia({});
      return [];
    }
    setLoading(true);
    try {
      // Traz ativas E arquivadas do cofre (a listagem normal do app nunca
      // mostra notas do cofre — elas só existem aqui, destravadas)
      const [activeRes, archivedRes] = await Promise.all([
        fetch("/api/notes?vault=1&archived=0"),
        fetch("/api/notes?vault=1&archived=1"),
      ]);
      const [activeData, archivedData] = await Promise.all([
        activeRes.json().catch(() => ({ notes: [] })),
        archivedRes.json().catch(() => ({ notes: [] })),
      ]);
      if (activeRes.ok && archivedRes.ok) {
        const cipher = [...(activeData.notes || []), ...(archivedData.notes || [])];
        const plain = cipher.map((n: Note) => decryptNote(vault.dek!, n));
        setNotes(plain);
        return plain;
      }
      return [];
    } catch (err) {
      console.error("Erro ao carregar notas do cofre:", err);
      return [];
    } finally {
      setLoading(false);
    }
  }, [vault.dek]);

  useEffect(() => {
    if (vault.status === "unlocked") void loadNotes();
  }, [vault.status, loadNotes]);

  // Media dos cards: descriptografa em série e guarda blob URLs
  useEffect(() => {
    if (!vault.dek) {
      setCardMedia({});
      return;
    }
    const myNonce = ++mediaNonce.current;
    (async () => {
      const map: Record<string, string> = {};
      for (const note of notes) {
        for (const att of note.attachments || []) {
          if (!att.id || map[att.id]) continue;
          const url = await getVaultMediaUrl(vault.dek!, att.id, att.mime_type);
          if (url) map[att.id] = url;
        }
      }
      if (mediaNonce.current === myNonce) setCardMedia(map);
    })();
  }, [notes, vault.dek]);

  const filteredNotes = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return notes;
    // Busca do cofre é 100% client-side (o índice FTS5 nunca vê plaintext)
    return notes.filter(
      (n) =>
        n.title.toLowerCase().includes(q) ||
        n.body.toLowerCase().includes(q)
    );
  }, [notes, searchQuery]);

  async function handleCreateNote() {
    if (creating || !vault.dek) return;
    setCreating(true);
    try {
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: vault.encryptString(""),
          body: vault.encryptString(""),
          color: "default",
          is_vault: true,
        }),
      });
      const data = await res.json();
      if (res.ok && data.note) {
        const plain = decryptNote(vault.dek, data.note);
        setNotes((prev) => [plain, ...prev]);
        openNote(plain);
      } else {
        showToast("Falha ao criar nota no cofre.", "error");
      }
    } catch (err) {
      console.error("Erro ao criar nota no cofre:", err);
      showToast("Erro ao criar nota no cofre.", "error");
    } finally {
      setCreating(false);
    }
  }

  async function handleUpdateNote(
    updatedFields: Partial<Note> & { skipPatch?: boolean },
    targetNoteId?: string | null
  ) {
    const noteId = targetNoteId || selectedNote?.id;
    if (!noteId) return;
    const { skipPatch, ...fields } = updatedFields;

    setNotes((prev) =>
      prev.map((n) => (n.id === noteId ? { ...n, ...fields, updated_at: Date.now() } : n))
    );
    if (selectedNote?.id === noteId) {
      setSelectedNote((n) => (n ? { ...n, ...fields } : n));
    }

    if (skipPatch || !vault.dek) return;

    // Campos de texto vão cifrados; flags ficam em claro (são só metadata)
    const payload: Record<string, unknown> = {};
    if (typeof fields.title === "string") payload.title = vault.encryptString(fields.title);
    if (typeof fields.body === "string") payload.body = vault.encryptString(fields.body);
    if ("is_pinned" in fields) payload.is_pinned = fields.is_pinned;
    if ("is_archived" in fields) payload.is_archived = fields.is_archived;
    if ("color" in fields) payload.color = fields.color;
    if (Object.keys(payload).length === 0) return;

    await fetch(`/api/notes/${noteId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  async function handleDeleteNote(noteId: string) {
    const confirmed = await confirm({
      title: "Excluir nota do cofre",
      message: "Deseja realmente excluir esta nota? Anexos e histórico também serão removidos.",
      confirmText: "Excluir",
      variant: "danger",
    });
    if (!confirmed) return;

    setNotes((prev) => prev.filter((n) => n.id !== noteId));
    closeTabForRemoved(noteId);
    await fetch(`/api/notes/${noteId}`, { method: "DELETE" });
    showToast("Nota excluída.", "info");
  }

  /** Tira a nota do cofre: descriptografa tudo e volta pra listagem normal. */
  async function handleRemoveFromVault(noteId: string) {
    if (!vault.dek) return;
    const confirmed = await confirm({
      title: "Remover do cofre",
      message:
        "A nota (texto, anexos e histórico) voltará a ficar em texto normal em todos os dispositivos. Continuar?",
      confirmText: "Remover do cofre",
    });
    if (!confirmed) return;

    const { removeNoteFromVault } = await import("@/lib/vault-client");
    const removed = await removeNoteFromVault(vault.dek, noteId);
    if (removed) {
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
      closeTabForRemoved(noteId);
      showToast("Nota movida para suas notas normais.", "success");
    } else {
      showToast("Falha ao remover a nota do cofre.", "error");
    }
  }

  async function handleChangePassword() {
    setPwError(null);
    if (newPw.length < 4) {
      setPwError("A nova senha precisa de pelo menos 4 caracteres.");
      return;
    }
    if (newPw !== newPw2) {
      setPwError("As senhas não conferem.");
      return;
    }
    setChangingPw(true);
    const ok = await vault.changePassword(currentPw, newPw);
    setChangingPw(false);
    if (ok) {
      setCurrentPw("");
      setNewPw("");
      setNewPw2("");
    } else {
      setPwError("Senha atual incorreta (ou falha de conexão).");
    }
  }

  // ---- Estados de bloqueio --------------------------------------------------

  if (vault.status === "loading") {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col">
        <Header searchQuery="" onSearchChange={() => {}} />
        <div className="flex-1 flex items-center justify-center text-slate-400">
          <Loader2 className="w-6 h-6 animate-spin" />
        </div>
      </div>
    );
  }

  if (vault.status !== "unlocked") {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col">
        <Header searchQuery="" onSearchChange={() => {}} />
        <div className="flex-1 flex flex-col items-center justify-center p-6 text-center select-none">
          <div className="w-16 h-16 bg-amber-400/10 text-amber-500 rounded-2xl flex items-center justify-center mb-4 shadow-xs border border-amber-400/20">
            <Lock className="w-8 h-8" />
          </div>
          <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-1">Cofre</h2>
          <p className="text-sm text-slate-600 dark:text-slate-400 max-w-sm mb-6 leading-relaxed">
            Digite a senha
          </p>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handlePageUnlock();
            }}
            className="w-full max-w-xs space-y-3"
          >
            <input
              type="password"
              autoFocus
              value={unlockPw}
              onChange={(e) => setUnlockPw(e.target.value)}
              placeholder="Digite a senha"
              className="w-full px-4 py-2.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl text-sm text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-amber-400/60"
            />
            {unlockError && (
              <div className="space-y-1.5 text-left">
                <p className="text-xs text-red-600 dark:text-red-400">{unlockError}</p>
                <button
                  type="button"
                  onClick={() => void handleResetVaultPrompt()}
                  className="text-xs text-red-500 hover:text-red-600 hover:underline cursor-pointer block"
                >
                  Esqueceu a senha? Redefinir cofre
                </button>
              </div>
            )}
            <button
              type="submit"
              disabled={unlockBusy || !unlockPw}
              className="w-full flex items-center justify-center gap-2 py-2.5 bg-amber-400 hover:bg-amber-300 active:bg-amber-500 text-slate-950 font-semibold text-sm rounded-xl transition shadow-xs disabled:opacity-60 cursor-pointer"
            >
              {unlockBusy ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Unlock className="w-4 h-4" />
              )}
              {unlockBusy ? "Abrindo cofre…" : "Abrir cofre"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // ---- Destravado ------------------------------------------------------------
  // Casca idêntica à tela inicial: Sidebar + abas estilo browser. A lógica do
  // cofre (unlock, cifração, mídia, modal) é exatamente a mesma de antes —
  // o editor continua sendo o NoteModal, que cifra/decifra no cliente.

  return (
    <div className="h-dvh w-full flex overflow-hidden bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      <Sidebar
        notes={filteredNotes}
        selectedNoteId={activeTabId}
        onSelectNote={openNote}
        onCreateNote={() => void handleCreateNote()}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        isOpen={isSidebarOpen}
        onClose={() => setIsSidebarOpen(false)}
        activeTagFilter={null}
        onTagFilter={() => {}}
        onTogglePin={(noteId) => {
          const target = notes.find((n) => n.id === noteId);
          if (target) void handleUpdateNote({ is_pinned: !target.is_pinned }, noteId);
        }}
        onToggleArchive={(noteId) => {
          const target = notes.find((n) => n.id === noteId);
          if (target) void handleUpdateNote({ is_archived: !target.is_archived }, noteId);
        }}
        onDeleteNote={(noteId) => void handleDeleteNote(noteId)}
        onRemoveFromVault={(noteId) => void handleRemoveFromVault(noteId)}
      />

      <main className="flex-1 h-full flex flex-col min-w-0 overflow-hidden">
        {/* Barra do cofre: ações próprias no padrão visual do app */}
        <div className="shrink-0 relative flex items-center justify-between gap-2 px-3 sm:px-4 py-2 bg-white/60 dark:bg-slate-900/40 border-b border-black/5 dark:border-white/5">
          <div className="flex items-center gap-2.5 min-w-0">
            <button
              type="button"
              onClick={() => setIsSidebarOpen(true)}
              className="p-1.5 text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white rounded-lg transition md:hidden"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="w-7 h-7 bg-amber-400/15 text-amber-500 border border-amber-400/20 rounded-lg flex items-center justify-center shrink-0">
              <Vault className="w-4 h-4" />
            </div>
            <span className="font-bold text-sm shrink-0">Cofre</span>
            <span className="hidden sm:inline text-[11px] text-slate-500 dark:text-slate-400 truncate">
              criptografado no dispositivo (AES-256-GCM)
            </span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => setShowPwForm((v) => !v)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:bg-black/5 dark:hover:bg-white/5 rounded-lg transition"
            >
              <KeyRound className="w-3.5 h-3.5 text-amber-500" />
              <span className="hidden sm:inline">Alterar senha</span>
            </button>
            <button
              type="button"
              onClick={() => vault.lock()}
              title="Travar o cofre agora"
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:bg-black/5 dark:hover:bg-white/5 rounded-lg transition"
            >
              <LockOpen className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Travar</span>
            </button>
            <button
              type="button"
              onClick={() => void handleCreateNote()}
              disabled={creating}
              className="flex items-center gap-1.5 px-2.5 py-1.5 bg-amber-400 hover:bg-amber-300 active:bg-amber-500 text-slate-950 font-semibold text-[11px] rounded-lg transition shadow-xs disabled:opacity-60"
            >
              {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
              Nova nota segura
            </button>
          </div>

          {/* Troca de senha: dropdown no padrão do app */}
          {showPwForm && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setShowPwForm(false)} aria-hidden="true" />
              <div className="absolute right-3 top-full mt-1 w-72 z-30 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xl p-3 space-y-2 animate-in fade-in zoom-in-95 duration-100">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
                    <KeyRound className="w-3.5 h-3.5 text-amber-500" />
                    Alterar senha do cofre
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowPwForm(false)}
                    className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                <input
                  type="password"
                  placeholder="Senha atual"
                  value={currentPw}
                  onChange={(e) => setCurrentPw(e.target.value)}
                  className="px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-400/60"
                />
                <input
                  type="password"
                  placeholder="Nova senha (mínimo 4 caracteres)"
                  value={newPw}
                  onChange={(e) => setNewPw(e.target.value)}
                  className="px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-400/60"
                />
                <input
                  type="password"
                  placeholder="Repetir nova senha"
                  value={newPw2}
                  onChange={(e) => setNewPw2(e.target.value)}
                  className="px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-400/60"
                />
                {pwError && <p className="text-xs text-red-600 dark:text-red-400">{pwError}</p>}
                <button
                  type="button"
                  onClick={() => void handleChangePassword()}
                  className="px-3 py-1.5 bg-amber-400 hover:bg-amber-300 text-slate-950 font-semibold text-xs rounded-lg transition w-fit"
                >
                  Salvar nova senha
                </button>
              </div>
            </>
          )}
        </div>

        <TabStrip
          tabs={tabsData}
          activeId={activeTabId}
          onSelect={selectTab}
          onClose={closeTab}
          onNew={() => void handleCreateNote()}
        />

        <div className="flex-1 flex flex-col min-h-0">
          {/* Uma instância de editor por aba — escondidas com display:none
              preservam scroll e cursor (mesmo padrão da tela inicial) */}
          {openTabs.map((tabId) => {
            const tabNote = notes.find((n) => n.id === tabId);
            if (!tabNote) return null;
            const isActive = tabId === activeTabId;
            return (
              <div key={tabId} className={isActive ? "flex-1 flex flex-col min-h-0" : "hidden"}>
                <NoteModal
                  inline
                  note={tabNote}
                  isOpen={true}
                  attachmentSrcMap={cardMedia}
                  onClose={() => closeTab(tabId)}
                  onUpdate={handleUpdateNote}
                  onDelete={() => handleDeleteNote(tabNote.id)}
                  onAddAttachment={(att) => {
                    setNotes((prev) =>
                      prev.map((n) =>
                        n.id === tabNote.id
                          ? { ...n, attachments: [...(n.attachments || []), att] }
                          : n
                      )
                    );
                    if (selectedNote?.id === tabNote.id) {
                      setSelectedNote((prev) =>
                        prev ? { ...prev, attachments: [...(prev.attachments || []), att] } : null
                      );
                    }
                  }}
                  onRemoveAttachment={(attId) => {
                    setNotes((prev) =>
                      prev.map((n) =>
                        n.id === tabNote.id
                          ? { ...n, attachments: (n.attachments || []).filter((a) => a.id !== attId) }
                          : n
                      )
                    );
                    if (selectedNote?.id === tabNote.id) {
                      setSelectedNote((prev) =>
                        prev
                          ? { ...prev, attachments: (prev.attachments || []).filter((a) => a.id !== attId) }
                          : null
                      );
                    }
                  }}
                  onAfterAttachmentChange={() => void loadNotes()}
                />
              </div>
            );
          })}

          {openTabs.length === 0 && (
            /* Nada aberto — mesmo padrão do estado vazio da tela inicial */
            <div className="flex-1 flex flex-col items-center justify-center p-6 text-center select-none">
              <div className="w-16 h-16 bg-amber-400/10 text-amber-500 rounded-2xl flex items-center justify-center mb-4 shadow-xs border border-amber-400/20">
                <Vault className="w-8 h-8" />
              </div>
              {searchQuery.trim() ? (
                <>
                  <h2 className="text-lg font-semibold text-slate-900 dark:text-white mb-1">
                    Nenhuma nota encontrada
                  </h2>
                  <p className="text-sm text-slate-600 dark:text-slate-400 max-w-sm mb-2 leading-relaxed">
                    Nada no cofre para &ldquo;{searchQuery}&rdquo;.
                  </p>
                  <SearchX className="w-6 h-6 text-slate-300 dark:text-slate-600" />
                </>
              ) : notes.length === 0 ? (
                <>
                  <h2 className="text-lg font-semibold text-slate-900 dark:text-white mb-1">
                    Seu cofre está vazio
                  </h2>
                  <p className="text-sm text-slate-600 dark:text-slate-400 max-w-sm mb-6 leading-relaxed">
                    Crie a primeira nota segura — ela será criptografada no seu dispositivo antes de sair dele.
                  </p>
                  <button
                    type="button"
                    onClick={() => void handleCreateNote()}
                    className="flex items-center gap-2 px-4 py-2 bg-amber-400 hover:bg-amber-300 active:bg-amber-500 text-slate-950 font-semibold text-sm rounded-xl transition shadow-xs active:scale-95"
                  >
                    <Plus className="w-4 h-4" />
                    Nova nota segura
                  </button>
                </>
              ) : (
                <>
                  <h2 className="text-lg font-semibold text-slate-900 dark:text-white mb-1">
                    Nenhuma nota aberta
                  </h2>
                  <p className="text-sm text-slate-600 dark:text-slate-400 max-w-sm leading-relaxed">
                    Selecione uma nota na lista lateral para abrir o editor seguro.
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
