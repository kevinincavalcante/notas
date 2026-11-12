"use client";

import { X } from "lucide-react";

interface TabStripProps {
  tabs: { id: string; title: string }[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}

/**
 * Barra de abas estilo browser — discreta: pills finas, título truncado,
 * × aparece no hover. Visível em web e desktop (no web vira só uma barra
 * de abas clicável; os atalhos Ctrl+N/W ficam só no Electron).
 */
export default function TabStrip({ tabs, activeId, onSelect, onClose }: TabStripProps) {
  if (tabs.length === 0) return null;

  return (
    <div className="flex items-end gap-1 px-2 pt-1.5 overflow-x-auto shrink-0 bg-slate-100/50 dark:bg-slate-900/30 border-b border-black/5 dark:border-white/5">
      {tabs.map((tab) => {
        const isActive = tab.id === activeId;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onSelect(tab.id)}
            aria-pressed={isActive}
            className={`group flex items-center gap-1.5 pl-3 pr-1.5 py-1.5 rounded-t-lg text-xs max-w-44 min-w-20 shrink-0 transition border ${
              isActive
                ? "bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-white font-semibold border-black/5 dark:border-white/10 border-b-transparent shadow-xs"
                : "text-slate-500 dark:text-slate-400 hover:bg-black/5 dark:hover:bg-white/5 border-transparent"
            }`}
          >
            <span className="truncate flex-1 text-left">
              {tab.title || "Sem título"}
            </span>
            <span
              role="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
              className="p-0.5 rounded-md hover:bg-black/10 dark:hover:bg-white/10 opacity-0 group-hover:opacity-100 focus:opacity-100 transition"
              aria-label="Fechar aba"
            >
              <X className="w-3 h-3" />
            </span>
          </button>
        );
      })}
    </div>
  );
}
