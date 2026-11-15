"use client";

import { useState, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import hljs from "highlight.js";
import { Copy, Check } from "lucide-react";
import { autoFenceEnvBlocks } from "@/lib/markdown-env";

interface MarkdownViewProps {
  content: string;
  /** Texto mostrado quando não há conteúdo (ex: "Pré-visualização aparecerá aqui") */
  placeholder?: string;
  /** Habilita o popover de redimensionamento: clicar na imagem no preview oferece 25/50/75/100% */
  onSetImageWidth?: (src: string, percent: number) => void;
  /** Referência no corpo a um anexo que NÃO é imagem/áudio (.key, .pdf...):
   *  o preview renderiza um chip "⬇ Baixar" em vez de imagem quebrada */
  onFileAttachmentClick?: (attachmentId: string, alt: string) => void;
}

const IMAGE_SIZES = [25, 50, 75, 100];
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif", "svg", "bmp"]);

/** Alt/src termina com extensão que não é de imagem → é um ARQUIVO anexado
 *  (key, pdf, zip, txt...). Renderiza chip de download, não <img> quebrado. */
function fileLikeAttachment(text: string): boolean {
  const m = text.match(/\.([a-zA-Z0-9]{1,8})$/);
  return Boolean(m && !IMAGE_EXTENSIONS.has(m[1].toLowerCase()));
}

/** Extrai percentual de largura do title da imagem (convenção: title="50" ou "50%") */
function parsePercent(title?: string): number | null {
  if (!title) return null;
  const m = title.trim().match(/^(\d{1,3})\s*%?$/);
  if (!m) return null;
  const value = Number(m[1]);
  return value >= 1 && value <= 100 ? value : null;
}

/**
 * Componente dedicado para renderizar blocos de código com Syntax Highlighting,
 * tag da linguagem identificada e botão de copiar.
 */
function CodeBlock({ code, language }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false);

  const { highlightedHtml, detectedLang } = useMemo(() => {
    try {
      if (language && hljs.getLanguage(language)) {
        return {
          highlightedHtml: hljs.highlight(code, { language, ignoreIllegals: true }).value,
          detectedLang: language,
        };
      }
      const auto = hljs.highlightAuto(code);
      return {
        highlightedHtml: auto.value,
        detectedLang: auto.language || "código",
      };
    } catch {
      return {
        highlightedHtml: code,
        detectedLang: language || "código",
      };
    }
  }, [code, language]);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Uma linha por número no gutter (o bloco não quebra linha: rola na horizontal)
  const lineCount = code.split("\n").length;

  return (
    <div className="not-prose my-3 rounded-2xl overflow-hidden border border-black/10 dark:border-white/10 bg-slate-900 text-slate-100 shadow-xs">
      <div className="flex items-center justify-between px-3.5 py-1.5 bg-slate-950/70 border-b border-white/5 text-xs text-slate-400 select-none">
        <span className="font-mono text-[11px] uppercase tracking-wider font-semibold text-amber-400/90">
          {detectedLang}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-slate-300 hover:text-white hover:bg-white/10 transition text-[11px] font-medium"
          title="Copiar código"
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5 text-emerald-400" />
              <span className="text-emerald-400">Copiado!</span>
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" />
              <span>Copiar</span>
            </>
          )}
        </button>
      </div>
      <div className="flex">
        {/* Gutter de números de linha (alinhado: mesmo padding-top, fonte e line-height do código) */}
        <div
          aria-hidden="true"
          className="select-none shrink-0 pt-3.5 pb-3.5 pl-3 pr-2 text-right text-xs font-mono leading-relaxed text-slate-500/70 bg-slate-950/40 border-r border-white/5"
        >
          {Array.from({ length: lineCount }, (_, i) => (
            <div key={i}>{i + 1}</div>
          ))}
        </div>
        <pre className="p-3.5 pl-3 overflow-x-auto text-xs font-mono leading-relaxed bg-transparent m-0 flex-1 min-w-0">
          <code
            className="hljs"
            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          />
        </pre>
      </div>
    </div>
  );
}

