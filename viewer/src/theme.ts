// Look and feel in one place, so the components stay about behaviour.
// Warm paper background, near-black ink, one purple accent.

import type { CSSProperties } from "react";

export const color = {
  bg: "#FAF8F4",
  card: "#FFFDFA",
  border: "#E8E3D9",
  borderStrong: "#E0DACE",
  chip: "#F4F1EA",
  chipBorder: "#E4DFD3",
  chipButton: "#EAE5DA",
  grid: "#EDE8DE",
  ink: "#1A1815",
  ink2: "#3A3730",
  muted: "#6E6A60",
  faint: "#8A8578",
  accent: "oklch(0.52 0.14 280)",
  accentDeep: "oklch(0.42 0.15 280)",
  live: "oklch(0.62 0.16 170)",
  liveText: "oklch(0.52 0.11 170)",
  warn: "oklch(0.52 0.18 25)",
};

export const sans = "Manrope, system-ui, sans-serif";
export const mono = "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace";

// One colour per station, in the order stations are listed. Same lightness and
// chroma all the way round the wheel so no line shouts louder than another.
export const SERIES = [
  "oklch(0.62 0.16 280)",
  "oklch(0.62 0.16 10)",
  "oklch(0.62 0.16 170)",
  "oklch(0.62 0.16 60)",
  "oklch(0.62 0.16 320)",
  "oklch(0.62 0.16 220)",
  "oklch(0.62 0.16 120)",
  "oklch(0.62 0.16 40)",
];

export function seriesColor(i: number): string {
  return SERIES[i % SERIES.length];
}

// How full a dock is, coloured the way the Bluebikes map does it: red when
// it's empty or nearly so, light green in the middle, dark green when full.
export const fullness = {
  empty: "oklch(0.58 0.20 25)",
  some: "oklch(0.72 0.17 145)",
  full: "oklch(0.50 0.13 152)",
};

export function fullnessColor(frac: number): string {
  if (frac <= 0.2) return fullness.empty;
  if (frac < 0.66) return fullness.some;
  return fullness.full;
}

export const card: CSSProperties = {
  background: color.card,
  border: `1px solid ${color.border}`,
  borderRadius: 18,
};

export const tabular: CSSProperties = { fontVariantNumeric: "tabular-nums" };
