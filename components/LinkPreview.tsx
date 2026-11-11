"use client";

import { useState, useEffect } from "react";
import { ExternalLink, Globe } from "lucide-react";

interface LinkMetadata {
  url: string;
  title: string;
  description?: string | null;
  image?: string | null;
  siteName: string;
  favicon?: string;
}

// Cache local em memória para evitar requisições repetidas na mesma sessão
const metadataCache = new Map<string, LinkMetadata>();

export function extractUrls(text: string): string[] {
  if (!text) return [];
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const matches = text.match(urlRegex);
  if (!matches) return [];
  // Retorna URLs únicas e válidas
  return Array.from(new Set(matches)).filter((u) => {
    try {
      new URL(u);
      return true;
    } catch {
      return false;
    }
  });
}

export default function LinkPreview({ url }: { url: string }) {
  const [data, setData] = useState<LinkMetadata | null>(metadataCache.get(url) || null);
  const [loading, setLoading] = useState(!metadataCache.has(url));

  useEffect(() => {
    if (metadataCache.has(url)) {
      setData(metadataCache.get(url)!);
      setLoading(false);
      return;
    }

    let isMounted = true;
    setLoading(true);

    fetch(`/api/metadata?url=${encodeURIComponent(url)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((meta) => {
        if (isMounted && meta && meta.title) {
          metadataCache.set(url, meta);
          setData(meta);
        }
      })
      .catch((err) => console.warn("Erro ao buscar link preview:", err))
      .finally(() => {
        if (isMounted) setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [url]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-2.5 rounded-xl border border-black/10 dark:border-white/10 bg-black/5 dark:bg-white/5 animate-pulse text-xs text-slate-400">
        <Globe className="w-4 h-4 animate-spin text-amber-500" />
        Carregando prévia do link...
      </div>
    );
  }

  if (!data) return null;

  return (
    <a
      href={data.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="group/link block rounded-xl border border-black/10 dark:border-white/10 bg-white/70 dark:bg-black/20 hover:bg-white dark:hover:bg-black/30 overflow-hidden transition-all duration-200 hover:shadow-md"
    >
      {/* Imagem de Capa do Link (YouTube / OpenGraph) */}
      {data.image && (
        <div className="w-full h-36 bg-slate-100 dark:bg-slate-800 overflow-hidden relative">
          <img
            src={data.image}
            alt={data.title}
            loading="lazy"
            className="w-full h-full object-cover transition-transform duration-300 group-hover/link:scale-105"
            onError={(e) => {
              // Se a imagem falhar ao carregar, esconde
              (e.target as HTMLElement).style.display = "none";
            }}
          />
        </div>
      )}

      {/* Conteúdo de Texto */}
      <div className="p-3">
        {/* Favicon & Nome do Site */}
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <div className="flex items-center gap-1.5 min-w-0">
            {data.favicon ? (
              <img
                src={data.favicon}
                alt=""
                className="w-3.5 h-3.5 rounded shrink-0"
                onError={(e) => {
                  (e.target as HTMLElement).style.display = "none";
                }}
              />
            ) : (
              <Globe className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            )}
            <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400 truncate uppercase tracking-wider">
              {data.siteName}
            </span>
          </div>
          <ExternalLink className="w-3.5 h-3.5 text-slate-400 opacity-0 group-hover/link:opacity-100 transition-opacity shrink-0" />
        </div>

        {/* Título do Link */}
        <h4 className="text-xs font-semibold text-slate-900 dark:text-white line-clamp-2 leading-snug">
          {data.title}
        </h4>

        {/* Descrição resumida */}
        {data.description && (
          <p className="text-[11px] text-slate-500 dark:text-slate-400 line-clamp-2 mt-1 leading-normal">
            {data.description}
          </p>
        )}
      </div>
    </a>
  );
}