/**
 * Detecta se um bloco de texto parece ser código puro (JSON, HTML/XML, SQL, JS/TS, Python)
 * para possibilitar syntax highlighting automático mesmo quando o usuário não insere crases.
 */
function isLikelyCode(text: string): string | null {
  const trimmed = text.trim();
  const lines = trimmed.split("\n");

  // 1. JSON: inicia com { ou [ e termina com } ou ] e valida via JSON.parse
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null) {
        return "json";
      }
    } catch {}
  }

  if (lines.length < 3) return null;

  // 2. HTML / XML / SVG
  if (trimmed.startsWith("<") && (trimmed.endsWith(">") || trimmed.endsWith("/>"))) {
    if (
      trimmed.startsWith("<!DOCTYPE") ||
      trimmed.startsWith("<?xml") ||
      trimmed.startsWith("<html") ||
      trimmed.startsWith("<svg") ||
      trimmed.startsWith("<div") ||
      trimmed.startsWith("<script")
    ) {
      return "html";
    }
  }

  // 3. SQL
  if (/^(SELECT\s[\s\S]+FROM|INSERT\s+INTO|CREATE\s+TABLE|ALTER\s+TABLE|UPDATE\s+\w+\s+SET)\b/i.test(trimmed)) {
    return "sql";
  }

  // 4. JS / TS
  if (/^(import\s.+from\s|export\s+(default\s+)?|const\s+\w+\s*=|let\s+\w+\s*=|function\s+\w+\s*\(|class\s+\w+\s*\{)/m.test(trimmed)) {
    if (trimmed.includes("{") && trimmed.includes("}")) {
      return "javascript";
    }
  }

  // 5. Python
  if (/^(def\s+\w+\s*\(.*\)\s*:|class\s+\w+(\(.*\))?\s*:)/m.test(trimmed)) {
    return "python";
  }

  return null;
}

/**
 * Envolve blocos de código/JSON detectados automaticamente em blocos Markdown com crases.
 */
function autoDetectCodeBlocks(text: string): string {
  if (!text) return "";
  const codeBlockRegex = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$))/g;
  const parts = text.split(codeBlockRegex);

  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part; // já dentro de bloco de código

      const trimmed = part.trim();
      if (!trimmed) return part;

      const fullLang = isLikelyCode(trimmed);
      if (fullLang) {
        return "```" + fullLang + "\n" + trimmed + "\n```";
      }

      const sections = part.split(/\n{2,}/);
      if (sections.length > 1) {
        const converted = sections.map((s) => {
          const sTrimmed = s.trim();
          const sLang = isLikelyCode(sTrimmed);
          if (sLang) {
            return "```" + sLang + "\n" + sTrimmed + "\n```";
          }
          return s;
        });
        return converted.join("\n\n");
      }

      return part;
    })
    .join("");
}

/**
 * Preserva quebras de linha e Enters extras no Markdown.
 */
function preserveExtraNewlines(text: string): string {
  if (!text) return "";
  const normalized = text.replace(/\r\n/g, "\n");

  const codeBlockRegex = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$))/g;
  const parts = normalized.split(codeBlockRegex);

  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part;

      let res = part;

      // 1. Linhas vazias no início do texto
      res = res.replace(/^(?:[ \t]*\n)+/, (match) => {
        const count = match.split("\n").length - 1;
        if (count <= 0) return "";
        return Array(count).fill("&nbsp;").join("\n") + "\n\n";
      });

      // 2. Linhas vazias no final do texto
      res = res.replace(/(?:\n[ \t]*)+$/, (match) => {
        const count = match.split("\n").length - 1;
        if (count <= 0) return "";
        return "\n\n" + Array(count).fill("&nbsp;").join("\n");
      });

      // 3. Múltiplos Enters consecutivos entre blocos
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

const SAFE_PROTOCOL_REGEX = /^(https?|ircs?|mailto|xmpp|blob|data)$/i;

/**
 * Sanitiza URLs do markdown permitindo protocolos seguros além de blob: e data:image/.
 * O defaultUrlTransform do react-markdown bloqueia blob: e data: por padrão, o que
 * quebrava a renderização de anexos do cofre (blob URLs) e placeholders SVG.
 */
