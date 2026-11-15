// EMBERLINE v3 — make.fun threejs-fps-02 entry (Node 22, standard library only).
//
// The game lives in game/ as plain static files (three.js 0.187.0 vendored,
// ES modules, no build step). This program hands it in: it copies game/ and
// screenshots/ from beside this file into /output and writes
// /output/dossier.json with the vendored make.fun library — the summary the
// judge reads (screenshots first, then the game's source as text).
//
// v3 vs v2: the same bright Kestrel Yard 5v5, plus what the judge can see
// in a still — a team roster with combat roles (Assault / Sniper /
// Support / Anchor) under the minimap, a round-history scoreboard with an
// MVP line (Tab, or auto-open at round end), and visual depth: a lower
// sun with long shadows, a sun disc and clouds, a hazy skyline ring,
// tyre tracks and oil stains, a stacked container, a hangar antenna
// beacon and a windsock. The play shot stays the dossier cover.
//
// Serve the game locally with `node serve.ts`, then open http://localhost:8080.
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

// v2 dossier budget (measured, not a wish): four PNGs 1280x800 totalling
// ~0.43 MB (each under the 256 KiB image cap), source text ~0.15 MB
// (under the 160 KiB text cap), dossier ~0.6 MB in all — the judge sees
// the play shot first, then the full game source. Keep every new module
// inside game/src so the text budget grows with real gameplay, not filler.

import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-threejs.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

mkdirSync(out, { recursive: true });
cpSync(join(here, 'game'), join(out, 'game'), { recursive: true });
mkdirSync(join(out, 'screenshots'), { recursive: true });
if (existsSync(join(here, 'screenshots'))) {
  cpSync(join(here, 'screenshots'), join(out, 'screenshots'), { recursive: true });
}

// The gate's own caps (reference/gate.json): text_max_bytes shapes the
// dossier text; the other limits refuse an entry the scorer would refuse
// (more than 4 screenshots or one over 256 KiB; game/ over 993 files or
// 48 MiB in all — game/ counts beside /output's own 1000-entry cap, its
// screenshots/ and dossier.json).
writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, {
    text_max_bytes: 163840,
    screenshots: { max: 4, max_bytes: 262144 },
    game_max_files: 993,
    game_max_bytes: 50331648,
  }),
);
