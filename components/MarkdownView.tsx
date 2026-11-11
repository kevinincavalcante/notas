"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";

interface MarkdownViewProps {
  content: string;
  /** Texto mostrado quando não há conteúdo (ex: "Pré-visualização aparecerá aqui") */
  placeholder?: string;
}

/**
 * Preview Markdown somente-leitura (estilo Joplin: a coluna direita onde
 * se seleciona e copia sem risco de editar).
 *
 * - remark-gfm: tabelas, riscado, checkboxes, links automáticos
 * - remark-breaks: quebra de linha simples vira <br> (compatível com notas
 *   antigas de texto puro, onde Enter já quebrava linha visualmente)
 * - Sem rehype-raw: HTML digitado aparece como texto, nunca é executado
 */
export default function MarkdownView({ content, placeholder }: MarkdownViewProps) {
  if (!content.trim()) {
    return (
      <div className="h-full flex items-center justify-center text-slate-400 dark:text-slate-500 text-sm italic p-6 text-center select-none">
        {placeholder || "O preview aparecerá aqui conforme você digita."}
      </div>
    );
  }

  return (
    <div className="markdown-preview prose prose-sm dark:prose-invert max-w-none break-words prose-headings:mt-4 prose-headings:mb-2 prose-p:my-2 prose-li:my-1 prose-pre:my-3 prose-code:before:content-none prose-code:after:content-none">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          // Imagens encaixam no bloco: no máximo a largura da coluna, altura proporcional
          img: (props) => (
            <img
              {...props}
              className="rounded-xl my-3 max-w-full h-auto border border-black/10 dark:border-white/10"
              loading="lazy"
            />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
