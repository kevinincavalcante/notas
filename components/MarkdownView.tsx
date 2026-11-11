"use client";

import { useState, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";

interface MarkdownViewProps {
  content: string;
  /** Texto mostrado quando não há conteúdo (ex: "Pré-visualização aparecerá aqui") */
  placeholder?: string;
  /** Habilita o popover de redimensionamento: clicar na imagem no preview oferece 25/50/75/100% */
  onSetImageWidth?: (src: string, percent: number) => void;
}

const IMAGE_SIZES = [25, 50, 75, 100];

/** Extrai percentual de largura do title da imagem (convenção: title="50" ou "50%") */
function parsePercent(title?: string): number | null {
  if (!title) return null;
  const m = title.trim().match(/^(\d{1,3})\s*%?$/);
  if (!m) return null;
  const value = Number(m[1]);
  return value >= 1 && value <= 100 ? value : null;
}

/**
 * Preserva quebras de linha e Enters extras no Markdown.
 *
 * Por especificação (CommonMark), múltiplos Enters consecutivos são colapsados em
 * um único espaçador de bloco/parágrafo. Esta função preserva a fidelidade visual entre
 * o editor (textarea) e o preview:
 * - Quebras simples (\n) continuam virando <br> via remark-breaks.
 * - Dois Enters (\n\n) continuam criando a separação padrão de parágrafos.
 * - Três ou mais Enters (\n\n\n...) têm suas linhas vazias extras preservadas como
 *   linhas em branco (&nbsp;), mantendo a mesma quantidade de linhas que o usuário pulou.
 * - Enters no início ou no final do texto também são preservados.
 * - Blocos de código (``` e ~~~) são protegidos e mantidos 100% intactos.
 */
function preserveExtraNewlines(text: string): string {
  if (!text) return "";
  const normalized = text.replace(/\r\n/g, "\n");

  // Divide o texto protegendo blocos de código com ``` ou ~~~
  const codeBlockRegex = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$))/g;
  const parts = normalized.split(codeBlockRegex);

  return parts
    .map((part, i) => {
      // Índices ímpares são blocos de código; preservar exatamente como digitado
      if (i % 2 === 1) return part;

      let res = part;

      // 1. Linhas vazias no início do texto (Enters antes do primeiro conteúdo)
      res = res.replace(/^(?:[ \t]*\n)+/, (match) => {
        const count = match.split("\n").length - 1;
        if (count <= 0) return "";
        return Array(count).fill("&nbsp;").join("\n") + "\n\n";
      });

      // 2. Linhas vazias no final do texto (Enters após o último conteúdo)
      res = res.replace(/(?:\n[ \t]*)+$/, (match) => {
        const count = match.split("\n").length - 1;
        if (count <= 0) return "";
        return "\n\n" + Array(count).fill("&nbsp;").join("\n");
      });

      // 3. Múltiplos Enters consecutivos entre blocos (3 ou mais newlines)
      // 2 newlines formam o parágrafo padrão; os restantes viram linhas vazias com &nbsp;
      res = res.replace(/(?:\n[ \t]*){3,}/g, (match) => {
        const lines = match.split("\n").length - 1;
        const extraCount = lines - 2;
        if (extraCount <= 0) return "\n\n";
        const nbsps = Array(extraCount).fill("&nbsp;").join("\n");
        return "\n\n" + nbsps + "\n\n";
      });

      return res;
    })
    .join("");
}

/**
 * Preview Markdown somente-leitura (estilo Joplin: a coluna direita onde
 * se seleciona e copia sem risco de editar).
 *
 * - remark-gfm: tabelas, riscado, checkboxes, links automáticos
 * - remark-breaks: quebra de linha simples vira <br> (compatível com notas
 *   antigas de texto puro, onde Enter já quebrava linha visualmente)
 * - preserveExtraNewlines: múltiplos Enters consecutivos respeitam o espaçamento do editor
 * - Sem rehype-raw: HTML digitado aparece como texto, nunca é executado
 * - Imagens: encaixam na largura da coluna; com onSetImageWidth, clique
 *   abre popover de redimensionamento (a largura fica gravada no markdown,
 *   logo versiona no histórico e sincroniza nos apps)
 */
export default function MarkdownView({ content, placeholder, onSetImageWidth }: MarkdownViewProps) {
  const [activeImage, setActiveImage] = useState<{ src: string; percent: number } | null>(null);

  const processedContent = useMemo(() => preserveExtraNewlines(content), [content]);

  if (!content.trim()) {
    return (
      <div className="h-full flex items-center justify-center text-slate-400 dark:text-slate-500 text-sm italic p-6 text-center select-none">
        {placeholder || "O preview aparecerá aqui conforme você digita."}
      </div>
    );
  }

  const canResize = Boolean(onSetImageWidth);

  return (
    <div
      className="markdown-preview prose prose-sm dark:prose-invert max-w-none break-words prose-headings:mt-4 prose-headings:mb-2 prose-p:my-2 prose-li:my-1 prose-pre:my-3 prose-code:before:content-none prose-code:after:content-none"
      onClick={() => setActiveImage(null)}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          img: ({ src, alt, title, node, ...rest }) => {
            const srcStr = typeof src === "string" ? src : "";
            const percent = parsePercent(title) ?? 100;
            const isActive = activeImage?.src === srcStr;

            return (
              <span className="relative inline-block max-w-full align-top">
                <img
                  {...rest}
                  src={srcStr}
                  alt={alt ?? ""}
                  loading="lazy"
                  style={{ width: `${percent}%` }}
                  className={`rounded-xl my-3 max-w-full h-auto border border-black/10 dark:border-white/10 ${
                    canResize
                      ? "cursor-pointer hover:ring-2 hover:ring-amber-400/60 transition"
                      : ""
                  }`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (canResize) setActiveImage({ src: srcStr, percent });
                  }}
                  aria-label="Imagem da nota"
                />

                {canResize && isActive && (
                  <span
                    className="absolute z-20 top-2 left-2 flex items-center gap-1 p-1 rounded-xl bg-slate-900/90 dark:bg-slate-950 border border-white/10 shadow-lg"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {IMAGE_SIZES.map((size) => (
                      <button
                        key={size}
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSetImageWidth?.(srcStr, size);
                          setActiveImage(null);
                        }}
                        className={`px-2 py-1 rounded-lg text-[11px] font-semibold transition ${
                          percent === size
                            ? "bg-amber-400 text-slate-950"
                            : "text-white/80 hover:bg-white/10"
                        }`}
                      >
                        {size}%
                      </button>
                    ))}
                  </span>
                )}
              </span>
            );
          },
        }}
      >
        {processedContent}
      </ReactMarkdown>
    </div>
  );
}
