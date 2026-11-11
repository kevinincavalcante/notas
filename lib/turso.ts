import { createClient } from "@libsql/client";

const url = process.env.TURSO_URL || process.env.TURSO_LINK || "";
const authToken = process.env.TURSO_TOKEN || process.env.TURSO_AUTH_TOKEN || "";

if (!url) {
  console.warn("⚠️ TURSO_URL ou TURSO_LINK não configurado no ambiente.");
}

export const db = createClient({
  url,
  authToken,
});
