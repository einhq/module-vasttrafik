import type { VtLine } from '../../lib/api.ts';

/** How light a `#rrggbb` colour looks, 0 to 1; 1 for one that does not parse, so it is never picked as the dark one. */
const lightness = (hex: string): number => {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return 1;
  const value = parseInt(match[1], 16);
  return (0.299 * ((value >> 16) & 255) + 0.587 * ((value >> 8) & 255) + 0.114 * (value & 255)) / 255;
};

/** The darker of a line's two colours, to fill a round marker that has white writing on it. */
export const darkerColour = (line: VtLine): string => lightness(line.background) <= lightness(line.foreground) ? line.background : line.foreground;
