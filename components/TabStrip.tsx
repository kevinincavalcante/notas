"use client";

import { Plus, RefreshCw, X } from "lucide-react";

export interface SyncIndicator {
  busy?: boolean;
  error?: string | null;
  at?: number | null;
}

interface TabStripProps {
  tabs: { id: string; title: string; color?: string }[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  /** Presente só no desktop (Electron): botão de sync manual + indicador. */
  onSync?: () => void;
  syncIndicator?: SyncIndicator | null;
}

/**
 * Barra de abas estilo Chrome: largura fixa por aba, título truncado,
 * × no hover (e sempre visível na aba ativa), botão + pra nova aba e —
 * no desktop — botão de sincronizar com indicador do último ciclo.
 */
export default function TabStrip({
  tabs,
  activeId,
  onSelect,
  onClose,
  onNew,
  onSync,
  syncIndicator,
}: TabStripProps) {
  const busy = syncIndicator?.busy;
  const hasError = Boolean(syncIndicator?.error);
  const syncTitle = syncIndicator?.error
    ? `Sync falhou: ${syncIndicator.error}`
    : syncIndicator?.at
      ? `Sincronizado ${new Date(syncIndicator.at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })} — clicar sincroniza agora`
      : "Sincronizar agora";

  return (
    <div className="flex items-center gap-1 px-2 pt-1.5 shrink-0 bg-slate-100/50 dark:bg-slate-900/30 border-b border-black/5 dark:border-white/5 overflow-x-auto">
      {tabs.map((tab) => {
        const isActive = tab.id === activeId;
        return (
          <div
            key={tab.id}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(tab.id)}
            aria-pressed={isActive}
            className={`group flex items-center gap-1.5 pl-3 pr-1.5 py-1.5 rounded-t-lg text-xs w-44 shrink-0 cursor-pointer transition border ${
              isActive
                ? "bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-white font-semibold border-black/5 dark:border-white/10 border-b-transparent shadow-xs"
                : "text-slate-500 dark:text-slate-400 hover:bg-black/5 dark:hover:bg-white/5 border-transparent"
            }`}
          >
            {tab.color && tab.color !== "default" && (
              <span
                className={`w-2 h-2 rounded-full shrink-0 border border-black/10 dark:border-white/20 note-color-${tab.color}`}
              />
            )}
            <span className="truncate flex-1 text-left select-none">
              {tab.title || "Sem título"}
            </span>
            <span
              role="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
              className={`p-0.5 rounded-md hover:bg-black/10 dark:hover:bg-white/10 transition ${
                isActive
                  ? "opacity-70 hover:opacity-100"
                  : "opacity-0 group-hover:opacity-100"
              }`}
              aria-label="Fechar aba"
            >
              <X className="w-3 h-3" />
            </span>
          </div>
        );
      })}

      {/* Nova aba — sempre visível, no fim da fila */}
      <button
        type="button"
        onClick={onNew}
        aria-label="Nova aba"
        title="Nova aba (Ctrl+N no desktop)"
        className="shrink-0 p-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:bg-amber-400/15 hover:text-amber-600 dark:hover:text-amber-400 active:scale-90 transition"
      >
        <Plus className="w-3.5 h-3.5" />
      </button>

      {/* Sync manual — só no desktop (Electron) */}
      {onSync && (
        <button
          type="button"
          onClick={onSync}
          disabled={busy}
          aria-label="Sincronizar agora"
          title={syncTitle}
          className={`shrink-0 p-1.5 rounded-lg active:scale-90 transition ${
            hasError
              ? "text-red-500 hover:bg-red-500/10"
              : "text-slate-500 dark:text-slate-400 hover:bg-amber-400/15 hover:text-amber-600 dark:hover:text-amber-400"
          } ${busy ? "opacity-60" : ""}`}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${busy ? "animate-spin" : ""}`} />
        </button>
      )}
    </div>
  );
}
