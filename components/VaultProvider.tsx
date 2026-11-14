"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Lock, X, KeyRound, Loader2 } from "lucide-react";
import {
  DEFAULT_ITERATIONS,
  createVaultMaterialAsync,
  deriveKekAsync,
  rewrapDekAsync,
  base64ToBytes,
  decryptBytes,
  decryptString,
  encryptBytes,
  encryptString,
  openVaultMaterialAsync,
} from "@/lib/vault-crypto";
import { clearVaultMediaCache } from "@/lib/vault-client";
import { useUI } from "@/components/UIProvider";

/**
 * Estado global do cofre (modelo B — criptografia 100% no cliente):
 *
 *   - A senha nunca sai do dispositivo: vira KEK via PBKDF2 e a DEK fica
 *     SOMENTE em memória enquanto o cofre está destravado.
 *   - vault_meta (salt + DEK embrulhada) vem de /api/vault e sincroniza —
 *     qualquer dispositivo destrava digitando a mesma senha.
 *   - Auto-lock por inatividade: limpa a DEK da memória (web incluída —
 *     refresh da página já perde a chave de qualquer jeito).
 */

export type VaultStatus = "loading" | "no-vault" | "locked" | "unlocked";

interface VaultMeta {
  id: string;
  salt: string;
  iterations: number;
  kdf: string;
  wrapped_dek: string;
  updated_at: number;
}

interface VaultContextValue {
  status: VaultStatus;
  /** DEK em memória — só existe com status "unlocked". */
  dek: Uint8Array | null;
  busy: boolean;
  /** Abre o modal de destravamento e resolve true se ficou destravado. */
  ensureUnlocked: () => Promise<boolean>;
  unlock: (password: string) => Promise<boolean>;
  setup: (password: string) => Promise<boolean>;
  lock: () => void;
  changePassword: (current: string, next: string) => Promise<boolean>;
  /** Helpers de cifra — só chamáveis destravado (lançam erro se não). */
  encryptString: (s: string) => string;
  decryptString: (s: string) => string;
  encryptBytes: (b: Uint8Array) => Uint8Array;
  decryptBytes: (b: Uint8Array) => Uint8Array;
}

const VaultContext = createContext<VaultContextValue | null>(null);

export function useVault(): VaultContextValue {
  const ctx = useContext(VaultContext);
  if (!ctx) throw new Error("useVault fora do VaultProvider");
  return ctx;
}

const AUTO_LOCK_MS = 10 * 60 * 1000;

