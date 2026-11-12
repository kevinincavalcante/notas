/** Cores das notas — mesmas ids da web (types/note.ts), tints em dark mode. */

/** Fundo do bloco/card por cor da nota (tema escuro). */
export const NOTE_COLOR_BG: Record<string, string> = {
  default: "#1c1c1f",
  coral: "#3a1918",
  peach: "#3a2414",
  sand: "#3a2c10",
  mint: "#14301b",
  sage: "#123026",
  fog: "#12302f",
  storm: "#16283e",
  dusk: "#2a1a3a",
  blossom: "#381527",
  clay: "#2a2724",
  chalk: "#25282d",
};

/** Bolinha do seletor de cor. */
export const NOTE_COLOR_SWATCH: Record<string, string> = {
  default: "#52525b",
  coral: "#f87171",
  peach: "#fb923c",
  sand: "#fbbf24",
  mint: "#4ade80",
  sage: "#34d399",
  fog: "#2dd4bf",
  storm: "#60a5fa",
  dusk: "#a78bfa",
  blossom: "#f472b6",
  clay: "#a8a29e",
  chalk: "#cbd5e1",
};

export const NOTE_COLOR_IDS = Object.keys(NOTE_COLOR_BG);

export function colorBg(color: string | null | undefined): string {
  return (color && NOTE_COLOR_BG[color]) || NOTE_COLOR_BG.default;
}
