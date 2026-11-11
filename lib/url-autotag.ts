import { db } from "@/lib/turso";
import { extractUrls } from "@/lib/extract-urls";
import { isAllowedPublicUrl, BROWSER_FETCH_HEADERS } from "@/lib/url-safety";
import { autoTagsFromPage, isCodeBody } from "@/lib/auto-tags";
import type { Client } from "@libsql/client";

/**
 * Marcadores automáticos por URL: detecta o tipo de conteúdo (produto,
 * vídeo, notícia, artigo...) via JSON-LD/schema.org da página e vincula
 * as tags à nota no salvar.
 *
 * - Detecção no servidor (funciona igual no web, desktop e mobile)
 * - Cache em memória (10 min) para não refazer fetch a cada salvamento
 * - Falha silenciosa: nunca bloqueia o salvamento da nota
 * - Também sincroniza o marcador "Códigos" (source='code') pelo corpo
 */

const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_URLS_PER_NOTE = 3;

interface CacheEntry {
  tags: string[];
  at: number;
}

const detectionCache = new Map<string, CacheEntry>();

/** Hosts que viram "Vídeos" direto, sem precisar de JSON-LD. */
function isVideoHost(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    return (
      hostname === "youtube.com" ||
      hostname.endsWith(".youtube.com") ||
      hostname === "youtu.be" ||
      hostname === "vimeo.com" ||
      hostname.endsWith(".vimeo.com")
    );
  } catch {
    return false;
  }
}

/** Extrai todos os valores @type dos blocos JSON-LD da página (lida com array e @graph). */
export function extractJsonLdTypes(html: string): string[] {
  const types: string[] = [];
  const scriptRegex =
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

  const visit = (node: unknown, depth = 0): void => {
    if (depth > 5) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const obj = node as Record<string, unknown>;
    if (typeof obj["@type"] === "string") {
      types.push(obj["@type"]);
    } else if (Array.isArray(obj["@type"])) {
      for (const t of obj["@type"]) {
        if (typeof t === "string") types.push(t);
      }
    }
    if (obj["@graph"]) visit(obj["@graph"], depth + 1);
  };

  for (const match of html.matchAll(scriptRegex)) {
    try {
      visit(JSON.parse(match[1]));
    } catch {
      // JSON-LD malformado na página: ignora esse bloco
    }
  }
  return types;
}

function extractOgType(html: string): string | null {
  const regexes = [
    /<meta[^>]+property=["']og:type["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:type["']/i,
  ];
  for (const regex of regexes) {
    const match = html.match(regex);
    if (match) return match[1];
  }
  return null;
}

export async function detectTagsForUrl(url: string): Promise<string[]> {
  const cached = detectionCache.get(url);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.tags;
  }

  let tags: string[] = [];

  try {
    if (!isAllowedPublicUrl(url)) {
      tags = [];
    } else if (isVideoHost(url)) {
      tags = ["Vídeos"];
    } else {
      const res = await fetch(url, {
        headers: BROWSER_FETCH_HEADERS,
        signal: AbortSignal.timeout(5000),
        redirect: "follow",
      });
      if (res.ok) {
        const html = await res.text();
        tags = autoTagsFromPage(extractJsonLdTypes(html), extractOgType(html));
      }
    }
  } catch {
    // Timeout, rede, HTML inválido: fica sem tags dessa URL
  }

  detectionCache.set(url, { tags, at: Date.now() });
  return tags;
}

const CODE_TAG_NAME = "Códigos";

/**
 * Sincroniza o marcador "Códigos" (source='code') de uma nota.
 * Presente quando o corpo é claramente código, ausente quando não é mais.
 */
async function syncCodeAutoTag(
  noteId: string,
  body: string,
  client: Client = db
): Promise<void> {
  const isCode = isCodeBody(body);

  const current = await client.execute({
    sql: `
      SELECT t.id
      FROM note_tags nt
      JOIN tags t ON t.id = nt.tag_id
      WHERE nt.note_id = ? AND t.source = 'code'
      LIMIT 1
    `,
    args: [noteId],
  });
  const currentId = current.rows[0]?.id as string | undefined;

  if (isCode && !currentId) {
    await client.execute({
      sql: `
        INSERT INTO tags (id, name, kind, source, created_at)
        VALUES (?, ?, 'auto', 'code', ?)
        ON CONFLICT(name) DO NOTHING
      `,
      args: [crypto.randomUUID(), CODE_TAG_NAME, Date.now()],
    });
    const tagRes = await client.execute({
      sql: `SELECT id FROM tags WHERE name = ? AND source = 'code'`,
      args: [CODE_TAG_NAME],
    });
    const tagId = tagRes.rows[0]?.id as string | undefined;
    if (tagId) {
      await client.execute({
        sql: `
          INSERT OR IGNORE INTO note_tags (note_id, tag_id, created_at)
          VALUES (?, ?, ?)
        `,
        args: [noteId, tagId, Date.now()],
      });
    }
  } else if (!isCode && currentId) {
    await client.execute({
      sql: `DELETE FROM note_tags WHERE note_id = ? AND tag_id = ?`,
      args: [noteId, currentId],
    });
  }
}

/**
 * Recalcula as tags automáticas derivadas do CORPO de uma nota:
 * "Códigos" (source='code') e as tags de URLs (source='url').
 * As de arquivo e as manuais do usuário não são tocadas.
 * @param client opcional (default: db global) — usado pelo sync do desktop
 */
export async function syncBodyAutoTags(
  noteId: string,
  body: string,
  client: Client = db
): Promise<void> {
  await syncCodeAutoTag(noteId, body, client);

  const urls = extractUrls(body)
    .filter(isAllowedPublicUrl)
    .slice(0, MAX_URLS_PER_NOTE);

  const results = await Promise.allSettled(urls.map((u) => detectTagsForUrl(u)));
  const desired = new Set<string>();
  for (const result of results) {
    if (result.status === "fulfilled") {
      for (const tag of result.value) desired.add(tag);
    }
  }

  // Tags de origem URL atualmente vinculadas
  const current = await client.execute({
    sql: `
      SELECT t.id, t.name
      FROM note_tags nt
      JOIN tags t ON t.id = nt.tag_id
      WHERE nt.note_id = ? AND t.source = 'url'
    `,
    args: [noteId],
  });

  const currentByName = new Map<string, string>();
  for (const row of current.rows) {
    currentByName.set(row.name as string, row.id as string);
  }

  // Remove tags de URL que não se aplicam mais ao corpo atual
  for (const [name, id] of currentByName) {
    if (!desired.has(name)) {
      await client.execute({
        sql: `DELETE FROM note_tags WHERE note_id = ? AND tag_id = ?`,
        args: [noteId, id],
      });
    }
  }

  // Adiciona as novas
  for (const name of desired) {
    if (currentByName.has(name)) continue;
    await client.execute({
      sql: `
        INSERT INTO tags (id, name, kind, source, created_at)
        VALUES (?, ?, 'auto', 'url', ?)
        ON CONFLICT(name) DO NOTHING
      `,
      args: [crypto.randomUUID(), name, Date.now()],
    });
    const tagRes = await client.execute({
      sql: `SELECT id FROM tags WHERE name = ?`,
      args: [name],
    });
    const tagId = tagRes.rows[0]?.id as string | undefined;
    if (!tagId) continue;
    await client.execute({
      sql: `
        INSERT OR IGNORE INTO note_tags (note_id, tag_id, created_at)
        VALUES (?, ?, ?)
      `,
      args: [noteId, tagId, Date.now()],
    });
  }
}