export default function VaultProvider({ children }: { children: React.ReactNode }) {
  const { showToast } = useUI();
  const [status, setStatus] = useState<VaultStatus>("loading");
  const [dek, setDek] = useState<Uint8Array | null>(null);
  const [meta, setMeta] = useState<VaultMeta | null>(null);
  const [busy] = useState(false);

  // Modal de destravamento (usado por ensureUnlocked quando chamado fora de /vault)
  const [modalOpen, setModalOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [modalError, setModalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const modalResolveRef = useRef<((ok: boolean) => void) | null>(null);

  const loadMeta = useCallback(async (): Promise<VaultMeta | null> => {
    try {
      const res = await fetch("/api/vault");
      const data = await res.json();
      if (res.ok && data.vault_meta) {
        setMeta(data.vault_meta as VaultMeta);
        return data.vault_meta as VaultMeta;
      }
      setMeta(null);
      return null;
    } catch {
      return null;
    }
  }, []);

  const refresh = useCallback(async () => {
    const m = await loadMeta();
    setStatus((prev) => (prev === "unlocked" ? "unlocked" : m ? "locked" : "no-vault"));
  }, [loadMeta]);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Auto-lock: inatividade zera a DEK da memória -------------------------
  const lockRef = useRef<() => void>(() => {});
  lockRef.current = () => {
    setDek(null);
    setStatus((prev) => (prev === "unlocked" ? (meta ? "locked" : "no-vault") : prev));
    clearVaultMediaCache();
  };

  useEffect(() => {
    if (status !== "unlocked") return;
    let timer = setTimeout(() => lockRef.current(), AUTO_LOCK_MS);
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => lockRef.current(), AUTO_LOCK_MS);
    };
    const events: (keyof WindowEventMap)[] = ["pointerdown", "keydown", "scroll"];
    for (const ev of events) window.addEventListener(ev, reset, { passive: true });
    return () => {
      clearTimeout(timer);
      for (const ev of events) window.removeEventListener(ev, reset);
    };
  }, [status]);

  // --- Ações ----------------------------------------------------------------

  const setup = useCallback(
    async (pw: string): Promise<boolean> => {
      const material = await createVaultMaterialAsync(pw, DEFAULT_ITERATIONS);
      const now = Date.now();
      try {
        const res = await fetch("/api/vault", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            salt: material.salt,
            iterations: material.iterations,
            kdf: material.kdf,
            wrapped_dek: material.wrapped_dek,
            updated_at: now,
          }),
        });
        if (!res.ok) {
          if (res.status === 409) {
            showToast("O cofre já foi configurado em outro dispositivo — destrave com a senha dele.", "error");
            await loadMeta();
            return false;
          }
          showToast("Falha ao criar o cofre.", "error");
          return false;
        }
      } catch {
        showToast("Sem conexão para criar o cofre.", "error");
        return false;
      }
      const newMeta: VaultMeta = {
        id: "default",
        salt: material.salt,
        iterations: material.iterations,
        kdf: material.kdf,
        wrapped_dek: material.wrapped_dek,
        updated_at: now,
      };
      setMeta(newMeta);
      setDek(material.dek);
      setStatus("unlocked");
      return true;
    },
    [showToast, loadMeta]
  );

  const doUnlock = useCallback(
    async (pw: string, m: VaultMeta | null): Promise<boolean> => {
      if (!m) return false;
      const opened = await openVaultMaterialAsync(pw, m);
      if (!opened) return false;
      setDek(opened.dek);
      setMeta(m);
      setStatus("unlocked");
      return true;
    },
    []
  );

  const unlock = useCallback(
    async (pw: string): Promise<boolean> => {
      const m = meta || (await loadMeta());
      if (!m) {
        return setup(pw);
      }
      return doUnlock(pw, m);
    },
    [meta, loadMeta, doUnlock, setup]
  );

  const lock = useCallback(() => {
    lockRef.current();
  }, []);

  const changePassword = useCallback(
    async (current: string, next: string): Promise<boolean> => {
      if (!dek || !meta) return false;
      try {
        const opened = await openVaultMaterialAsync(current, meta);
        if (!opened) return false;
      } catch {
        return false;
      }
      const rewrapped = await rewrapDekAsync(dek, next, DEFAULT_ITERATIONS);
      const now = Date.now();
      try {
        const res = await fetch("/api/vault", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            salt: rewrapped.salt,
            iterations: rewrapped.iterations,
            kdf: meta.kdf,
            wrapped_dek: rewrapped.wrapped_dek,
            updated_at: now,
          }),
        });
        if (!res.ok) {
          showToast("Falha ao salvar a nova senha do cofre.", "error");
          return false;
        }
      } catch {
        showToast("Sem conexão para trocar a senha.", "error");
        return false;
      }
      setMeta({ ...meta, salt: rewrapped.salt, iterations: rewrapped.iterations, wrapped_dek: rewrapped.wrapped_dek, updated_at: now });
      showToast("Senha do cofre alterada.", "success");
      return true;
    },
    [dek, meta, showToast]
  );

  // --- ensureUnlocked: abre modal e promete o resultado ----------------------

  const ensureUnlocked = useCallback((): Promise<boolean> => {
    if (status === "unlocked") return Promise.resolve(true);
    return new Promise((resolve) => {
      modalResolveRef.current = resolve;
      setModalError(null);
      setPassword("");
      void (async () => {
        await loadMeta();
        setModalOpen(true);
      })();
    });
  }, [status, loadMeta]);

  function closeModal(ok: boolean) {
    setModalOpen(false);
    modalResolveRef.current?.(ok);
    modalResolveRef.current = null;
  }

  async function handleModalSubmit() {
    if (submitting || !password) return;
    setSubmitting(true);
    setModalError(null);
    // Yield curto para o navegador pintar o spinner de carregamento
    await new Promise((r) => setTimeout(r, 60));
    try {
      const ok = await unlock(password);
      if (ok) {
        closeModal(true);
      } else {
        setModalError("Senha incorreta.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  // --- Helpers de cifra com a DEK em memória ---------------------------------

  function requireDek(): Uint8Array {
    if (!dek) throw new Error("Cofre travado — destrave antes de cifrar.");
    return dek;
  }

  const value = useMemo<VaultContextValue>(
    () => ({
      status,
      dek,
      busy,
      ensureUnlocked,
      unlock,
      setup,
      lock,
      changePassword,
      encryptString: (s: string) => encryptString(requireDek(), s),
      decryptString: (s: string) => decryptString(requireDek(), s),
      encryptBytes: (b: Uint8Array) => encryptBytes(requireDek(), b),
      decryptBytes: (b: Uint8Array) => decryptBytes(requireDek(), b),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [status, dek, busy, ensureUnlocked, unlock, setup, lock, changePassword]
  );

  return (
    <VaultContext.Provider value={value}>
      {children}

      {modalOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-950/70 backdrop-blur-sm"
          onClick={() => closeModal(false)}
        >
          <div
            className="w-full max-w-sm bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-2xl p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-amber-400/15 text-amber-500 flex items-center justify-center">
                  <Lock className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-semibold text-slate-900 dark:text-white text-sm">
                    Cofre
                  </h3>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    Digite a senha
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => closeModal(false)}
                className="p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-white rounded-lg transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2.5">
              <input
                type="password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleModalSubmit();
                }}
                placeholder="Digite a senha"
                className="w-full px-3.5 py-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-400/60"
              />
              {modalError && (
                <p className="text-xs text-red-600 dark:text-red-400">{modalError}</p>
              )}
              <button
                type="button"
                onClick={() => void handleModalSubmit()}
                disabled={submitting || !password}
                className="w-full flex items-center justify-center gap-2 py-2.5 bg-amber-400 hover:bg-amber-300 active:bg-amber-500 text-slate-950 font-semibold text-sm rounded-xl transition disabled:opacity-60"
              >
                {submitting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <KeyRound className="w-4 h-4" />
                )}
                {submitting ? "Abrindo cofre…" : "Abrir cofre"}
              </button>
            </div>
          </div>
        </div>
      )}
    </VaultContext.Provider>
  );
}
