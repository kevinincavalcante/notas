"use client";

import { useState, useEffect } from "react";
import { Search, X, StickyNote, Archive, LogOut, Menu } from "lucide-react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";

interface HeaderProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onToggleSidebar?: () => void;
}

export default function Header({ searchQuery, onSearchChange, onToggleSidebar }: HeaderProps) {
  const [localQuery, setLocalQuery] = useState(searchQuery);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    setLocalQuery(searchQuery);
  }, [searchQuery]);

  // Debounce search update (250ms)
  useEffect(() => {
    const timer = setTimeout(() => {
      onSearchChange(localQuery);
    }, 250);
    return () => clearTimeout(timer);
  }, [localQuery, onSearchChange]);

  async function handleLogout() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      router.push("/login");
      router.refresh();
    } catch (e) {
      console.error(e);
    }
  }

  return (
    <header className="sticky top-0 z-30 bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 px-4 py-2.5">
      <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
        {/* Lado Esquerdo: Menu & Marca */}
        <div className="flex items-center gap-3 shrink-0">
          {onToggleSidebar && (
            <button
              type="button"
              onClick={onToggleSidebar}
              className="p-2 text-slate-500 hover:text-slate-800 dark:hover:text-white rounded-lg md:hidden"
            >
              <Menu className="w-5 h-5" />
            </button>
          )}

          <Link href="/" className="flex items-center gap-2.5 group">
            <div className="w-9 h-9 bg-amber-400 text-slate-950 rounded-xl flex items-center justify-center font-bold shadow-sm transition group-hover:scale-105">
              <StickyNote className="w-5 h-5" />
            </div>
            <span className="font-bold text-lg text-slate-900 dark:text-white tracking-tight hidden sm:inline">
              Notas
            </span>
          </Link>
        </div>

        {/* Centro: Barra de Busca Rápida com FTS5 */}
        <div className="flex-1 max-w-2xl relative">
          <div className="relative flex items-center">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 pointer-events-none" />
            <input
              type="text"
              value={localQuery}
              onChange={(e) => setLocalQuery(e.target.value)}
              placeholder="Pesquisar notas, áudios, textos..."
              className="w-full pl-10 pr-9 py-2 bg-slate-100 dark:bg-slate-800/80 border border-transparent focus:border-slate-300 dark:focus:border-slate-700 rounded-xl text-sm text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:bg-white dark:focus:bg-slate-900 focus:shadow-sm transition"
            />
            {localQuery && (
              <button
                type="button"
                onClick={() => {
                  setLocalQuery("");
                  onSearchChange("");
                }}
                className="absolute right-3 p-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* Lado Direito: Navegação & Logout */}
        <div className="flex items-center gap-2 shrink-0">
          <Link
            href="/"
            className={`p-2 rounded-xl text-sm font-medium flex items-center gap-1.5 transition ${
              pathname === "/"
                ? "bg-amber-400/15 text-amber-600 dark:text-amber-400 font-semibold"
                : "text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
            }`}
          >
            <StickyNote className="w-4 h-4" />
            <span className="hidden md:inline">Notas</span>
          </Link>

          <Link
            href="/archive"
            className={`p-2 rounded-xl text-sm font-medium flex items-center gap-1.5 transition ${
              pathname === "/archive"
                ? "bg-amber-400/15 text-amber-600 dark:text-amber-400 font-semibold"
                : "text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
            }`}
          >
            <Archive className="w-4 h-4" />
            <span className="hidden md:inline">Arquivo</span>
          </Link>

          <button
            type="button"
            onClick={handleLogout}
            title="Sair da conta"
            className="p-2 text-slate-500 hover:text-red-600 dark:hover:text-red-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl transition ml-1"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </header>
  );
}
