// The look plan, in one place. Six values and one accent hue; the lighting makes every
// shade the game needs, so no other colour appears in the code. The same six names are
// the CSS custom properties in index.html.
export const PALETTE = {
  canvas: '#14161a',
  surface: '#1e2228',
  hairline: '#2c323a',
  ink: '#e9e6df',
  muted: '#98a0a8',
  accent: '#f0a830',
};

export function shade(name) {
  return PALETTE[name];
}

// Named colour exports, so modules can import the single values they use
// without going through the whole PALETTE object each time.
export const canvas = PALETTE.canvas;
export const surface = PALETTE.surface;
export const hairline = PALETTE.hairline;
export const ink = PALETTE.ink;
export const muted = PALETTE.muted;
export const accent = PALETTE.accent;
export const teal = '#5fb8a6';
