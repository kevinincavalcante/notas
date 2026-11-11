"use client";

import { useState, useEffect } from "react";
import { Note, NoteVersion } from "@/types/note";
import {
  Clock,
  RotateCcw,
  X,
  FileText,
  Eye,
  Code,
  Calendar,
  CheckCircle2,
} from "lucide-react";
import MarkdownView from "./MarkdownView";

interface VersionHistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  note: Note;
  onRestore: (version: NoteVersion) => Promise<void>;
}

export default function VersionHistoryModal({
  isOpen,
  onClose,
  note,
  onRestore,
}: VersionHistoryModalProps) {
  const [versions, setVersions] = useState<NoteVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedVersion, setSelectedVersion] = useState<NoteVersion | null>(null);
  const [viewMode, setViewMode] = useState<"preview" | "raw">("preview");
  const [isRestoring, setIsRestoring] = useState(false);

  // Carrega as versões ao abrir
  useEffect(() => {
    if (!isOpen) return;

    let active = true;
    setLoading(true);

    fetch(`/api/notes/${note.id}/versions`)
      .then((res) => (res.ok ? res.json() : { versions: [] }))
      .then((data) => {
        if (!active) return;
        const vList: NoteVersion[] = data.versions || [];
        setVersions(vList);
        if (vList.length > 0) {
          setSelectedVersion(vList[0]);
        } else {
          setSelectedVersion(null);
        }
      })
      .catch((err) => console.error("Erro ao carregar versões:", err))
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [isOpen, note.id]);

  // Tecla ESC para fechar
  useEffect(() => {
    if (!isOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  async function handleRestoreClick(v: NoteVersion) {
    if (!confirm(`Deseja realmente restaurar a nota para a versão de ${new Date(v.created_at).toLocaleString("pt-BR")}? O conteúdo atual será arquivado no histórico.`)) {
      return;
    }
    setIsRestoring(true);
    try {
      await onRestore(v);
      onClose();
    } catch (err) {
      console.error("Erro ao restaurar versão:", err);
      alert("Erro ao restaurar esta versão.");
    } finally {
      setIsRestoring(false);
    }
  }

  const inspectedWordCount = selectedVersion?.body?.trim()
    ? selectedVersion.body.trim().split(/\s+/).length
    : 0;
  const inspectedCharCount = selectedVersion?.body?.length || 0;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-2 sm:p-4 md:p-6 animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="w-full max-w-5xl h-[88vh] bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 flex flex-col overflow-hidden text-slate-900 dark:text-slate-100"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Topo do Modal ── */}
        <header className="px-5 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50 dark:bg-slate-900/60 shrink-0 select-none">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-amber-400/15 text-amber-500 flex items-center justify-center shrink-0">
              <Clock className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h2 className="font-bold text-sm sm:text-base text-slate-900 dark:text-white truncate">
                Histórico de Versões
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                {note.title || "Sem título"}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-white rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition"
            title="Fechar (Esc)"
          >
            <X className="w-5 h-5" />
          </button>
        </header>

        {/* ── Corpo do Modal (2 Painéis) ── */}
        <div className="flex-1 flex flex-col md:flex-row min-h-0 overflow-hidden">
          {/* Painel Esquerdo: Lista de Versões */}
          <aside className="w-full md:w-80 border-b md:border-b-0 md:border-r border-slate-200 dark:border-slate-800 flex flex-col bg-slate-50/70 dark:bg-slate-900/40 shrink-0">
            <div className="px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs text-slate-500 font-semibold uppercase tracking-wider select-none">
              <span>Versões Salvas ({versions.length})</span>
            </div>

            <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
              {loading ? (
                <div className="py-12 text-center text-xs text-slate-400 flex flex-col items-center gap-2">
                  <Clock className="w-6 h-6 animate-spin text-amber-500" />
                  <span>Carregando histórico...</span>
                </div>
              ) : versions.length === 0 ? (
                <div className="py-12 px-4 text-center text-xs text-slate-400 italic">
                  Nenhuma versão anterior gravada. Conforme você edita a nota, as alterações são salvas automaticamente aqui.
                </div>
              ) : (
                versions.map((v, index) => {
                  const isSelected = selectedVersion?.id === v.id;
                  const dateObj = new Date(v.created_at);
                  const isLatest = index === 0;

                  return (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => setSelectedVersion(v)}
                      className={`
                        w-full text-left p-3 rounded-xl transition-all flex flex-col gap-1 border
                        ${
                          isSelected
                            ? "border-amber-400 bg-white dark:bg-slate-800 shadow-sm ring-1 ring-amber-400/50"
                            : "border-transparent hover:border-slate-200 dark:hover:border-slate-700 bg-white/40 dark:bg-slate-800/40 hover:bg-white dark:hover:bg-slate-800"
                        }
                      `}
                    >
                      <div className="flex items-center justify-between gap-1 w-full">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <Calendar className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                          <span className="text-xs font-semibold text-slate-900 dark:text-white truncate font-mono">
                            {dateObj.toLocaleDateString("pt-BR", {
                              day: "2-digit",
                              month: "short",
                            })}
                            {" às "}
                            {dateObj.toLocaleTimeString("pt-BR", {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                        </div>

                        {isLatest && (
                          <span className="text-[10px] font-medium bg-amber-400/20 text-amber-800 dark:text-amber-300 px-1.5 py-0.5 rounded-full shrink-0">
                            Última
                          </span>
                        )}
                      </div>

                      <div className="text-xs text-slate-700 dark:text-slate-300 font-medium truncate mt-0.5">
                        {v.title || "Sem título"}
                      </div>

                      <div className="text-[11px] text-slate-400 line-clamp-1 italic">
                        {v.body?.trim() ? v.body.slice(0, 80) : "Nota vazia"}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </aside>

          {/* Painel Direito: Inspeção / Leitura Completa da Versão Selecionada */}
          <main className="flex-1 flex flex-col min-w-0 bg-white dark:bg-slate-900 overflow-hidden">
            {selectedVersion ? (
              <>
                {/* Faixa de Status da Versão + Botão de Restauração */}
                <div className="px-6 py-3 border-b border-slate-200 dark:border-slate-800 bg-amber-50/50 dark:bg-amber-950/20 flex flex-wrap items-center justify-between gap-3 shrink-0">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-amber-500 shrink-0" />
                    <span className="text-xs text-slate-700 dark:text-slate-300">
                      Visualizando versão de{" "}
                      <strong className="font-semibold text-slate-900 dark:text-white">
                        {new Date(selectedVersion.created_at).toLocaleString("pt-BR")}
                      </strong>
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    {/* Toggle Preview / Raw */}
                    <div className="flex items-center bg-slate-200 dark:bg-slate-800 p-0.5 rounded-lg text-xs">
                      <button
                        type="button"
                        onClick={() => setViewMode("preview")}
                        className={`px-2 py-1 rounded-md flex items-center gap-1 transition ${
                          viewMode === "preview"
                            ? "bg-white dark:bg-slate-700 text-slate-900 dark:text-white font-medium shadow-xs"
                            : "text-slate-500 hover:text-slate-900 dark:hover:text-white"
                        }`}
                        title="Visualizar formatado"
                      >
                        <Eye className="w-3 h-3" />
                        <span>Formatado</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setViewMode("raw")}
                        className={`px-2 py-1 rounded-md flex items-center gap-1 transition ${
                          viewMode === "raw"
                            ? "bg-white dark:bg-slate-700 text-slate-900 dark:text-white font-medium shadow-xs"
                            : "text-slate-500 hover:text-slate-900 dark:hover:text-white"
                        }`}
                        title="Texto puro / Markdown"
                      >
                        <Code className="w-3 h-3" />
                        <span>Código</span>
                      </button>
                    </div>

                    {/* Botão de Restaurar */}
                    <button
                      type="button"
                      disabled={isRestoring}
                      onClick={() => handleRestoreClick(selectedVersion)}
                      className="flex items-center gap-1.5 px-3.5 py-1.5 bg-amber-400 hover:bg-amber-300 text-slate-950 font-semibold text-xs rounded-lg transition shadow-xs disabled:opacity-50 active:scale-95"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>{isRestoring ? "Restaurando..." : "Restaurar esta versão"}</span>
                    </button>
                  </div>
                </div>

                {/* Área de Leitura da Versão */}
                <div className="flex-1 overflow-y-auto p-6 space-y-4">
                  {/* Título da Versão */}
                  <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 dark:text-white tracking-tight border-b border-slate-200 dark:border-slate-800 pb-3">
                    {selectedVersion.title || <span className="italic text-slate-400">Sem título</span>}
                  </h1>

                  {/* Corpo da Versão */}
                  {viewMode === "preview" ? (
                    <div className="bg-slate-50/50 dark:bg-slate-800/30 p-4 rounded-xl border border-slate-200 dark:border-slate-800 min-h-[250px]">
                      <MarkdownView
                        content={selectedVersion.body}
                        placeholder="Esta versão não possui texto gravado."
                      />
                    </div>
                  ) : (
                    <pre className="p-4 rounded-xl bg-slate-100 dark:bg-slate-950 text-slate-800 dark:text-slate-200 font-mono text-xs whitespace-pre-wrap break-words leading-relaxed border border-slate-200 dark:border-slate-800 min-h-[250px]">
                      {selectedVersion.body || "(Versão com texto vazio)"}
                    </pre>
                  )}
                </div>

                {/* Rodapé informativo */}
                <footer className="px-6 py-2 border-t border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/60 text-[11px] text-slate-400 font-mono flex items-center justify-between select-none shrink-0">
                  <span>{inspectedWordCount} palavras • {inspectedCharCount} caracteres</span>
                  <span>ID: {selectedVersion.id.slice(0, 8)}...</span>
                </footer>
              </>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-slate-400 p-8 text-center">
                <FileText className="w-12 h-12 text-slate-300 dark:text-slate-700 mb-2" />
                <p className="text-sm font-medium">Selecione uma versão na lista lateral</p>
                <p className="text-xs text-slate-400 mt-1">
                  Clique em qualquer versão para inspecionar seu conteúdo completo antes de restaurar.
                </p>
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
