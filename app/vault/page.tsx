"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Header from "@/components/Header";
import NoteCard from "@/components/NoteCard";
import NoteModal from "@/components/NoteModal";
import { Note } from "@/types/note";
import { useUI } from "@/components/UIProvider";
import { useVault } from "@/components/VaultProvider";
import { decryptNote, getVaultMediaUrl } from "@/lib/vault-client";
import {
  Lock,
  LockOpen,
  Loader2,
  Plus,
  SearchX,
  Vault,
  KeyRound,
  Unlock,
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
        setSelectedNote(plain);
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

  async function handleUpdateNote(updatedFields: Partial<Note> & { skipPatch?: boolean }) {
    if (!selectedNote) return;
    const noteId = selectedNote.id;
    const { skipPatch, ...fields } = updatedFields;

    setNotes((prev) =>
      prev.map((n) => (n.id === noteId ? { ...n, ...fields, updated_at: Date.now() } : n))
    );
    if (selectedNote.id === noteId) {
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
    if (selectedNote?.id === noteId) setSelectedNote(null);
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
      if (selectedNote?.id === noteId) setSelectedNote(null);
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

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col">
      <Header searchQuery={searchQuery} onSearchChange={setSearchQuery} />

      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 text-slate-700 dark:text-slate-300 flex-1 min-w-0">
            <Vault className="w-5 h-5 text-amber-500" />
            <h1 className="text-xl font-bold">Cofre</h1>
            <span className="text-xs text-slate-500 dark:text-slate-400 hidden sm:inline">
              criptografado no dispositivo (AES-256-GCM)
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleCreateNote()}
              disabled={creating}
              className="flex items-center gap-2 px-3 py-1.5 bg-amber-400 hover:bg-amber-300 active:bg-amber-500 text-slate-950 font-semibold text-xs rounded-xl transition shadow-xs disabled:opacity-60"
            >
              {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
              Nova nota segura
            </button>
            <button
              type="button"
              onClick={() => vault.lock()}
              className="flex items-center gap-2 px-3 py-1.5 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 font-medium text-xs rounded-xl border border-slate-200 dark:border-slate-700 transition"
              title="Travar o cofre agora"
            >
              <LockOpen className="w-3.5 h-3.5" />
              Travar
            </button>
          </div>
        </div>

        {/* Troca de senha (opcional, retrátil) */}
        <details className="mb-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl px-4 py-3">
          <summary className="text-xs font-semibold text-slate-600 dark:text-slate-400 cursor-pointer select-none flex items-center gap-2">
            <KeyRound className="w-3.5 h-3.5 text-amber-500" />
            Alterar senha do cofre
          </summary>
          <div className="mt-3 grid gap-2 max-w-md">
            <input
              type="password"
              placeholder="Senha atual"
              value={currentPw}
              onChange={(e) => setCurrentPw(e.target.value)}
              className="px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-xs text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-400/60"
            />
            <input
              type="password"
              placeholder="Nova senha (mínimo 4 caracteres)"
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
              className="px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-xs text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-400/60"
            />
            <input
              type="password"
              placeholder="Repetir nova senha"
              value={newPw2}
              onChange={(e) => setNewPw2(e.target.value)}
              className="px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-xs text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-400/60"
            />
            {pwError && <p className="text-xs text-red-600 dark:text-red-400">{pwError}</p>}
            <button
              type="button"
              onClick={() => void handleChangePassword()}
              className="px-3 py-1.5 bg-amber-400 hover:bg-amber-300 text-slate-950 font-semibold text-xs rounded-xl transition w-fit"
            >
              Salvar nova senha
            </button>
          </div>
        </details>

        {filteredNotes.length === 0 ? (
          <div className="text-center py-16 text-slate-400 select-none">
            {searchQuery ? (
              <div className="flex flex-col items-center gap-2">
                <SearchX className="w-8 h-8 opacity-40" />
                <p className="text-sm">Nenhuma nota encontrada no cofre para &ldquo;{searchQuery}&rdquo;</p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3">
                <Vault className="w-10 h-10 opacity-30 text-amber-500" />
                <p className="text-sm">Seu cofre está vazio.</p>
                <button
                  type="button"
                  onClick={() => void handleCreateNote()}
                  className="px-3 py-1.5 bg-amber-400 hover:bg-amber-300 text-slate-950 font-semibold text-xs rounded-xl transition"
                >
                  Criar primeira nota segura
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="columns-1 sm:columns-2 lg:columns-3 xl:columns-4 gap-4 space-y-4">
            {filteredNotes.map((note) => (
              <div key={note.id} className="break-inside-avoid">
                <NoteCard
                  note={note}
                  onClick={() => setSelectedNote(note)}
                  onTogglePin={(e) => {
                    e.stopPropagation();
                    void handleUpdateNote({ is_pinned: !note.is_pinned });
                  }}
                  onToggleArchive={(e) => {
                    e.stopPropagation();
                    void handleUpdateNote({ is_archived: !note.is_archived });
                  }}
                  onDelete={(e) => {
                    e.stopPropagation();
                    void handleDeleteNote(note.id);
                  }}
                  onChangeColor={(color) => {
                    void handleUpdateNote({ color });
                  }}
                  attachmentSrcMap={cardMedia}
                />
              </div>
            ))}
          </div>
        )}
      </main>

      {selectedNote && (
        <NoteModal
          note={selectedNote}
          isOpen={true}
          attachmentSrcMap={cardMedia}
          onClose={() => setSelectedNote(null)}
          onUpdate={handleUpdateNote}
          onDelete={() => handleDeleteNote(selectedNote.id)}
          onAddAttachment={(att) => {
            setSelectedNote((prev) =>
              prev ? { ...prev, attachments: [...(prev.attachments || []), att] } : null
            );
            setNotes((prev) =>
              prev.map((n) =>
                n.id === selectedNote.id
                  ? { ...n, attachments: [...(n.attachments || []), att] }
                  : n
              )
            );
          }}
          onRemoveAttachment={(attId) => {
            setSelectedNote((prev) =>
              prev ? { ...prev, attachments: (prev.attachments || []).filter((a) => a.id !== attId) } : null
            );
            setNotes((prev) =>
              prev.map((n) =>
                n.id === selectedNote.id
                  ? { ...n, attachments: (n.attachments || []).filter((a) => a.id !== attId) }
                  : n
              )
            );
          }}
          onAfterAttachmentChange={() => void loadNotes()}
        />
      )}
    </div>
  );
}
