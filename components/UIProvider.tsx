"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  ReactNode,
  useEffect,
} from "react";
import {
  AlertCircle,
  CheckCircle2,
  Info,
  X,
  Trash2,
  RotateCcw,
  AlertTriangle,
} from "lucide-react";

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: "danger" | "warning" | "primary";
}

export type ToastType = "error" | "success" | "info";

interface ToastItem {
  id: string;
  message: string;
  type: ToastType;
}

interface UIContextType {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  showToast: (message: string, type?: ToastType) => void;
}

const UIContext = createContext<UIContextType | null>(null);

export function useUI() {
  const ctx = useContext(UIContext);
  if (!ctx) {
    throw new Error("useUI must be used within a UIProvider");
  }
  return ctx;
}

export function UIProvider({ children }: { children: ReactNode }) {
  // Estado para Toasts
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  // Estado para Confirm Dialog
  const [confirmDialog, setConfirmDialog] = useState<{
    options: ConfirmOptions;
    resolve: (value: boolean) => void;
  } | null>(null);

  const confirmDialogRef = useRef<HTMLDivElement>(null);

  // Fecha confirm no ESC
  useEffect(() => {
    if (!confirmDialog) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        confirmDialog?.resolve(false);
        setConfirmDialog(null);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [confirmDialog]);

  const showToast = useCallback((message: string, type: ToastType = "info") => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts((prev) => [...prev, { id, message, type }]);

    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      setConfirmDialog({ options, resolve });
    });
  }, []);

  function handleConfirmDialogAction(value: boolean) {
    if (confirmDialog) {
      confirmDialog.resolve(value);
      setConfirmDialog(null);
    }
  }

  return (
    <UIContext.Provider value={{ confirm, showToast }}>
      {children}

      {/* ── Toasts Flutuantes Minimalistas ── */}
      <div
        aria-live="polite"
        className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[100] flex flex-col items-center gap-2 pointer-events-none w-full max-w-md px-4"
      >
        {toasts.map((toast) => {
          const isError = toast.type === "error";
          const isSuccess = toast.type === "success";

          return (
            <div
              key={toast.id}
              className={`
                pointer-events-auto flex items-center justify-between gap-2.5 px-4 py-2.5 rounded-xl text-xs font-medium shadow-xl border backdrop-blur-md transition-all duration-200 animate-in fade-in slide-in-from-bottom-2
                ${
                  isError
                    ? "bg-red-950/90 text-red-200 border-red-500/30 shadow-red-950/30"
                    : isSuccess
                      ? "bg-slate-900/90 text-emerald-300 border-emerald-500/30 shadow-slate-950/30"
                      : "bg-slate-900/90 text-slate-200 border-slate-700/60 shadow-slate-950/30"
                }
              `}
            >
              <div className="flex items-center gap-2 min-w-0">
                {isError && <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />}
                {isSuccess && <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />}
                {!isError && !isSuccess && <Info className="w-4 h-4 text-amber-400 shrink-0" />}
                <span className="truncate">{toast.message}</span>
              </div>

              <button
                type="button"
                onClick={() => removeToast(toast.id)}
                className="p-1 text-slate-400 hover:text-white rounded-md transition shrink-0 ml-2"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        })}
      </div>

      {/* ── Modal de Confirmação Minimalista ── */}
      {confirmDialog && (
        <div
          className="fixed inset-0 z-[110] bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in duration-150"
          onClick={() => handleConfirmDialogAction(false)}
        >
          <div
            ref={confirmDialogRef}
            className="w-full max-w-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl p-5 select-none animate-in zoom-in-95 duration-150 text-slate-900 dark:text-white"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Ícone de Destaque */}
            <div className="mb-3">
              {confirmDialog.options.variant === "warning" ? (
                <div className="w-10 h-10 rounded-xl bg-amber-400/15 text-amber-500 flex items-center justify-center">
                  <RotateCcw className="w-5 h-5" />
                </div>
              ) : confirmDialog.options.variant === "primary" ? (
                <div className="w-10 h-10 rounded-xl bg-amber-400/15 text-amber-500 flex items-center justify-center">
                  <AlertTriangle className="w-5 h-5" />
                </div>
              ) : (
                <div className="w-10 h-10 rounded-xl bg-red-500/15 text-red-500 flex items-center justify-center">
                  <Trash2 className="w-5 h-5" />
                </div>
              )}
            </div>

            {/* Título e Mensagem */}
            <h3 className="text-base font-bold text-slate-900 dark:text-white tracking-tight">
              {confirmDialog.options.title}
            </h3>
            <p className="text-xs text-slate-600 dark:text-slate-400 mt-1.5 leading-relaxed">
              {confirmDialog.options.message}
            </p>

            {/* Ações */}
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => handleConfirmDialogAction(false)}
                className="px-3.5 py-2 text-xs font-semibold rounded-xl text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
              >
                {confirmDialog.options.cancelText || "Cancelar"}
              </button>

              <button
                type="button"
                autoFocus
                onClick={() => handleConfirmDialogAction(true)}
                className={`
                  px-4 py-2 text-xs font-semibold rounded-xl transition shadow-xs active:scale-95
                  ${
                    confirmDialog.options.variant === "warning" || confirmDialog.options.variant === "primary"
                      ? "bg-amber-400 hover:bg-amber-300 text-slate-950 active:bg-amber-500"
                      : "bg-red-600 hover:bg-red-500 text-white active:bg-red-700"
                  }
                `}
              >
                {confirmDialog.options.confirmText || "Confirmar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </UIContext.Provider>
  );
}
