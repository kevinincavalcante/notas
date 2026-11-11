export interface Attachment {
  id: string;
  note_id: string;
  storage_key: string;
  file_name: string;
  mime_type: string;
  file_size: number;
  duration_seconds?: number | null;
  created_at: number;
}

export interface NoteVersion {
  id: string;
  note_id: string;
  title: string;
  body: string;
  created_at: number;
}

export interface Note {
  id: string;
  title: string;
  body: string;
  color: string;
  is_pinned: boolean;
  is_archived: boolean;
  created_at: number;
  updated_at: number;
  attachments?: Attachment[];
  title_snippet?: string;
  body_snippet?: string;
}

export const NOTE_COLORS = [
  { id: "default", name: "Padrão", bg: "bg-white dark:bg-slate-800" },
  { id: "coral", name: "Coral", bg: "bg-red-100 dark:bg-red-950/60" },
  { id: "peach", name: "Pêssego", bg: "bg-orange-100 dark:bg-orange-950/60" },
  { id: "sand", name: "Areia", bg: "bg-amber-100 dark:bg-amber-950/60" },
  { id: "mint", name: "Menta", bg: "bg-green-100 dark:bg-green-950/60" },
  { id: "sage", name: "Sálvia", bg: "bg-emerald-100 dark:bg-emerald-950/60" },
  { id: "fog", name: "Neblina", bg: "bg-teal-100 dark:bg-teal-950/60" },
  { id: "storm", name: "Tempestade", bg: "bg-blue-100 dark:bg-blue-950/60" },
  { id: "dusk", name: "Crepúsculo", bg: "bg-purple-100 dark:bg-purple-950/60" },
  { id: "blossom", name: "Flor", bg: "bg-pink-100 dark:bg-pink-950/60" },
  { id: "clay", name: "Argila", bg: "bg-stone-200 dark:bg-stone-800" },
  { id: "chalk", name: "Giz", bg: "bg-slate-200 dark:bg-slate-700" },
];
