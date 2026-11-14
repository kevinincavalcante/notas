"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Header from "@/components/Header";
import NoteCard from "@/components/NoteCard";
import NoteModal from "@/components/NoteModal";
import { Note, Attachment } from "@/types/note";
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
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  const [creating, setCreating] = useState(false);
  const [changingPw, setChangingPw] = useState(false);
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [newPw2, setNewPw2] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [busyNoteId, setBusyNoteId] = useState<string | null>(null);

  // blob URLs das mídias dos cards (imagens/áudio cifrados)
  const [cardMedia, setCardMedia] = useState<Record<string, string>>({});
  const mediaNonce = useRef(0);

  const loadNotes = useCallback(async () => {
    if (!vault.dek) {
      setNotes([]);
      setCardMedia({});
      return;
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
        setNotes(cipher.map((n: Note) => decryptNote(vault.dek!, n)));
      }
    } catch (err) {
      console.error("Erro ao carregar notas do cofre:", err);
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

    setBusyNoteId(noteId);
    const { removeNoteFromVault } = await import("@/lib/vault-client");
    const removed = await removeNoteFromVault(vault.dek, noteId);
    setBusyNoteId(null);
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
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white mb-1">Cofre travado</h2>
          <p className="text-sm text-slate-600 dark:text-slate-400 max-w-sm mb-6 leading-relaxed">
            {vault.status === "no-vault"
              ? "Nenhuma senha cadastrada ainda. Crie a senha do cofre para começar."
              : "Suas notas criptografadas ficam invisíveis até você destravar."}
          </p>
          <button
            type="button"
            onClick={() => void vault.ensureUnlocked()}
            className="flex items-center gap-2 px-4 py-2 bg-amber-400 hover:bg-amber-300 active:bg-amber-500 text-slate-950 font-semibold text-sm rounded-xl transition shadow-xs active:scale-95"
          >
            <Unlock className="w-4 h-4" />
            {vault.status === "no-vault" ? "Criar senha do cofre" : "Destravar cofre"}
          </button>
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
              value={currentPw}
              onChange={(e) => setCurrentPw(e.target.value)}
              placeholder="Senha atual"
              className="px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-400/60"
            />
            <input
              type="password"
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
              placeholder="Nova senha"
              className="px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-400/60"
            />
            <input
              type="password"
              value={newPw2}
              onChange={(e) => setNewPw2(e.target.value)}
              placeholder="Repita a nova senha"
              className="px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-400/60"
            />
            {pwError && <p className="text-xs text-red-600 dark:text-red-400">{pwError}</p>}
            <button
              type="button"
              onClick={() => void handleChangePassword()}
              disabled={changingPw}
              className="justify-self-start px-4 py-2 bg-slate-900 hover:bg-slate-800 dark:bg-white dark:hover:bg-slate-100 text-white dark:text-slate-900 rounded-lg font-semibold text-xs transition disabled:opacity-60"
            >
              {changingPw ? "Alterando…" : "Alterar senha"}
            </button>
            <p className="text-[11px] text-slate-500 dark:text-slate-500">
              A chave de criptografia é a mesma — nada é re-criptografado, apenas a senha que a protege.
            </p>
          </div>
        </details>

        {loading ? (
          <div className="flex justify-center items-center py-20 text-slate-400">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span className="ml-2 text-sm">Descriptografando notas…</span>
          </div>
        ) : filteredNotes.length === 0 ? (
          <div className="text-center py-24 text-slate-400 flex flex-col items-center gap-3">
            {searchQuery ? (
              <>
                <SearchX className="w-12 h-12 text-slate-300 dark:text-slate-700" />
                <p className="text-sm">Nada no cofre com &quot;{searchQuery}&quot;.</p>
              </>
            ) : (
              <>
                <Vault className="w-14 h-14 text-slate-300 dark:text-slate-700" />
                <p className="text-base font-medium text-slate-500 dark:text-slate-400">Cofre vazio.</p>
                <p className="text-xs text-slate-400">
                  Notas criadas aqui ficam criptografadas no servidor e em todos os dispositivos.
                </p>
              </>
            )}
          </div>
        ) : (
          <div className="columns-1 sm:columns-2 md:columns-3 lg:columns-4 gap-4 space-y-4">
            {filteredNotes.map((note) => (
              <div key={note.id} className="break-inside-avoid relative group">
                <NoteCard
                  note={note}
                  attachmentSrcMap={cardMedia}
                  onClick={() => setSelectedNote(note)}
                  onTogglePin={() => {}}
                  onToggleArchive={() => {}}
                  onDelete={() => void handleDeleteNote(note.id)}
                  onChangeColor={(color) => void handleUpdateNote({ color })}
                />
                <button
                  type="button"
                  title="Remover do cofre (descriptografar)"
                  onClick={() => void handleRemoveFromVault(note.id)}
                  disabled={busyNoteId === note.id}
                  className="absolute bottom-3 right-3 z-10 p-2 rounded-xl bg-white/80 dark:bg-slate-800/80 text-slate-500 hover:text-amber-600 dark:hover:text-amber-400 border border-black/5 dark:border-white/10 opacity-0 group-hover:opacity-100 hover:opacity-100 focus:opacity-100 transition shadow-xs disabled:opacity-50"
                  style={{ pointerEvents: "auto" }}
                >
                  {busyNoteId === note.id ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Unlock className="w-3.5 h-3.5" />
                  )}
                </button>
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
          onAddAttachment={(attachment: Attachment) => {
            setNotes((prev) =>
              prev.map((n) =>
                n.id === selectedNote.id
                  ? { ...n, attachments: [...(n.attachments || []), attachment] }
                  : n
              )
            );
            setSelectedNote((n) =>
              n ? { ...n, attachments: [...(n.attachments || []), attachment] } : n
            );
          }}
          onRemoveAttachment={(attachmentId: string) => {
            setNotes((prev) =>
              prev.map((n) =>
                n.id === selectedNote.id
                  ? {
                      ...n,
                      attachments: (n.attachments || []).filter((a) => a.id !== attachmentId),
                    }
                  : n
              )
            );
            setSelectedNote((n) =>
              n ? { ...n, attachments: (n.attachments || []).filter((a) => a.id !== attachmentId) } : n
            );
          }}
          onAfterAttachmentChange={() => void loadNotes()}
        />
      )}
    </div>
  );
}
