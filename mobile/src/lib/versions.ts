import { getSyncApi } from "./api";
import { getDb } from "./db";
import { syncQuiet } from "./sync";

/**
 * Histórico de versões no mobile: thin-client (igual anexos) —
 * lista/restaura direto na API com JWT. Offline, a lista cai pra
 * cópia local (o sync backfilla `note_versions` no SQLite).
 */

export interface NoteVersionItem {
  id: string;
  note_id: string;
  title: string;
  body: string;
  created_at: number;
}

/** Lista as versões da nota (API; offline usa a cópia local do sync). */
export async function fetchVersions(noteId: string): Promise<NoteVersionItem[]> {
  const api = await getSyncApi();
  if (!api) return listLocalVersions(noteId);

  try {
    const res = await fetch(`${api.baseUrl}/api/notes/${noteId}/versions`, {
      headers: { Authorization: `Bearer ${api.token}` },
    });
    if (!res.ok) throw new Error(`Falha ao buscar versões (${res.status})`);
    const data = (await res.json()) as { versions?: NoteVersionItem[] };
    return (data.versions || []) as NoteVersionItem[];
  } catch (e) {
    console.warn("Busca de versões falhou, usando cópia local:", e);
    return listLocalVersions(noteId);
  }
}

/** Cópia local (SQLite) — o sync enche `note_versions` no pull. */
async function listLocalVersions(noteId: string): Promise<NoteVersionItem[]> {
  const { client } = await getDb();
  const res = await client.execute({
    sql: `SELECT id, note_id, title, body, created_at
          FROM note_versions WHERE note_id = ?
          ORDER BY created_at DESC LIMIT 50`,
    args: [noteId],
  });
  return res.rows as unknown as NoteVersionItem[];
}

/**
 * Restaura a versão no servidor (que snapshot o estado atual antes),
 * e puxa o resultado pro SQLite local.
 */
export async function restoreVersion(noteId: string, versionId: string): Promise<void> {
  const api = await getSyncApi();
  if (!api) throw new Error("Sem sessão — conecte para restaurar");

  const url = `${api.baseUrl}/api/notes/${noteId}/versions/${versionId}/restore`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${api.token}` },
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `Falha ao restaurar (${res.status})`);
  }
  // Puxa a nota restaurada (+ snapshot que o servidor criou) pro local
  await syncQuiet(api);
}
