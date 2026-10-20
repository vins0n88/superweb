// Generates the SuperWeb brand SVGs: the app icon and the horizontal wordmark.
// Style follows the SuperAI mark: a rainbow-feathered bird in flight; for
// SuperWeb the bird carries a small glowing globe instead of a spark.
//   node scripts/make-logo.mjs  →  assets/icon.svg, assets/logo.svg

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'assets');

const FEATHER_COLORS = [
  ['#5b2bd9', '#9b5cff'], // violet
  ['#1f5fff', '#4fa3ff'], // blue
  ['#0aa6c2', '#3fe0e8'], // teal
  ['#1fae4b', '#6be36b'], // green
  ['#e8a400', '#ffd84a'], // yellow
  ['#ff6a00', '#ffa34d'], // orange
  ['#e8265e', '#ff6f9c'], // pink
];

/** Leaf-shaped feather pointing along +x, length l, half-width w. */
function featherPath(l, w) {
  return `M0 0 C${l * 0.25} ${-w} ${l * 0.75} ${-w * 0.8} ${l} 0 C${l * 0.75} ${w * 0.55} ${l * 0.25} ${w * 0.75} 0 0Z`;
}

function feathers({ x, y, angles, lengths, width, colorOffset, idPrefix }) {
  return angles.map((angle, i) => {
    const color = (i + colorOffset) % FEATHER_COLORS.length;
    return `<path d="${featherPath(lengths[i], width)}" fill="url(#${idPrefix}${color})" transform="translate(${x} ${y}) rotate(${angle})"/>`;
  }).join('\n    ');
}

function gradients(idPrefix) {
  return FEATHER_COLORS.map(([dark, light], i) =>
    `<linearGradient id="${idPrefix}${i}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${dark}"/><stop offset="1" stop-color="${light}"/></linearGradient>`,
  ).join('\n    ');
}

/** The bird + globe group, drawn in a 1024 box, centred around (512, 520). */
function bird(id) {
  const p = `${id}f`;
  const backWing = feathers({
    x: 520, y: 500, idPrefix: p, colorOffset: 0, width: 34,
    angles: [-172, -158, -144, -130, -116, -102, -88],
    lengths: [300, 330, 350, 360, 350, 320, 270],
  });
  const frontWing = feathers({
    x: 545, y: 535, idPrefix: p, colorOffset: 3, width: 30,
    angles: [-165, -148, -131, -114],
    lengths: [220, 250, 255, 230],
  });
  const tail = feathers({
    x: 430, y: 610, idPrefix: p, colorOffset: 5, width: 26,
    angles: [150, 163, 176, 189],
    lengths: [190, 230, 215, 170],
  });
  return `
  <defs>
    ${gradients(p)}
    <linearGradient id="${id}body" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#3b82ff"/><stop offset="0.55" stop-color="#2546c9"/><stop offset="1" stop-color="#5b2bd9"/>
    </linearGradient>
    <radialGradient id="${id}head" cx="0.4" cy="0.35" r="0.75">
      <stop offset="0" stop-color="#5fb4ff"/><stop offset="1" stop-color="#1f4fd8"/>
    </radialGradient>
    <radialGradient id="${id}glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#7ee8ff" stop-opacity="0.9"/><stop offset="1" stop-color="#7ee8ff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="${id}globe" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#3fe0e8"/><stop offset="1" stop-color="#1f5fff"/>
    </linearGradient>
  </defs>
  <g>
    ${backWing}
    ${tail}
    <path d="M430 610 C470 520 560 470 640 455 C680 470 690 520 660 560 C610 620 520 650 430 610Z" fill="url(#${id}body)"/>
    <path d="M565 598 C578 612 590 616 604 610 M598 588 C611 602 623 606 637 600" stroke="#1b2a6b" stroke-width="11" stroke-linecap="round" fill="none"/>
    ${frontWing}
    <circle cx="655" cy="452" r="62" fill="url(#${id}head)"/>
    <path d="M700 432 L812 460 L702 478Z" fill="#14205a"/>
    <circle cx="672" cy="440" r="13" fill="#fff"/>
    <circle cx="676" cy="440" r="7" fill="#0b1236"/>
    <circle cx="866" cy="462" r="84" fill="url(#${id}glow)"/>
    <circle cx="866" cy="462" r="44" fill="url(#${id}globe)"/>
    <g fill="none" stroke="#fff" stroke-width="4.5" stroke-opacity="0.9">
      <circle cx="866" cy="462" r="44"/>
      <ellipse cx="866" cy="462" rx="18" ry="44"/>
      <path d="M822 462 H910 M829 440 H903 M829 484 H903"/>
    </g>
  </g>`;
}

const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#eeedf2"/>
    </linearGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="125%">
      <feDropShadow dx="0" dy="14" stdDeviation="18" flood-color="#000" flood-opacity="0.22"/>
    </filter>
    <clipPath id="tile"><rect x="100" y="100" width="824" height="824" rx="185"/></clipPath>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#bg)" filter="url(#shadow)"/>
  <g clip-path="url(#tile)">
    <g fill="none" stroke="#5b6cff" stroke-opacity="0.10" stroke-width="10">
      <circle cx="512" cy="512" r="330"/>
      <ellipse cx="512" cy="512" rx="140" ry="330"/>
      <path d="M182 512 H842 M219 360 H805 M219 664 H805"/>
    </g>
    <g transform="translate(512 512) scale(0.8) translate(-575 -455)">${bird('i')}
    </g>
  </g>
</svg>
`;

const logo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1400 520" width="1400" height="520">
  <defs>
    <filter id="shadow" x="-10%" y="-20%" width="120%" height="150%">
      <feDropShadow dx="0" dy="16" stdDeviation="22" flood-color="#000" flood-opacity="0.16"/>
    </filter>
  </defs>
  <rect x="60" y="60" width="1280" height="400" rx="200" fill="#f7f6f3" filter="url(#shadow)"/>
  <g transform="translate(318 270) scale(0.5) translate(-560 -500)">${bird('l')}
  </g>
  <text x="560" y="300" font-family="-apple-system, 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif"
        font-size="150" font-weight="700" letter-spacing="-3" fill="#0b0d12">SuperWeb</text>
</svg>
`;

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon.svg'), icon);
fs.writeFileSync(path.join(out, 'logo.svg'), logo);
console.log('wrote assets/icon.svg and assets/logo.svg');
