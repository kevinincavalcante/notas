/**
 * Teste manual da detecção de auto-tags por URL (sem tocar no banco).
 * Uso: npx tsx scripts/test-url-autotag.mts [url1 url2 ...]
 */
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

// Carrega .env.local ANTES dos imports dinâmicos (lib/turso lê o env no módulo)
const envPath = resolve(process.cwd(), ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i !== -1 && !process.env[t.slice(0, i).trim()]) {
      process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
}

const { extractJsonLdTypes, detectTagsForUrl } = await import("../lib/url-autotag");
const { autoTagsFromPage } = await import("../lib/auto-tags");

const urls = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.imdb.com/title/tt0111161/",
      "https://www.allrecipes.com/recipe/23600/worlds-best-lasagna/",
    ];

console.log("--- Parser JSON-LD isolado (IMDb) ---");
const res = await fetch("https://www.imdb.com/title/tt0111161/", {
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml",
  },
  signal: AbortSignal.timeout(8000),
});
const html = await res.text();
console.log("Tipos JSON-LD encontrados:", extractJsonLdTypes(html).join(", ") || "(nenhum)");

console.log("\n--- Detecção completa por URL ---");
for (const url of urls) {
  const tags = await detectTagsForUrl(url);
  console.log(`${url} → [${tags.join(", ") || "(sem tag)"}]`);
}