function customUrlTransform(url: string): string {
  const colon = url.indexOf(":");
  const questionMark = url.indexOf("?");
  const numberSign = url.indexOf("#");
  const slash = url.indexOf("/");

  if (
    colon === -1 ||
    (slash !== -1 && colon > slash) ||
    (questionMark !== -1 && colon > questionMark) ||
    (numberSign !== -1 && colon > numberSign) ||
    SAFE_PROTOCOL_REGEX.test(url.slice(0, colon))
  ) {
    if (url.startsWith("data:") && !url.startsWith("data:image/")) {
      return "";
    }
    return url;
  }

  return "";
}

/**
 * Preview Markdown somente-leitura (estilo Joplin: a coluna direita onde
 * se seleciona e copia sem risco de editar).
 *
 * - remark-gfm: tabelas, riscado, checkboxes, links automáticos
 * - remark-breaks: quebra de linha simples vira <br>
 * - preserveExtraNewlines: múltiplos Enters consecutivos respeitam o espaçamento do editor
 * - autoDetectCodeBlocks + CodeBlock: syntax highlighting automático e para blocos de código
 * - preserveExtraNewlines: múltiplos Enters consecutivos respeitam o espaçamento do editor
 */
export default function MarkdownView({
  content,
  placeholder,
  onSetImageWidth,
  onFileAttachmentClick,
}: MarkdownViewProps) {
  const [activeImage, setActiveImage] = useState<{ src: string; percent: number } | null>(null);

  const processedContent = useMemo(() => {
    // Blocos .env/ini ganham fence automático (o markdown engolia `# =====`
    // como H1 e comentários como títulos) — só na exibição, o corpo não muda
    const withEnv = autoFenceEnvBlocks(content);
    const withCode = autoDetectCodeBlocks(withEnv);
    return preserveExtraNewlines(withCode);
  }, [content]);

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
      className="markdown-preview prose prose-sm dark:prose-invert max-w-none break-words prose-headings:mt-4 prose-headings:mb-2 prose-p:my-2 prose-li:my-1 prose-pre:my-0 prose-code:before:content-none prose-code:after:content-none"
      onClick={() => setActiveImage(null)}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        urlTransform={customUrlTransform}
        components={{
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children, node, ...props }) => {
            const match = /language-(\w+)/.exec(className || "");
            const isInline = !className && !String(children).includes("\n");

            if (isInline) {
              return (
                <code
                  className="px-1.5 py-0.5 rounded-md bg-black/5 dark:bg-white/10 text-amber-600 dark:text-amber-400 font-mono text-[0.875em] border border-black/5 dark:border-white/5 font-normal"
                  {...props}
                >
                  {children}
                </code>
              );
            }

            const codeString = String(children).replace(/\n$/, "");
            return <CodeBlock code={codeString} language={match ? match[1] : undefined} />;
          },
          img: ({ src, alt, title, node, ...rest }) => {
            const srcStr = typeof src === "string" ? src : "";
            // Anexo ARQUIVO (não-imagem) referenciado no corpo: chip de
            // download em vez de <img> quebrado — o id vem da URL canônica
            const attMatch = /\/api\/attachments\/([0-9a-fA-F-]{36})/.exec(srcStr);
            if (
              attMatch &&
              onFileAttachmentClick &&
              (fileLikeAttachment(alt ?? "") || fileLikeAttachment(srcStr))
            ) {
              return (
                <span className="inline-flex items-center gap-2 my-3 px-3 py-2 rounded-xl bg-amber-400/10 border border-amber-400/30 max-w-full align-top">
                  <span className="text-base shrink-0">📎</span>
                  <span className="text-xs font-medium text-amber-700 dark:text-amber-300 truncate max-w-[16rem]">
                    {alt || "arquivo"}
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onFileAttachmentClick(attMatch[1], alt ?? "");
                    }}
                    className="text-[11px] font-semibold px-2 py-1 rounded-lg bg-amber-400 text-slate-950 hover:bg-amber-300 transition shrink-0"
                  >
                    ⬇ Baixar
                  </button>
                </span>
              );
            }
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
