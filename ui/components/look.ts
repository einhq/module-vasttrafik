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

/** How many characters a stop's name on the map may take, an ellipsis included. */
const SHORT = 12;

/**
 * A stop's name short enough for its tag on the map: whole when it fits, else as many of its first
 * words as fit, else its start, each with an ellipsis after.
 */
export const shortName = (name: string): string => {
  if (name.length <= SHORT) return name;
  const words = name.split(/(?<=[\s-])/);
  let short = '';
  for (const word of words) {
    if ((short + word).trimEnd().length > SHORT - 1) break;
    short += word;
  }
  return `${(short.trimEnd() || name.slice(0, SHORT - 1)).replace(/-$/, '')}…`;
};
