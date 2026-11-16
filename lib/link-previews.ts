import { db } from "@/lib/turso";
import { isAllowedPublicUrl } from "@/lib/url-safety";

/**
 * Cache PERSISTENTE de previews de link, preenchido pelos CLIENTES.
 *
 * Motivação: o TikTok bloqueia fetch de servidor por IP (datacenter), mas
 * o DISPOSITIVO do usuário resolve o oEmbed normalmente (rede residencial/
 * 4G). O cliente reporta o que resolveu e o cache serve os outros clientes
 * (web/desktop) — e economiza re-fetchs no aparelho.
 *
 * Validação: só URL pública, título obrigatório, campos limitados em
 * tamanho (app single-user, mas o cache não pode virar lixo). A tabela
 * nasce aqui mesmo (CREATE IF NOT EXISTS) — sem migration.
 */

const TTL_MS = 12 * 60 * 60 * 1000; // 12h — CDNs de social expiram rápido

// Tabela nasce preguiçosamente (idempotente) — sem migration no deploy
let tableReady: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  if (!tableReady) {
    tableReady = db
      .execute(`CREATE TABLE IF NOT EXISTS link_previews (
        url TEXT PRIMARY KEY,
        title TEXT,
        description TEXT,
        image TEXT,
        site_name TEXT,
        fetched_at INTEGER NOT NULL
      )`)
      .then(() => undefined)
      .catch((e) => {
        tableReady = null; // falhou (ex.: rede): tenta de novo na próxima
        throw e;
      });
  }
  return tableReady;
}

export interface StoredPreview {
  title: string;
  description: string | null;
  image: string | null;
  siteName: string | null;
}

export async function getStoredPreview(url: string): Promise<StoredPreview | null> {
  try {
    await ensureTable();
    const res = await db.execute({
      sql: `SELECT title, description, image, site_name, fetched_at
            FROM link_previews WHERE url = ?`,
      args: [url],
    });
    const row = res.rows[0];
    if (!row) return null;
    if (Date.now() - Number(row.fetched_at) > TTL_MS) return null; // expirado
    return {
      title: String(row.title || ""),
      description: (row.description as string | null) ?? null,
      image: (row.image as string | null) ?? null,
      siteName: (row.site_name as string | null) ?? null,
    };
  } catch {
    return null; // tabela pode não existir ainda
  }
}

export async function storePreview(input: {
  url?: unknown;
  title?: unknown;
  description?: unknown;
  image?: unknown;
  siteName?: unknown;
}): Promise<boolean> {
  try {
    if (typeof input.url !== "string" || !isAllowedPublicUrl(input.url)) return false;
    const title = typeof input.title === "string" ? input.title.trim().slice(0, 200) : "";
    if (!title) return false; // sem título não há card útil
    const description =
      typeof input.description === "string" ? input.description.trim().slice(0, 400) || null : null;
    const image =
      typeof input.image === "string" && /^https?:\/\//.test(input.image)
        ? input.image.slice(0, 2000)
        : null;
    const siteName = typeof input.siteName === "string" ? input.siteName.trim().slice(0, 100) || null : null;
    await ensureTable();
    await db.execute({
      sql: `INSERT INTO link_previews (url, title, description, image, site_name, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(url) DO UPDATE SET
              title = excluded.title,
              description = excluded.description,
              image = excluded.image,
              site_name = excluded.site_name,
              fetched_at = excluded.fetched_at`,
      args: [input.url, title, description, image, siteName, Date.now()],
    });
    return true;
  } catch {
    return false;
  }
}
