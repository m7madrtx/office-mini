// The 3D company building: floors of team rooms, the executive suite on top, people at desks,
// live status, hand-off arcs between managers and reports, and a live preview for the room wizard.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const SLOT_W = 5.2, DEPTH = 5.6, WALL_H = 3.3, SLAB = 0.26, FH = WALL_H + SLAB;   // each slab rests on the walls below
const STATUS_HEX = { working: 0xff5c8a, idle: 0x2ee59d, error: 0xffa63d, done: 0x4f8cff };
const GLASSES = new Set(['rd_researcher', 'competitor_researcher', 'data_analyst', 'ux_researcher', 'legal_counsel', 'software_architect', 'finance_analyst', 'technical_writer']);
const HEADSET = new Set(['support_specialist', 'sales_executive', 'customer_success', 'email_manager']);
const SKINS = ['#F3D3B8', '#E7B98F', '#C98E62', '#9C6644', '#6B4329'];
const HAIRS = ['#1E1915', '#3A2A20', '#6B4A2F', '#B7835A', '#D9C27A', '#A7AFBF', '#7A2E3A'];
const STYLES = ['short', 'long', 'bun', 'buzz', 'curly'];

const ease = {
  outCubic: (p) => 1 - (1 - p) ** 3,
  outBack: (p) => { const c = 1.5; return 1 + (c + 1) * (p - 1) ** 3 + c * (p - 1) ** 2; },
  inOut: (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2),
};
function hash(s) { let x = 2166136261; for (const ch of String(s)) { x ^= ch.charCodeAt(0); x = Math.imul(x, 16777619); } return x >>> 0; }
export function lookFor(member) {
  if (member.look && member.look.skin) return member.look;
  const n = hash(member.name + member.specialty);
  const acc = GLASSES.has(member.specialty) ? 'glasses' : HEADSET.has(member.specialty) ? 'headset' : (/engineer/.test(member.specialty) && n % 2 ? 'headphones' : null);
  return { skin: SKINS[n % 5], hair: HAIRS[(n >> 3) % 7], style: STYLES[(n >> 6) % 5], acc };
}

// ---------------------------------------------------------------- caches
const geoCache = new Map();
const cached = new WeakSet();   // shared geometries/materials that must survive rebuilds
function rbox(w, h, d, r = 0.04) {
  const k = `${w}|${h}|${d}|${r}`;
  if (!geoCache.has(k)) {
    const geo = r > 0 ? new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2, h / 2, d / 2)) : new THREE.BoxGeometry(w, h, d);
    geoCache.set(k, geo); cached.add(geo);
  }
  return geoCache.get(k);
}
const matCache = new Map();
function std(color, o = {}) {
  const k = `${color}|${JSON.stringify(o)}`;
  if (!matCache.has(k)) { const m = new THREE.MeshStandardMaterial({ color, roughness: 0.72, metalness: 0.05, ...o }); matCache.set(k, m); cached.add(m); }
  return matCache.get(k);
}
function glow(color, intensity = 3) {
  const k = `glow|${color}|${intensity}`;
  if (!matCache.has(k)) { const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity) }); matCache.set(k, m); cached.add(m); }
  return matCache.get(k);
}
function mesh(parent, geo, mat, x = 0, y = 0, z = 0, { cast = true, receive = true } = {}) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = cast; m.receiveShadow = receive;
  parent.add(m);
  return m;
}

// ---------------------------------------------------------------- wall screens (canvas textures)
const texCache = new Map();
function screenTex(kind, accent) {
  const k = `${kind}|${accent}`;
  if (texCache.has(k)) return texCache.get(k);
  const c = document.createElement('canvas'); c.width = 512; c.height = 300;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 512, 300);
  grd.addColorStop(0, '#0d1230'); grd.addColorStop(1, '#141a42');
  g.fillStyle = grd; g.fillRect(0, 0, 512, 300);
  g.strokeStyle = accent; g.globalAlpha = 0.9;
  const pal = [accent, '#8b7cff', '#22c3ee', '#2ee59d', '#f5b544', '#ff5c8a'];
  if (kind === 'engineering') {
    for (let i = 0; i < 12; i++) {
      let x = 26 + (i % 3 === 0 ? 0 : 26 * (i % 4));
      for (let j = 0; j < 4; j++) { const w = 30 + ((i * 37 + j * 53) % 90); g.fillStyle = pal[(i + j) % pal.length]; g.globalAlpha = 0.75; g.fillRect(x, 26 + i * 21, w, 9); x += w + 10; }
    }
  } else if (kind === 'product') {
    for (let col = 0; col < 3; col++) {
      g.globalAlpha = 0.3; g.fillStyle = '#ffffff'; g.fillRect(24 + col * 162, 24, 148, 252);
      for (let n = 0; n < 3 - (col === 2 ? 1 : 0); n++) { g.globalAlpha = 0.9; g.fillStyle = pal[(col * 2 + n) % pal.length]; g.fillRect(36 + col * 162, 42 + n * 74, 124, 58); }
    }
  } else if (kind === 'research') {
    g.globalAlpha = 1; g.lineWidth = 5; g.beginPath();
    [0.8, 0.62, 0.7, 0.45, 0.5, 0.3, 0.36, 0.18].forEach((v, i, a) => { const x = 30 + (i / (a.length - 1)) * 452, y = v * 260; i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.stroke();
    g.globalAlpha = 0.35; g.fillStyle = accent;
    for (let i = 0; i < 18; i++) { g.beginPath(); g.arc(40 + ((i * 97) % 440), 40 + ((i * 61) % 220), 5 + (i % 4) * 2, 0, 7); g.fill(); }
  } else if (kind === 'design') {
    pal.concat(['#ffffff', '#ec4899']).forEach((col, i) => { g.globalAlpha = 1; g.fillStyle = col; g.fillRect(28 + (i % 4) * 118, 36 + Math.floor(i / 4) * 124, 100, 100); });
  } else if (kind === 'marketing') {
    [1, 0.78, 0.55, 0.34].forEach((w, i) => { g.globalAlpha = 0.9; g.fillStyle = pal[i]; const ww = 440 * w; g.fillRect(256 - ww / 2, 30 + i * 64, ww, 48); });
  } else if (kind === 'sales') {
    [0.35, 0.5, 0.45, 0.7, 0.62, 0.85, 0.95].forEach((v, i) => { g.globalAlpha = 0.9; g.fillStyle = i === 6 ? '#2ee59d' : accent; g.fillRect(36 + i * 66, 270 - v * 230, 44, v * 230); });
  } else if (kind === 'operations') {
    for (let i = 0; i < 6; i++) {
      g.globalAlpha = 1; g.fillStyle = i < 3 ? accent : '#3a4478'; g.beginPath(); g.arc(44, 46 + i * 42, 8, 0, 7); g.fill();
      g.globalAlpha = i < 3 ? 0.9 : 0.4; g.fillStyle = '#dfe6ff'; g.fillRect(68, 40 + i * 42, 140 + ((i * 71) % 260), 12);
    }
  } else { // executive KPIs
    g.globalAlpha = 1; g.lineWidth = 6; g.strokeStyle = '#ffd88a'; g.beginPath();
    [0.75, 0.6, 0.66, 0.42, 0.5, 0.28, 0.2].forEach((v, i, a) => { const x = 30 + (i / (a.length - 1)) * 452, y = v * 280; i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  texCache.set(k, tex);
  return tex;
}
// ---------------------------------------------------------------- room themes
function patternTex(kind) {
  const k = `pat|${kind}`;
  if (texCache.has(k)) return texCache.get(k);
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  if (kind === 'brick') {
    g.fillStyle = '#5a3a30'; g.fillRect(0, 0, 256, 256);
    for (let r = 0; r < 8; r++) for (let i = -1; i < 5; i++) {
      g.fillStyle = ['#7a4a3a', '#6e4234', '#83503e', '#734636'][(r + i + 4) % 4];
      g.fillRect(i * 64 + (r % 2) * 32 + 2, r * 32 + 2, 60, 28);
    }
  } else if (kind === 'stars') {
    g.fillStyle = '#04050d'; g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 160; i++) { g.globalAlpha = Math.random(); g.fillStyle = '#ffffff'; g.fillRect(Math.random() * 256, Math.random() * 256, Math.random() < 0.1 ? 2 : 1, Math.random() < 0.1 ? 2 : 1); }
  } else if (kind === 'wood') {
    for (let i = 0; i < 8; i++) { g.fillStyle = ['#a8865e', '#b8956a', '#9c7a52', '#b08d63'][i % 4]; g.fillRect(0, i * 32, 256, 31); }
    g.globalAlpha = 0.15; g.strokeStyle = '#000'; for (let i = 0; i < 30; i++) { g.beginPath(); const y = Math.random() * 256; g.moveTo(0, y); g.bezierCurveTo(80, y + 4, 160, y - 4, 256, y + 2); g.stroke(); }
  } else if (kind === 'stone') {
    g.fillStyle = '#2a2026'; g.fillRect(0, 0, 256, 256);
    for (let r = 0; r < 4; r++) for (let i = -1; i < 3; i++) { g.fillStyle = ['#33272e', '#2e2329', '#3a2c33'][(r + i + 3) % 3]; g.fillRect(i * 128 + (r % 2) * 64 + 3, r * 64 + 3, 122, 58); }
  } else if (kind === 'grid') {
    g.fillStyle = '#1a0b2e'; g.fillRect(0, 0, 256, 256);
    g.strokeStyle = '#ff71ce'; g.globalAlpha = 0.8; g.lineWidth = 2;
    for (let i = 0; i <= 256; i += 32) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 256); g.moveTo(0, i); g.lineTo(256, i); g.stroke(); }
  } else if (kind === 'concrete') {
    g.fillStyle = '#56585c'; g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 900; i++) { g.globalAlpha = 0.08; g.fillStyle = Math.random() < 0.5 ? '#000' : '#fff'; g.fillRect(Math.random() * 256, Math.random() * 256, 3, 3); }
  } else if (kind === 'tatami') {
    g.fillStyle = '#c9b98a'; g.fillRect(0, 0, 256, 256);
    g.strokeStyle = '#8a7a50'; g.lineWidth = 6; g.strokeRect(3, 3, 122, 250); g.strokeRect(131, 3, 122, 122); g.strokeRect(131, 131, 122, 122);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4;
  texCache.set(k, t);
  return t;
}

export const THEMES = {
  modern:     { wall: '#181c38', floor: '#171a32', desk: '#e2e4ef', chair: '#1b1e33', wash: 0.22 },
  neon:       { wall: '#0c0a1d', floor: '#0e0b22', desk: '#1c1a32', chair: '#140f26', wash: 0.5, floorGlow: true },
  gaming:     { wall: '#121218', floor: '#15151c', desk: '#1d1d26', chair: '#e11d48', wash: 0.3, rgb: true },
  gothic:     { wall: '#ffffff', wallMap: 'stone', floor: '#2a1c22', desk: '#3b2a22', chair: '#3a1d27', wash: 0.35, washColor: '#7e1f3a' },
  zen:        { wall: '#d8ccb4', floor: '#ffffff', floorMap: 'tatami', desk: '#c8a77e', chair: '#5b4a3a', wash: 0.08 },
  retro:      { wall: '#2b1145', floor: '#ffffff', floorMap: 'grid', desk: '#f2e7ff', chair: '#01cdfe', wash: 0.4, washColor: '#ff71ce' },
  industrial: { wall: '#ffffff', wallMap: 'brick', floor: '#ffffff', floorMap: 'concrete', desk: '#7a5a3a', chair: '#222428', wash: 0.12 },
  space:      { wall: '#ffffff', wallMap: 'stars', floor: '#0f1428', desk: '#c9d1e8', chair: '#2a3350', wash: 0.3, washColor: '#4f8cff' },
};
let APPEARANCE = 'dark';
const MODERN_LIGHT = { wall: '#f4f5fa', floor: '#cdd3e4', desk: '#ffffff', chair: '#3b3f5c', wash: 0.14 };
const themeOf = (id) => (APPEARANCE === 'light' && (!id || id === 'modern') ? MODERN_LIGHT : THEMES[id] || THEMES.modern);
function themeMat(color, map, repeat = [2, 1], o = {}) {
  const k = `theme|${color}|${map}|${repeat}|${JSON.stringify(o)}`;
  if (!matCache.has(k)) {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.02, ...o });
    if (map) { const t = patternTex(map).clone(); t.needsUpdate = true; t.repeat.set(...repeat); m.map = t; }
    matCache.set(k, m); cached.add(m);
  }
  return matCache.get(k);
}

// Theme decorations: each returns per-frame updaters for animated bits
function themeDecor(g, theme, w, accent) {
  const fx = [];
  const backZ = -DEPTH / 2 + 0.2;
  if (theme === 'neon') {
    const colors = ['#ff2bd6', '#22e5ff', accent];
    colors.forEach((c, i) => { const tube = mesh(g, rbox(0.9 - i * 0.2, 0.05, 0.05, 0.02), glow(c, 3.5), -w / 2 + 0.9, 2.75 - i * 0.22, backZ, { cast: false }); tube.rotation.z = i % 2 ? 0.12 : -0.08; });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.03, 8, 40), glow('#ff2bd6', 3.2)); ring.position.set(w / 2 - 0.9, 2.5, backZ); g.add(ring);
    fx.push((t) => { ring.material.color.setRGB(3 * (0.6 + 0.4 * Math.sin(t * 3)), 0.5, 2.6); });
  } else if (theme === 'gaming') {
    const strip = new THREE.MeshBasicMaterial({ color: 0xffffff });
    mesh(g, rbox(w - 0.3, 0.04, 0.04, 0), strip, 0, 0.08, backZ, { cast: false });
    mesh(g, rbox(w - 0.3, 0.04, 0.04, 0), strip, 0, WALL_H - 0.12, backZ, { cast: false });
    ['#7c3aed', '#ef4444', '#22c55e'].forEach((c, i) => mesh(g, rbox(0.55, 0.78, 0.02, 0.01), std(c, { emissive: c, emissiveIntensity: 0.35 }), -w / 2 + 0.8 + i * 0.7, 2.25, backZ, { cast: false }));
    const bag = new THREE.Mesh(new THREE.SphereGeometry(0.42, 20, 14), std('#7c3aed', { roughness: 0.9 })); bag.scale.set(1, 0.55, 1); bag.position.set(w / 2 - 0.7, 0.24, -DEPTH / 2 + 1.1); bag.castShadow = true; g.add(bag);
    fx.push((t) => { strip.color.setHSL((t * 0.12) % 1, 1, 0.55).multiplyScalar(2.6); });
  } else if (theme === 'gothic') {
    for (const x of [-w / 4, w / 4]) {
      mesh(g, rbox(0.9, 1.5, 0.06, 0.02), std('#100a0e'), x, 2.0, backZ, { cast: false });
      const arch = new THREE.Mesh(new THREE.CircleGeometry(0.45, 24, 0, Math.PI), std('#100a0e')); arch.position.set(x, 2.75, backZ); g.add(arch);
      mesh(g, rbox(0.72, 1.3, 0.01, 0), glow('#7c2d92', 0.9), x, 1.98, backZ + 0.035, { cast: false });
    }
    const flames = [];
    for (const x of [-w / 2 + 0.45, w / 2 - 0.45]) {
      mesh(g, new THREE.CylinderGeometry(0.03, 0.12, 1.3, 10), std('#2a2024', { metalness: 0.7, roughness: 0.35 }), x, 0.65, -DEPTH / 2 + 0.55);
      for (const dx of [-0.12, 0, 0.12]) {
        mesh(g, new THREE.CylinderGeometry(0.03, 0.03, 0.18, 8), std('#efe6d2'), x + dx, 1.38, -DEPTH / 2 + 0.55);
        const f = mesh(g, new THREE.ConeGeometry(0.03, 0.09, 8), glow('#ffb347', 3.2), x + dx, 1.52, -DEPTH / 2 + 0.55, { cast: false });
        flames.push(f);
      }
    }
    fx.push((t) => flames.forEach((f, i) => { f.scale.y = 0.8 + 0.35 * Math.abs(Math.sin(t * 9 + i * 1.7)); }));
  } else if (theme === 'zen') {
    for (let i = 0; i < 5; i++) mesh(g, new THREE.CylinderGeometry(0.035, 0.035, 2.6 + (i % 2) * 0.4, 8), std('#7d9a52'), -w / 2 + 0.35 + i * 0.12, 1.35, -DEPTH / 2 + 0.4);
    const lanterns = [];
    for (const x of [-0.6, 0.9]) { const l = mesh(g, new THREE.SphereGeometry(0.2, 18, 14), glow('#ffd9a0', 1.4), x, WALL_H - 0.55, 0.4, { cast: false }); l.scale.y = 1.25; lanterns.push(l); }
    mesh(g, rbox(0.5, 0.12, 0.3, 0.03), std('#3b2f25'), w / 2 - 0.55, 0.9, -DEPTH / 2 + 0.4);
    fx.push((t) => lanterns.forEach((l, i) => { l.position.y = WALL_H - 0.55 + Math.sin(t * 0.8 + i) * 0.03; }));
  } else if (theme === 'retro') {
    const c = document.createElement('canvas'); c.width = 256; c.height = 160;
    const x = c.getContext('2d');
    const grd = x.createLinearGradient(0, 0, 0, 160); grd.addColorStop(0, '#ffde59'); grd.addColorStop(1, '#ff2bd6');
    x.fillStyle = '#2b1145'; x.fillRect(0, 0, 256, 160); x.fillStyle = grd; x.beginPath(); x.arc(128, 120, 80, Math.PI, 0); x.fill();
    x.fillStyle = '#2b1145'; for (let i = 0; i < 6; i++) x.fillRect(0, 70 + i * 9, 256, 2 + i);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const sun = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.95), new THREE.MeshBasicMaterial({ map: tex })); sun.material.color.setScalar(1.3); sun.position.set(-w / 2 + 1.1, 2.3, backZ + 0.01); g.add(sun);
    mesh(g, rbox(w - 0.3, 0.035, 0.035, 0), glow('#01cdfe', 3), 0, WALL_H - 0.1, backZ, { cast: false });
  } else if (theme === 'industrial') {
    for (const z of [-0.8, 0.9]) { const pipe = mesh(g, new THREE.CylinderGeometry(0.06, 0.06, w - 0.2, 12), std('#8a8f96', { metalness: 0.8, roughness: 0.35 }), 0, WALL_H - 0.2, z); pipe.rotation.z = Math.PI / 2; }
    for (const x of [-1, 0.2, 1.4]) {
      mesh(g, new THREE.CylinderGeometry(0.006, 0.006, 0.7, 6), std('#111'), x, WALL_H - 0.45, 0.3, { cast: false });
      mesh(g, new THREE.SphereGeometry(0.07, 12, 10), glow('#ffb46b', 2.6), x, WALL_H - 0.85, 0.3, { cast: false });
    }
  } else if (theme === 'space') {
    const port = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.07, 12, 40), std('#9aa4c0', { metalness: 0.8, roughness: 0.3 })); port.position.set(-w / 2 + 1.2, 2.1, backZ + 0.02); g.add(port);
    const planet = new THREE.Mesh(new THREE.SphereGeometry(0.3, 24, 18), std('#4f8cff', { emissive: '#1d3d88', emissiveIntensity: 0.6 })); planet.position.set(-w / 2 + 1.2, 2.1, backZ - 0.2); g.add(planet);
    const holo = new THREE.Mesh(new THREE.IcosahedronGeometry(0.28, 1), new THREE.MeshBasicMaterial({ color: new THREE.Color('#22e5ff').multiplyScalar(2), wireframe: true }));
    holo.position.set(w / 2 - 0.75, 1.35, -DEPTH / 2 + 0.9); g.add(holo);
    mesh(g, new THREE.CylinderGeometry(0.25, 0.3, 0.9, 20), std('#2a3350', { metalness: 0.6, roughness: 0.3 }), w / 2 - 0.75, 0.45, -DEPTH / 2 + 0.9);
    fx.push((t) => { holo.rotation.y = t * 0.8; holo.rotation.x = t * 0.3; planet.rotation.y = t * 0.2; });
  }
  return fx;
}

function washTex(accent) {
  const k = `wash|${accent}`;
  if (texCache.has(k)) return texCache.get(k);
  const c = document.createElement('canvas'); c.width = 4; c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 128, 0, 0);
  grd.addColorStop(0, accent); grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 4, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  texCache.set(k, t);
  return t;
}

// ---------------------------------------------------------------- people
function makePerson(member, accent, th = THEMES.modern) {
  const look = lookFor(member);
  const g = new THREE.Group();
  const shirt = new THREE.MeshStandardMaterial({ color: member.color, roughness: 0.6, metalness: 0.05, emissive: new THREE.Color(member.color), emissiveIntensity: 0 });
  const skin = std(look.skin, { roughness: 0.55 });
  const hair = std(look.hair, { roughness: 0.8 });
  const pants = std('#262a45');
  // chair (gaming rooms get racing chairs)
  mesh(g, rbox(0.56, 0.08, 0.54, 0.03), std(th.chair), 0, 0.45, -0.02);
  mesh(g, rbox(0.56, th.rgb ? 0.95 : 0.62, 0.08, 0.04), std(th.chair), 0, th.rgb ? 0.98 : 0.82, -0.3);
  if (th.rgb) mesh(g, rbox(0.2, 0.9, 0.09, 0.02), std('#111'), 0, 1.0, -0.3);
  mesh(g, rbox(0.07, 0.42, 0.07, 0.02), std('#2a2e48', { metalness: 0.6, roughness: 0.3 }), 0, 0.22, -0.02);
  // body
  mesh(g, rbox(0.44, 0.16, 0.5, 0.05), pants, 0, 0.56, 0.14);
  mesh(g, rbox(0.42, 0.44, 0.15, 0.05), pants, 0, 0.3, 0.41);
  const torso = mesh(g, rbox(0.5, 0.58, 0.32, 0.09), shirt, 0, 0.92, -0.04);
  const head = new THREE.Group(); head.position.set(0, 1.46, -0.03); g.add(head);
  mesh(head, rbox(0.42, 0.42, 0.4, 0.1), skin);
  const eyes = [-0.095, 0.095].map((x) => mesh(head, rbox(0.06, 0.07, 0.02, 0.01), std('#121318'), x, 0.02, 0.205, { cast: false }));
  // hair styles
  if (look.style === 'buzz') mesh(head, rbox(0.43, 0.06, 0.41, 0.03), hair, 0, 0.21, 0);
  else if (look.style === 'curly') {
    for (let i = 0; i < 6; i++) { const s = new THREE.Mesh(new THREE.IcosahedronGeometry(0.105, 1), hair); s.position.set(-0.15 + (i % 3) * 0.15, 0.22 + (i > 2 ? 0 : 0.03), i > 2 ? -0.1 : 0.06); s.castShadow = true; head.add(s); }
  } else {
    mesh(head, rbox(0.45, 0.12, 0.43, 0.05), hair, 0, 0.23, -0.005);
    mesh(head, rbox(0.45, look.style === 'long' ? 0.46 : 0.2, 0.1, 0.04), hair, 0, look.style === 'long' ? 0.02 : 0.12, -0.19);
    if (look.style === 'long') { mesh(head, rbox(0.06, 0.34, 0.32, 0.03), hair, -0.215, 0.06, -0.05); mesh(head, rbox(0.06, 0.34, 0.32, 0.03), hair, 0.215, 0.06, -0.05); }
    if (look.style === 'bun') { const b = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 12), hair); b.position.set(0, 0.33, -0.12); b.castShadow = true; head.add(b); }
  }
  // accessories
  const dark = std('#15161f', { roughness: 0.3, metalness: 0.5 });
  if (look.acc === 'glasses') {
    for (const x of [-0.095, 0.095]) { const f = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.012, 6, 18), dark); f.position.set(x, 0.02, 0.215); head.add(f); }
    mesh(head, rbox(0.06, 0.012, 0.012, 0), dark, 0, 0.03, 0.215, { cast: false });
  } else if (look.acc === 'headset' || look.acc === 'headphones') {
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.235, 0.022, 8, 24, Math.PI), dark);
    band.position.set(0, 0.04, 0); band.rotation.z = 0; head.add(band);
    for (const x of [-0.225, 0.225]) { const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.06, 16), look.acc === 'headphones' ? std(member.color) : dark); cup.rotation.z = Math.PI / 2; cup.position.set(x, 0.0, 0); head.add(cup); }
    if (look.acc === 'headset') mesh(head, rbox(0.16, 0.02, 0.02, 0), dark, -0.16, -0.12, 0.13, { cast: false }).rotation.y = -0.7;
  }
  const arms = [-1, 1].map((side) => {
    const pivot = new THREE.Group(); pivot.position.set(side * 0.32, 1.13, -0.03); g.add(pivot);
    mesh(pivot, rbox(0.14, 0.44, 0.14, 0.06), shirt, 0, -0.19, 0);
    mesh(pivot, rbox(0.12, 0.1, 0.12, 0.05), skin, 0, -0.43, 0);
    pivot.rotation.x = -1.15;
    return pivot;
  });
  // status ring (glows through bloom)
  const ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(STATUS_HEX.idle).multiplyScalar(2.2) });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.026, 8, 40), ringMat);
  ring.position.set(0, 2.08, -0.03); ring.rotation.x = -Math.PI / 2 + 0.35; g.add(ring);
  const arc = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.034, 8, 40, Math.PI * 1.35), new THREE.MeshBasicMaterial({ color: new THREE.Color(STATUS_HEX.working).multiplyScalar(2.6) }));
  arc.position.copy(ring.position); arc.rotation.copy(ring.rotation); arc.visible = false; g.add(arc);
  // selection halo on the floor
  const halo = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.5, 48), new THREE.MeshBasicMaterial({ color: new THREE.Color(accent).multiplyScalar(2.5), transparent: true, opacity: 0, depthWrite: false }));
  halo.rotation.x = -Math.PI / 2; halo.position.set(0, 0.04, 0.05); g.add(halo);
  g.traverse((o) => { if (o.isMesh) o.userData.empId = member.id; });
  return { group: g, torso, head, arms, eyes, ring, arc, halo, shirt, phase: Math.random() * 10, blinkAt: 1 + Math.random() * 4, status: 'idle', statusAt: 0, task: '' };
}

// ---------------------------------------------------------------- furniture
function desk(parent, w, x, z, th = THEMES.modern) {
  mesh(parent, rbox(w, 0.06, 0.66, 0.03), std(th.desk, { roughness: 0.45 }), x, 0.75, z);
  for (const s of [-1, 1]) mesh(parent, rbox(0.05, 0.72, 0.58, 0.02), std('#2b2f4a', { metalness: 0.4, roughness: 0.4 }), x + s * (w / 2 - 0.08), 0.37, z);
  mesh(parent, rbox(w - 0.2, 0.3, 0.03, 0.01), std('#2b2f4a'), x, 0.58, z + 0.24);
}
function laptop(parent, x, z, accent) {
  mesh(parent, rbox(0.42, 0.02, 0.3, 0.01), std('#c7cbe0', { metalness: 0.7, roughness: 0.3 }), x, 0.79, z);
  const lid = mesh(parent, rbox(0.42, 0.28, 0.015, 0.01), std('#c7cbe0', { metalness: 0.7, roughness: 0.3 }), x, 0.93, z + 0.15);
  lid.rotation.x = 0.28;
  const logo = mesh(parent, new THREE.CircleGeometry(0.035, 20), glow(accent, 2.4), x, 0.935, z + 0.16, { cast: false, receive: false });
  logo.rotation.x = 0.28;
}
function plant(parent, x, z, s = 1) {
  mesh(parent, new THREE.CylinderGeometry(0.17 * s, 0.13 * s, 0.36 * s, 20), std('#e9e5dc', { roughness: 0.9 }), x, 0.18 * s, z);
  for (const [dx, dy, dz, r] of [[0, 0.62, 0, 0.24], [0.13, 0.82, 0.04, 0.17], [-0.12, 0.78, -0.05, 0.18], [0.02, 0.98, -0.02, 0.13]]) {
    const leaf = new THREE.Mesh(new THREE.IcosahedronGeometry(r * s, 1), std('#2fbf7a', { roughness: 0.65 }));
    leaf.position.set(x + dx * s, dy * s, z + dz * s); leaf.castShadow = true; parent.add(leaf);
  }
}
function wallScreen(parent, kind, accent, w, h, x, y, z) {
  mesh(parent, rbox(w + 0.08, h + 0.08, 0.05, 0.03), std('#07080f', { roughness: 0.3, metalness: 0.4 }), x, y, z, { cast: false });
  const m = new THREE.MeshBasicMaterial({ map: screenTex(kind, accent) });
  m.color.setScalar(1.15);
  const s = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
  s.position.set(x, y, z + 0.03); parent.add(s);
}
function divisionProp(parent, division, accent, x, z) {
  if (division === 'engineering') { // server rack
    mesh(parent, rbox(0.6, 1.7, 0.6, 0.04), std('#141729', { metalness: 0.5, roughness: 0.35 }), x, 0.85, z);
    for (let i = 0; i < 6; i++) mesh(parent, rbox(0.46, 0.02, 0.01, 0), glow(i % 2 ? accent : '#2ee59d', 2.2), x, 0.35 + i * 0.22, z + 0.305, { cast: false });
  } else if (division === 'research') { // bookshelf
    mesh(parent, rbox(0.9, 1.7, 0.36, 0.03), std('#2a2440'), x, 0.85, z);
    const cols = ['#8b7cff', '#22c3ee', '#f5b544', '#ff5c8a', '#2ee59d'];
    for (let r = 0; r < 3; r++) for (let i = 0; i < 6; i++) mesh(parent, rbox(0.1, 0.3 + (i % 3) * 0.04, 0.24, 0.01), std(cols[(r + i) % 5]), x - 0.3 + i * 0.12, 0.38 + r * 0.5 + (i % 3) * 0.02, z + 0.02);
  } else if (division === 'design') { // easel
    for (const s of [-1, 1]) { const leg = mesh(parent, rbox(0.04, 1.6, 0.04, 0.01), std('#b08968'), x + s * 0.25, 0.8, z); leg.rotation.z = s * -0.12; }
    const board = mesh(parent, rbox(0.8, 0.95, 0.04, 0.02), std('#f4f4f6'), x, 1.15, z + 0.06); board.rotation.x = -0.1;
    mesh(parent, rbox(0.5, 0.5, 0.01, 0), glow(accent, 1.2), x, 1.18, z + 0.09, { cast: false }).rotation.x = -0.1;
  } else if (division === 'marketing') { // megaphone stand
    mesh(parent, new THREE.CylinderGeometry(0.03, 0.03, 1.1, 10), std('#2b2f4a'), x, 0.55, z);
    const cone = mesh(parent, new THREE.ConeGeometry(0.22, 0.5, 24, 1, true), std(accent, { side: THREE.DoubleSide }), x, 1.25, z + 0.1);
    cone.rotation.x = Math.PI / 2 + 0.3;
  } else if (division === 'sales') { // trophy
    mesh(parent, rbox(0.5, 0.9, 0.5, 0.04), std('#1d2036'), x, 0.45, z);
    mesh(parent, new THREE.CylinderGeometry(0.16, 0.06, 0.28, 20), std('#f5b544', { metalness: 0.9, roughness: 0.2 }), x, 1.12, z);
    mesh(parent, new THREE.CylinderGeometry(0.09, 0.12, 0.06, 16), std('#f5b544', { metalness: 0.9, roughness: 0.2 }), x, 0.93, z);
  } else if (division === 'product') { // standing board
    mesh(parent, rbox(1.1, 1.3, 0.05, 0.02), std('#f4f4f6'), x, 1.2, z);
    ['#8b7cff', '#f5b544', '#2ee59d', '#ff5c8a', '#22c3ee'].forEach((c, i) => mesh(parent, rbox(0.22, 0.18, 0.01, 0), std(c), x - 0.36 + (i % 3) * 0.36, 1.45 - Math.floor(i / 3) * 0.35, z + 0.035, { cast: false }));
    for (const s of [-1, 1]) mesh(parent, rbox(0.04, 0.6, 0.04, 0.01), std('#2b2f4a'), x + s * 0.45, 0.3, z);
  } else { // operations: filing cabinet
    mesh(parent, rbox(0.55, 1.1, 0.5, 0.04), std('#20243c', { metalness: 0.4, roughness: 0.4 }), x, 0.55, z);
    for (let i = 0; i < 3; i++) mesh(parent, rbox(0.18, 0.03, 0.02, 0.01), glow(accent, 1.6), x, 0.25 + i * 0.33, z + 0.26, { cast: false });
  }
}

// ---------------------------------------------------------------- the scene
export function createScene(container, handlers) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  const mobile = Math.min(window.innerWidth, window.innerHeight) < 600;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, mobile ? 1.6 : 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = false;   // shadows removed: they showed as glitchy artifacts on the small, stacked rooms
  container.appendChild(renderer.domElement);
  const labels = new CSS2DRenderer();
  labels.domElement.className = 'labels';
  container.appendChild(labels.domElement);

  const scene = new THREE.Scene();
  const bg = document.createElement('canvas'); bg.width = 2; bg.height = 512;
  { const g = bg.getContext('2d'); const grd = g.createLinearGradient(0, 0, 0, 512); grd.addColorStop(0, '#0b0e22'); grd.addColorStop(0.55, '#070915'); grd.addColorStop(1, '#040509'); g.fillStyle = grd; g.fillRect(0, 0, 2, 512); }
  const bgTex = new THREE.CanvasTexture(bg); bgTex.colorSpace = THREE.SRGBColorSpace;
  scene.background = bgTex;
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.32;

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -200, 400);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.minZoom = 0.55; controls.maxZoom = 4.5;
  controls.minAzimuthAngle = -Infinity; controls.maxAzimuthAngle = Infinity;   // full 360° orbit
  controls.minPolarAngle = 0.55; controls.maxPolarAngle = 1.45;
  controls.screenSpacePanning = true;
  controls.zoomToCursor = true;

  const hemi = new THREE.HemisphereLight(0xa8b4ff, 0x0b0d18, 0.75);
  const key = new THREE.DirectionalLight(0xfff1e2, 1.7);
  key.position.set(9, 24, 16); key.castShadow = false;
  const rim = new THREE.DirectionalLight(0x6a7bff, 0.9); rim.position.set(-14, 10, -12);
  scene.add(hemi, key, key.target, rim);

  // ground: soft glow + faint grid
  const gc = document.createElement('canvas'); gc.width = gc.height = 256;
  { const g = gc.getContext('2d'); const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128); grd.addColorStop(0, 'rgba(70,80,190,0.55)'); grd.addColorStop(0.5, 'rgba(40,46,120,0.18)'); grd.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = grd; g.fillRect(0, 0, 256, 256); }
  const gTex = new THREE.CanvasTexture(gc); gTex.colorSpace = THREE.SRGBColorSpace;
  const groundGlow = new THREE.Mesh(new THREE.PlaneGeometry(34, 34), new THREE.MeshBasicMaterial({ map: gTex, transparent: true, depthWrite: false }));
  groundGlow.rotation.x = -Math.PI / 2; groundGlow.position.y = -0.3; scene.add(groundGlow);
  const grid = new THREE.GridHelper(80, 80, 0x232a66, 0x151a40);
  grid.material.transparent = true; grid.material.opacity = 0.45; grid.position.y = -0.31; scene.add(grid);
  const shadowCatcher = { material: {} };   // kept as a stub so appearance switching stays simple

  // drifting particles
  const PN = 240, pPos = new Float32Array(PN * 3), pSpeed = new Float32Array(PN);
  for (let i = 0; i < PN; i++) { pPos[i * 3] = (Math.random() - 0.5) * 30; pPos[i * 3 + 1] = Math.random() * 26 - 1; pPos[i * 3 + 2] = (Math.random() - 0.5) * 22; pSpeed[i] = 0.08 + Math.random() * 0.25; }
  const pGeo = new THREE.BufferGeometry(); pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  const particles = new THREE.Points(pGeo, new THREE.PointsMaterial({ color: 0x9aa8ff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0.45, depthWrite: false, blending: THREE.AdditiveBlending }));
  scene.add(particles);

  // post-processing
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.75, 0.55, 1.0);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // ---------------------------------------------------------------- state
  let building = new THREE.Group(); scene.add(building);
  let labelObjs = [];
  const persons = new Map();      // empId -> person
  let pickables = [];
  let walls = [];                 // exterior walls that fade when they face the camera
  let bounds = new THREE.Box3();
  let known = new Set();          // room ids already shown (for build-in animation)
  let firstBuild = true;
  let lastDraftKey = '';
  const tweens = [];
  let hovered = null, selected = null, focusRoomId = null;
  const insets = { right: 0, bottom: 0, left: 0 };
  const view = { h: 20 };
  let goal = null;
  const effects = [];   // hand-off arcs (survive rebuilds)
  const buildFx = [];   // pulses tied to the current build
  const clock = new THREE.Clock();

  function tween(fn, { delay = 0, dur = 600, curve = ease.outCubic } = {}) {
    tweens.push({ fn, start: performance.now() + delay, dur, curve });
    fn(0);
  }
  function label(el, x, y, z, parent = building) {
    const o = new CSS2DObject(el); o.position.set(x, y, z); parent.add(o); labelObjs.push(o); return o;
  }

  // ---------------------------------------------------------------- layout (mirrors the server's placement rules)
  function layout(org, draft) {
    const team = org.rooms.filter((r) => r.kind === 'team' && (!draft || r.id !== draft.roomId));
    const occ = new Map(team.map((r) => [`${r.floor}-${r.slot}`, { room: r, members: org.employees.filter((e) => e.room_id === r.id) }]));
    let F = Math.max(-1, ...team.map((r) => r.floor)) + 1;
    let draftPos = null;
    if (draft && !draft.exec) {
      const p = draft.placement || {};
      const orig = draft.roomId ? org.rooms.find((r) => r.id === draft.roomId) : null;
      const free = (f, s) => !occ.has(`${f}-${s}`);
      if (p.floor === 'keep' && orig && free(orig.floor, orig.slot)) draftPos = [orig.floor, orig.slot];
      else if (p.floor === 'new') draftPos = [F, 0];
      else if (Number.isInteger(p.floor)) {
        if ([0, 1].includes(p.slot) && free(p.floor, p.slot)) draftPos = [p.floor, p.slot];
        else draftPos = free(p.floor, 0) ? [p.floor, 0] : free(p.floor, 1) ? [p.floor, 1] : [F, 0];
      } else {
        for (let f = 0; f < F && !draftPos; f++) for (const s of [0, 1]) if (!draftPos && free(f, s)) draftPos = [f, s];
        draftPos = draftPos || [F, 0];
      }
      occ.set(`${draftPos[0]}-${draftPos[1]}`, { room: { ...draft.room, id: draft.roomId || '__draft', kind: 'team' }, members: draft.members, preview: true });
      F = Math.max(F, draftPos[0] + 1);
    }
    const ghosts = [];
    if (!draft) {
      for (let f = 0; f < F; f++) for (const s of [0, 1]) if (!occ.has(`${f}-${s}`)) ghosts.push({ floor: f, slot: s });
    }
    const newFloor = !draft && ghosts.length === 0;
    const execRoom = org.rooms.find((r) => r.kind === 'exec');
    const exec = draft?.exec ? { room: { ...execRoom, ...draft.room }, members: draft.members, preview: true }
      : { room: execRoom, members: org.employees.filter((e) => e.room_id === execRoom.id) };
    // the executive suite always rests directly on the top team floor (new floors are added from "Add room")
    return { occ, F, ghosts, newFloor, exec, execFloor: Math.max(F, 0), draftKey: draft ? `${draft.roomId}|${draftPos}|${draft.room.desks}|${draft.room.per_desk}` : '' };
  }

  // ---------------------------------------------------------------- build
  function clear() {
    for (const o of labelObjs) o.element.remove();
    labelObjs = [];
    scene.remove(building);
    building.traverse((o) => {
      if (!(o.isMesh || o.isLine)) return;
      if (!cached.has(o.geometry)) o.geometry.dispose();
      if (!cached.has(o.material) && !o.material.map?.isCanvasTexture) o.material.dispose();
    });
    building = new THREE.Group(); scene.add(building);
    persons.clear(); pickables = []; walls = [];
  }

  // A room: slab, themed floor, four walls (exterior ones fade when they face the camera), neon trim, decor
  function shell(g, w, accent, themeId, { slot = null, exec = false } = {}) {
    const th = themeOf(themeId);
    mesh(g, rbox(w, 0.26, DEPTH, 0.02), std(APPEARANCE === 'light' ? '#7d86a8' : '#11142a', { roughness: 0.85 }), 0, -0.13, 0, { cast: false });
    mesh(g, rbox(w - 0.06, 0.02, DEPTH - 0.06, 0), themeMat(th.floor, th.floorMap, [w / 2, DEPTH / 2], { roughness: 0.6 }), 0, 0.01, 0, { cast: false });
    const wallMat = () => { const m = themeMat(th.wall, th.wallMap, [w / 2.5, 1.4]).clone(); m.transparent = true; return m; };
    const sideMat = () => { const m = themeMat(th.wall, th.wallMap, [DEPTH / 2.5, 1.4]).clone(); m.transparent = true; return m; };
    const addWall = (geo, mat, x, z, nx, nz, extras = []) => {
      const m = mesh(g, geo, mat, x, WALL_H / 2, z, { cast: false });
      walls.push({ mesh: m, mat, nx, nz, op: 1, extras });
    };
    const wash = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.1, WALL_H * 0.75), new THREE.MeshBasicMaterial({ map: washTex(th.washColor || accent), transparent: true, opacity: th.wash, depthWrite: false, blending: THREE.AdditiveBlending }));
    wash.position.set(0, WALL_H * 0.375, -DEPTH / 2 + 0.15); g.add(wash);
    addWall(new THREE.BoxGeometry(w, WALL_H, 0.12), wallMat(), 0, -DEPTH / 2 + 0.06, 0, -1, [wash]);
    addWall(new THREE.BoxGeometry(w, WALL_H, 0.12), wallMat(), 0, DEPTH / 2 - 0.06, 0, 1);
    const exteriorLeft = exec || slot === 0, exteriorRight = exec || slot === 1;
    if (exteriorLeft) addWall(new THREE.BoxGeometry(0.12, WALL_H, DEPTH), sideMat(), -w / 2 + 0.06, 0, -1, 0);
    if (exteriorRight) addWall(new THREE.BoxGeometry(0.12, WALL_H, DEPTH), sideMat(), w / 2 - 0.06, 0, 1, 0);
    if (slot === 1) { // glass between neighbouring rooms
      const glass = new THREE.Mesh(new THREE.BoxGeometry(0.03, WALL_H, DEPTH - 0.2), new THREE.MeshPhysicalMaterial({ color: 0x9fb0ff, transparent: true, opacity: 0.07, roughness: 0.1, metalness: 0, depthWrite: false }));
      glass.position.set(-w / 2, WALL_H / 2, 0); g.add(glass);
    }
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) mesh(g, rbox(0.035, WALL_H, 0.035, 0), glow(accent, 1.5), sx * (w / 2 - 0.02), WALL_H / 2, sz * (DEPTH / 2 - 0.02), { cast: false });
    for (const sz of [-1, 1]) {
      mesh(g, rbox(w, 0.035, 0.035, 0), glow(accent, 3.2), 0, 0.02, sz * DEPTH / 2, { cast: false, receive: false });
      mesh(g, rbox(w, 0.03, 0.03, 0), glow(accent, 1.4), 0, -0.26, sz * DEPTH / 2, { cast: false, receive: false });
    }
    mesh(g, rbox(w * 0.6, 0.03, 0.18, 0.01), glow(themeId === 'zen' ? '#ffe2b0' : '#cfd6ff', 1.6), 0, WALL_H - 0.04, 0.3, { cast: false, receive: false });
    if (th.floorGlow) for (let i = -2; i <= 2; i++) mesh(g, rbox(w - 0.3, 0.005, 0.02, 0), glow(i % 2 ? '#ff2bd6' : '#22e5ff', 1.8), 0, 0.025, i * 1.05, { cast: false, receive: false });
    for (const f of themeDecor(g, themeId, w, accent)) buildFx.push({ update: f });
    return th;
  }

  function seatPositions(desks, per) {
    const rowsZ = { 1: [1.05], 2: [1.55, -0.25], 3: [1.95, 0.6, -0.75] }[desks];
    const spacing = per >= 4 ? 0.98 : 1.08;
    const out = [];
    rowsZ.forEach((z, d) => { for (let s = 0; s < per; s++) out.push({ desk: d, seat: s, x: (s - (per - 1) / 2) * spacing, z, w: per * spacing + 0.15 }); });
    return out;
  }

  function teamRoom(entry, x0, y, slot, animate) {
    const { room, members, preview } = entry;
    const accent = room.accent || '#8b7cff';
    const g = new THREE.Group(); g.position.set(x0 + SLOT_W / 2, y, 0);
    const inner = new THREE.Group(); g.add(inner);
    building.add(g);
    const th = shell(inner, SLOT_W, accent, room.theme, { slot });
    const desks = room.desks || 1, per = room.per_desk || 1;
    const rugD = desks === 1 ? 1.9 : desks === 2 ? 3.3 : 4.4;
    const rug = mesh(inner, rbox(Math.min(SLOT_W - 0.6, per * 1.1 + 0.8), 0.02, rugD, 0.01), std(accent, { roughness: 0.95, emissive: accent, emissiveIntensity: 0.12 }), 0.15, 0.025, desks === 1 ? 0.8 : desks === 2 ? 0.65 : 0.6, { cast: false });
    rug.userData.roomId = room.id; pickables.push(rug);
    wallScreen(inner, room.division, accent, 1.55, 0.9, 0.55, 2.05, -DEPTH / 2 + 0.2);
    divisionProp(inner, room.division, accent, -SLOT_W / 2 + 0.65, -DEPTH / 2 + 0.6);
    plant(inner, SLOT_W / 2 - 0.45, -DEPTH / 2 + 0.5, 1);
    const scale = per >= 3 ? 0.9 : 1;
    const seats = seatPositions(desks, per);
    const rows = new Set();
    seats.forEach((p, k) => {
      if (!rows.has(p.desk)) { rows.add(p.desk); desk(inner, p.w, 0.15, p.z, th); }
      const m = members.find((mm) => mm.desk === p.desk && mm.seat === p.seat);
      if (!m) { // vacant seat: an empty chair waiting for a hire
        const c = new THREE.Group(); c.position.set(0.15 + p.x, 0, p.z - 0.62); c.scale.setScalar(scale); inner.add(c);
        mesh(c, rbox(0.56, 0.08, 0.54, 0.03), std(th.chair), 0, 0.45, -0.02);
        mesh(c, rbox(0.56, 0.62, 0.08, 0.04), std(th.chair), 0, 0.82, -0.3);
        mesh(c, rbox(0.07, 0.42, 0.07, 0.02), std('#2a2e48', { metalness: 0.6, roughness: 0.3 }), 0, 0.22, -0.02);
        return;
      }
      laptop(inner, 0.15 + p.x, p.z - 0.05, accent);
      const person = makePerson(m, accent, th);
      person.group.position.set(0.15 + p.x, 0, p.z - 0.62);
      person.group.scale.setScalar(scale);
      inner.add(person.group);
      registerPerson(m, person, animate ? animate + 380 + k * 70 : null);
    });
    // labels
    const div = handlers.division(room.division);
    const chip = document.createElement('div');
    chip.className = `room-chip${preview ? ' preview' : ''}`;
    chip.innerHTML = `<span class="sw" style="background:${accent}">${handlers.icon(div?.icon || 'users', 12)}</span><span>${handlers.esc(room.name || handlers.text('preview'))}</span><span class="n">${members.length}</span>`;
    if (!preview) chip.addEventListener('click', (e) => { e.stopPropagation(); handlers.onPick({ type: 'room', id: room.id, x: e.clientX, y: e.clientY }); });
    label(chip, x0 + SLOT_W / 2, y - 0.02, DEPTH / 2 + 0.42);
    if (preview) {
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(SLOT_W - 0.05, WALL_H, DEPTH - 0.05)), new THREE.LineBasicMaterial({ color: new THREE.Color('#a99bff').multiplyScalar(2), transparent: true, opacity: 0.8 }));
      edges.position.y = WALL_H / 2; inner.add(edges);
      buildFx.push({ update: (t) => { edges.material.opacity = 0.35 + 0.35 * Math.sin(t * 4); } });
    }
    if (animate) {
      inner.scale.y = 0.001;
      tween((p) => { inner.scale.y = Math.max(0.001, ease.outBack(p)); inner.position.y = (1 - p) * -0.4; }, { delay: animate, dur: 760, curve: (p) => p });
    }
    return g;
  }

  function execRoom(entry, y, animate) {
    const { room, members, preview } = entry;
    const accent = room.accent || '#F5B544';
    const w = SLOT_W * 2;
    const g = new THREE.Group(); g.position.set(0, y, 0); building.add(g);
    const inner = new THREE.Group(); g.add(inner);
    const th = shell(inner, w, accent, room.theme, { exec: true });
    const rug = mesh(inner, rbox(4.2, 0.02, 2.6, 0.01), std(accent, { roughness: 0.95, emissive: accent, emissiveIntensity: 0.1 }), 1.6, 0.025, 0.7, { cast: false });
    rug.userData.roomId = room.id; pickables.push(rug);
    mesh(inner, rbox(2.6, 0.08, 0.95, 0.04), std('#2a2440', { roughness: 0.35, metalness: 0.2 }), 1.6, 0.76, 1.1);
    mesh(inner, rbox(2.4, 0.7, 0.8, 0.03), std('#1d1a2e'), 1.6, 0.36, 1.12);
    mesh(inner, rbox(2.42, 0.02, 0.02, 0), glow(accent, 2.5), 1.6, 0.72, 1.53, { cast: false });
    laptop(inner, 1.6, 1.05, accent);
    mesh(inner, rbox(0.3, 0.2, 0.22, 0.03), std('#f3d38a', { metalness: 0.6, roughness: 0.3 }), 0.75, 0.9, 1.1);
    wallScreen(inner, 'executive', accent, 1.5, 0.9, 0.0, 2.05, -DEPTH / 2 + 0.2);
    wallScreen(inner, 'sales', '#2ee59d', 1.3, 0.9, 1.75, 2.05, -DEPTH / 2 + 0.2);
    wallScreen(inner, 'product', '#8b7cff', 1.3, 0.9, 3.3, 2.05, -DEPTH / 2 + 0.2);
    // meeting table
    const table = mesh(inner, new THREE.CylinderGeometry(0.75, 0.75, 0.06, 40), std('#e2e4ef', { roughness: 0.4 }), -2.9, 0.74, -0.7);
    table.castShadow = true;
    mesh(inner, new THREE.CylinderGeometry(0.06, 0.18, 0.72, 16), std('#2b2f4a'), -2.9, 0.36, -0.7);
    for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2 + 0.6; mesh(inner, rbox(0.42, 0.45, 0.42, 0.06), std('#23263f'), -2.9 + Math.cos(a) * 1.05, 0.23, -0.7 + Math.sin(a) * 1.05); }
    // lounge
    mesh(inner, rbox(1.9, 0.38, 0.75, 0.12), std('#3a2f55', { roughness: 0.9 }), -2.6, 0.22, 1.75);
    mesh(inner, rbox(1.9, 0.5, 0.2, 0.08), std('#3a2f55', { roughness: 0.9 }), -2.6, 0.55, 1.45);
    plant(inner, -w / 2 + 0.5, -DEPTH / 2 + 0.5, 1.25);
    plant(inner, w / 2 - 0.5, -DEPTH / 2 + 0.5, 1.1);
    members.forEach((m, k) => {
      const person = makePerson(m, accent, th);
      person.group.position.set(1.6, 0, 0.45);
      inner.add(person.group);
      registerPerson(m, person, animate ? animate + 380 + k * 80 : null);
    });
    const chip = document.createElement('div');
    chip.className = `room-chip exec${preview ? ' preview' : ''}`;
    chip.innerHTML = `<span class="sw" style="background:${accent}">${handlers.icon('crown', 12)}</span><span>${handlers.esc(room.name)}</span>`;
    chip.addEventListener('click', (e) => { e.stopPropagation(); handlers.onPick({ type: 'room', id: room.id, x: e.clientX, y: e.clientY }); });
    label(chip, 1.6, y - 0.02, DEPTH / 2 + 0.42);
    if (animate) {
      inner.scale.y = 0.001;
      tween((p) => { inner.scale.y = Math.max(0.001, ease.outBack(p)); inner.position.y = (1 - p) * -0.4; }, { delay: animate, dur: 800, curve: (p) => p });
    }
  }

  function ghostSlot(floor, slot, newFloor) {
    const y = floor * FH;
    const x0 = slot === 0 ? -SLOT_W : 0;
    const g = new THREE.Group(); g.position.set(x0 + SLOT_W / 2, y, 0); building.add(g);
    mesh(g, rbox(SLOT_W, 0.26, DEPTH, 0.02), new THREE.MeshStandardMaterial({ color: APPEARANCE === 'light' ? 0xd6dbea : 0x1a1d3a, transparent: true, opacity: newFloor ? 0.35 : 0.6, roughness: 0.9 }), 0, -0.13, 0, { cast: false });
    const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]].map(([a, b]) => new THREE.Vector3(a * (SLOT_W / 2 - 0.3), 0.03, b * (DEPTH / 2 - 0.3)));
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: new THREE.Color('#8b7cff').multiplyScalar(1.6), dashSize: 0.28, gapSize: 0.2, transparent: true, opacity: 0.9 }));
    line.computeLineDistances(); g.add(line);
    // structural frame (corner pillars + top beams) so the floors above are visibly supported
    const frame = std(APPEARANCE === 'light' ? '#9aa2c4' : '#262a4a', { roughness: 0.6, metalness: 0.3 });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) mesh(g, rbox(0.14, WALL_H, 0.14, 0.02), frame, sx * (SLOT_W / 2 - 0.07), WALL_H / 2, sz * (DEPTH / 2 - 0.07));
    for (const sz of [-1, 1]) mesh(g, rbox(SLOT_W, 0.14, 0.14, 0.02), frame, 0, WALL_H - 0.07, sz * (DEPTH / 2 - 0.07), { cast: false });
    for (const sx of [-1, 1]) mesh(g, rbox(0.14, 0.14, DEPTH, 0.02), frame, sx * (SLOT_W / 2 - 0.07), WALL_H - 0.07, 0, { cast: false });
    const hit = mesh(g, new THREE.BoxGeometry(SLOT_W - 0.4, 0.05, DEPTH - 0.4), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }), 0, 0.03, 0, { cast: false, receive: false });
    hit.userData.ghost = { floor: newFloor ? 'new' : floor, slot };
    pickables.push(hit);
    buildFx.push({ update: (t) => { line.material.opacity = 0.5 + 0.4 * Math.sin(t * 2.2 + floor); } });
    const chip = document.createElement('button');
    chip.className = 'ghost-chip';
    chip.innerHTML = `${handlers.icon('plus', 14)}<span>${handlers.text(newFloor ? 'newFloor' : 'addRoom')}</span>`;
    chip.addEventListener('click', (e) => { e.stopPropagation(); handlers.onPick({ type: 'ghost', floor: newFloor ? 'new' : floor, slot }); });
    label(chip, x0 + SLOT_W / 2, y + 1.3, 0.6);
  }

  function registerPerson(m, person, popDelay) {
    persons.set(m.id, person);
    person.group.traverse((o) => { if (o.isMesh) pickables.push(o); });
    const st = handlers.statusOf(m.id);
    applyStatus(person, st.status, st.task, true);
    // name tag + task bubble
    const tag = document.createElement('div'); tag.className = 'name-tag';
    tag.innerHTML = `${handlers.esc(m.name.split(' ')[0])}<small>${handlers.esc(handlers.roleShort(m))}</small>`;
    person.tag = tag;
    const tagObj = new CSS2DObject(tag); tagObj.position.set(0, 2.42, 0); person.group.add(tagObj); labelObjs.push(tagObj);
    const bubble = document.createElement('div'); bubble.className = 'bubble';
    person.bubble = bubble;
    const bObj = new CSS2DObject(bubble); bObj.position.set(0.15, 2.75, 0); person.group.add(bObj); labelObjs.push(bObj);
    updateBubble(person);
    if (popDelay != null) {
      person.group.scale.multiplyScalar(0.001);
      const s = person.group.userData.baseScale = person.group.scale.x * 1000;
      tween((p) => person.group.scale.setScalar(Math.max(0.001, s * ease.outBack(p))), { delay: popDelay, dur: 620, curve: (p) => p });
    }
    if (selected === m.id) person.halo.material.opacity = 0.9;
  }

  function applyStatus(person, status, task, silent) {
    if (person.status !== status) person.statusAt = clock.elapsedTime;
    person.status = status || 'idle'; person.task = task || '';
    person.ring.material.color.setHex(STATUS_HEX[person.status] || STATUS_HEX.idle).multiplyScalar(2.2);
    if (!silent) updateBubble(person);
  }
  function updateBubble(person) {
    if (!person.bubble) return;
    const on = person.status === 'working' && person.task;
    person.bubble.textContent = person.task || '';
    person.bubble.classList.toggle('on', !!on);
  }

  let lastArgs = null;
  function build(org, draft) {
    lastArgs = [org, draft];
    const lay = layout(org, draft);
    const keepCam = !firstBuild;
    clear();
    buildFx.length = 0;
    const draftChanged = lay.draftKey && lay.draftKey !== lastDraftKey;
    lastDraftKey = lay.draftKey;
    // floors bottom-up with a staggered build-in on first load
    const floorIdx = [];
    for (let f = 0; f < lay.F; f++) floorIdx.push(f);
    floorIdx.forEach((f) => {
      for (const s of [0, 1]) {
        const entry = lay.occ.get(`${f}-${s}`);
        if (!entry) continue;
        const isNew = firstBuild || (!entry.preview && !known.has(entry.room.id)) || (entry.preview && draftChanged);
        teamRoom(entry, s === 0 ? -SLOT_W : 0, f * FH, s, isNew ? (firstBuild ? 150 + f * 160 + s * 90 : 60) : null);
      }
      const tag = document.createElement('div'); tag.className = 'floor-tag'; tag.textContent = handlers.text('floorN', f + 1);
      label(tag, -SLOT_W + 0.45, f * FH + WALL_H - 0.35, DEPTH / 2);
    });
    for (const gs of lay.ghosts) ghostSlot(gs.floor, gs.slot, false);
    execRoom(lay.exec, lay.execFloor * FH, firstBuild ? 150 + lay.execFloor * 160 + 120 : (draft?.exec && draftChanged ? 60 : null));
    const etag = document.createElement('div'); etag.className = 'floor-tag'; etag.textContent = handlers.text('exec');
    label(etag, -SLOT_W + 0.75, lay.execFloor * FH + WALL_H - 0.35, DEPTH / 2);

    known = new Set(org.rooms.map((r) => r.id));
    bounds = new THREE.Box3(new THREE.Vector3(-SLOT_W, -0.3, -DEPTH / 2), new THREE.Vector3(SLOT_W, lay.execFloor * FH + WALL_H, DEPTH / 2));
    // the key light follows the building's height
    const top = bounds.max.y;
    key.target.position.set(0, top / 2, 0);
    key.position.set(9, top / 2 + 22, 16);
    if (!keepCam) fit(true); else if (!focusRoomId) fit(false, true);
    firstBuild = false;
    if (hovered && !persons.has(hovered)) hovered = null;
  }

  // ---------------------------------------------------------------- camera
  // ~21° above the horizon, ~35° to the side: floors read as stacked "dollhouse" cutaways
  const DIR = new THREE.Vector3(0.55, 0.37, 0.78).normalize();
  let lastZoom = 1;
  function frustum() {
    const w = container.clientWidth, h = container.clientHeight;
    const aspect = w / h;
    const vh = view.h, vw = vh * aspect;
    // ortho zoom shrinks the extent but not the centre offset, so divide the inset shift by zoom
    const sx = ((insets.right - insets.left) / w) * vw / 2 / camera.zoom;
    const sy = (insets.bottom / h) * vh / 2 / camera.zoom;
    lastZoom = camera.zoom;
    camera.left = -vw / 2 + sx; camera.right = vw / 2 + sx;
    camera.top = vh / 2 - sy; camera.bottom = -vh / 2 - sy;
    camera.updateProjectionMatrix();
  }
  function fitHeight() {
    const w = container.clientWidth, h = container.clientHeight;
    const aspect = w / Math.max(1, h);
    const H = bounds.max.y - bounds.min.y;
    const usableW = 1 - (insets.right + insets.left) / w;
    const usableH = 1 - (insets.bottom + 150) / h;
    const needH = (H * 0.98 + 2.5) / Math.max(0.4, usableH);
    const needW = 13.2 / Math.max(0.35, usableW) / aspect;
    return Math.max(needH, needW);
  }
  function fit(instant = false, soft = false) {
    view.h = fitHeight();
    frustum();
    const target = new THREE.Vector3(0, (bounds.max.y + bounds.min.y) / 2 + 0.2, 0);
    if (instant) {
      controls.target.copy(target);
      camera.position.copy(target).addScaledVector(DIR, 60);
      camera.zoom = 0.62; camera.updateProjectionMatrix();
      goal = { target, zoom: 1 };
    } else {
      goal = { target, zoom: soft ? Math.min(camera.zoom, 1) : 1 };
    }
    focusRoomId = null;
  }
  function focusAt(center, zoom, roomId = null) {
    focusRoomId = roomId;
    goal = { target: center.clone(), zoom };
  }
  controls.addEventListener('start', () => { goal = null; });

  // ---------------------------------------------------------------- picking + hover
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function pick(clientX, clientY) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    return ray.intersectObjects(pickables, false)[0]?.object;
  }
  let downAt = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 6) return;
    const o = pick(e.clientX, e.clientY);
    if (!o) { handlers.onPick({ type: 'none' }); return; }
    if (o.userData.empId && persons.has(o.userData.empId) && !String(o.userData.empId).startsWith('__')) handlers.onPick({ type: 'employee', id: o.userData.empId, x: e.clientX, y: e.clientY });
    else if (o.userData.ghost) handlers.onPick({ type: 'ghost', ...o.userData.ghost });
    else if (o.userData.roomId) handlers.onPick({ type: 'room', id: o.userData.roomId, x: e.clientX, y: e.clientY });
  });
  let hoverQueued = null;
  renderer.domElement.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') hoverQueued = { x: e.clientX, y: e.clientY }; });
  renderer.domElement.addEventListener('pointerleave', () => setHover(null));
  function setHover(id) {
    if (hovered === id) return;
    const prev = persons.get(hovered);
    if (prev) prev.shirt.emissiveIntensity = 0;
    hovered = id;
    const p = persons.get(id);
    if (p) p.shirt.emissiveIntensity = 0.35;
    renderer.domElement.style.cursor = id ? 'pointer' : '';
  }

  // ---------------------------------------------------------------- hand-off arcs
  function headPos(id) {
    const p = persons.get(id);
    if (!p) return null;
    return p.head.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.35, 0));
  }
  function handoff(fromId, toId, kind = 'handoff') {
    const a = headPos(fromId), b = headPos(toId);
    if (!a || !b) return;
    const color = kind === 'report' ? '#2ee59d' : '#a99bff';
    const mid = a.clone().lerp(b, 0.5).add(new THREE.Vector3(0, 1.6 + a.distanceTo(b) * 0.18, 0)).addScaledVector(DIR, 1.2);
    const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 80, 0.028, 6, false), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(2.4), transparent: true, opacity: 1, depthWrite: false }));
    const total = tube.geometry.index.count;
    tube.geometry.setDrawRange(0, 0);
    scene.add(tube);
    const orb = new THREE.Mesh(new THREE.SphereGeometry(0.11, 20, 14), new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffffff').multiplyScalar(3) }));
    scene.add(orb);
    const ripple = new THREE.Mesh(new THREE.RingGeometry(0.15, 0.2, 48), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(2.5), transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
    ripple.position.copy(b); ripple.lookAt(camera.position); scene.add(ripple);
    const t0 = clock.elapsedTime;
    const fx = {
      update(t) {
        const k = (t - t0) / 1.25;
        if (k <= 1) {
          const e = ease.inOut(Math.min(1, k));
          tube.geometry.setDrawRange(0, Math.floor(total * e / 3) * 3);
          orb.position.copy(curve.getPoint(e));
        } else {
          orb.visible = false;
          const r = (t - t0 - 1.25) / 0.9;
          ripple.material.opacity = Math.max(0, 1 - r);
          ripple.scale.setScalar(1 + r * 4);
          tube.material.opacity = Math.max(0, 1 - r * 1.1);
          if (r >= 1) { scene.remove(tube, orb, ripple); tube.geometry.dispose(); fx.dead = true; }
        }
      },
    };
    effects.push(fx);
  }

  // ---------------------------------------------------------------- resize + loop
  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    renderer.setSize(w, h);
    composer.setSize(w, h);
    bloom.resolution.set(w / 2, h / 2);
    labels.setSize(w, h);
    if (!focusRoomId) view.h = fitHeight();
    frustum();
  }
  window.addEventListener('resize', resize);
  resize();

  let fakeDt = null;   // set by tick() to step the scene while the tab is hidden (testing)
  renderer.setAnimationLoop(() => frame());
  function frame() {
    const dt = fakeDt ?? Math.min(clock.getDelta(), 0.05);
    const t = clock.elapsedTime;
    const now = performance.now();
    for (let i = tweens.length - 1; i >= 0; i--) {
      const tw = tweens[i];
      const p = Math.min(1, Math.max(0, (now - tw.start) / tw.dur));
      tw.fn(tw.curve(p));
      if (p >= 1) tweens.splice(i, 1);
    }
    if (goal) {
      const k = 1 - Math.exp(-dt * 5.5);
      const delta = goal.target.clone().sub(controls.target).multiplyScalar(k);
      controls.target.add(delta); camera.position.add(delta);
      camera.zoom += (goal.zoom - camera.zoom) * k;
      camera.updateProjectionMatrix();
      if (delta.lengthSq() < 1e-6 && Math.abs(goal.zoom - camera.zoom) < 1e-3) goal = null;
    }
    controls.update();
    if (camera.zoom !== lastZoom) frustum();
    // cutaway: walls between the camera and a room fade out, so every angle shows the interior
    const vx = camera.position.x - controls.target.x, vz = camera.position.z - controls.target.z;
    const vl = Math.hypot(vx, vz) || 1;
    for (const wl of walls) {
      const facing = (wl.nx * vx + wl.nz * vz) / vl;
      const want = facing > 0.12 ? 0 : 1;
      wl.op += (want - wl.op) * Math.min(1, dt * 9);
      wl.mat.opacity = wl.op;
      wl.mat.depthWrite = wl.op > 0.98;
      wl.mesh.visible = wl.op > 0.02;
      for (const x of wl.extras) x.visible = wl.mesh.visible;
    }
    if (hoverQueued) {
      const o = pick(hoverQueued.x, hoverQueued.y);
      setHover(o?.userData.empId && !String(o.userData.empId).startsWith('__') ? o.userData.empId : null);
      if (!o?.userData.empId) renderer.domElement.style.cursor = o?.userData.ghost || o?.userData.roomId ? 'pointer' : '';
      hoverQueued = null;
    }
    const zoomedIn = camera.zoom > 3.4;
    for (const [id, p] of persons) {
      const k = t + p.phase;
      const since = t - p.statusAt;
      // the halo shows status by colour; it pulses and spins while working
      p.arc.visible = p.status === 'working';
      p.ring.position.y = 2.08 + Math.sin(k * 2) * 0.03;
      const pulse = p.status === 'working' ? 1.15 + Math.sin(t * 6) * 0.12 : 1;
      p.ring.scale.setScalar(pulse);
      p.arc.scale.setScalar(pulse * 1.18);
      if (p.status === 'working') {
        p.arc.rotation.z += dt * 6;
        p.arms[0].rotation.x = -1.22 + Math.sin(k * 17) * 0.12;
        p.arms[1].rotation.x = -1.22 + Math.sin(k * 17 + 1.9) * 0.12;
        p.head.rotation.set(0.14 + Math.sin(k * 3) * 0.03, 0, 0);
      } else if (p.status === 'done' && since < 1.6) {
        const c = Math.sin(Math.min(1, since / 1.6) * Math.PI);
        p.arms[0].rotation.x = p.arms[1].rotation.x = -1.15 - c * 1.6;
        p.head.rotation.set(-0.15 * c, 0, 0);
      } else if (p.status === 'error') {
        p.arms[0].rotation.x = p.arms[1].rotation.x = -0.35;
        p.head.rotation.set(0.32, 0, Math.sin(k * 4) * 0.12);
      } else {
        p.arms[0].rotation.x = p.arms[1].rotation.x = -1.08 + Math.sin(k * 1.4) * 0.03;
        p.head.rotation.set(Math.sin(k * 0.7) * 0.05, Math.sin(k * 0.33) * 0.35, 0);
      }
      p.torso.scale.y = 1 + Math.sin(k * 2.2) * 0.012;
      if (t > p.blinkAt) { p.blinkAt = t + 2.5 + Math.random() * 4; p.blinkEnd = t + 0.12; }
      const closed = p.blinkEnd && t < p.blinkEnd;
      p.eyes.forEach((e) => { e.scale.y = closed ? 0.15 : 1; });
      if (p.tag) p.tag.classList.toggle('on', hovered === id || selected === id || zoomedIn);
      p.halo.material.opacity += ((selected === id ? 0.85 + Math.sin(t * 3) * 0.15 : 0) - p.halo.material.opacity) * 0.15;
    }
    for (let i = effects.length - 1; i >= 0; i--) { effects[i].update(t, dt); if (effects[i].dead) effects.splice(i, 1); }
    for (const fx of buildFx) fx.update(t, dt);
    for (let i = 0; i < PN; i++) { pPos[i * 3 + 1] += pSpeed[i] * dt; if (pPos[i * 3 + 1] > 26) pPos[i * 3 + 1] = -1; }
    pGeo.attributes.position.needsUpdate = true;
    composer.render();
    labels.render(scene, camera);
  }

  // ---------------------------------------------------------------- public API
  return {
    render: build,
    tick(n = 60) { fakeDt = 1 / 30; for (let i = 0; i < n; i++) frame(); fakeDt = null; },
    setAppearance(mode) {
      APPEARANCE = mode === 'light' ? 'light' : 'dark';
      const light = APPEARANCE === 'light';
      const g = bg.getContext('2d'); const grd = g.createLinearGradient(0, 0, 0, 512);
      if (light) { grd.addColorStop(0, '#f6f7fc'); grd.addColorStop(0.55, '#e3e7f2'); grd.addColorStop(1, '#cbd2e4'); }
      else { grd.addColorStop(0, '#0b0e22'); grd.addColorStop(0.55, '#070915'); grd.addColorStop(1, '#040509'); }
      g.fillStyle = grd; g.fillRect(0, 0, 2, 512); bgTex.needsUpdate = true;
      const gg = gc.getContext('2d'); gg.clearRect(0, 0, 256, 256);
      const rg = gg.createRadialGradient(128, 128, 0, 128, 128, 128);
      if (light) { rg.addColorStop(0, 'rgba(139,124,255,0.25)'); rg.addColorStop(1, 'rgba(255,255,255,0)'); }
      else { rg.addColorStop(0, 'rgba(70,80,190,0.55)'); rg.addColorStop(0.5, 'rgba(40,46,120,0.18)'); rg.addColorStop(1, 'rgba(0,0,0,0)'); }
      gg.fillStyle = rg; gg.fillRect(0, 0, 256, 256); gTex.needsUpdate = true;
      grid.material.color = new THREE.Color(light ? 0xb4bbd3 : 0x151a40);
      grid.material.opacity = light ? 0.22 : 0.45;
      particles.material.color.setHex(light ? 0x8f97cc : 0x9aa8ff);
      particles.material.blending = light ? THREE.NormalBlending : THREE.AdditiveBlending;
      particles.material.opacity = light ? 0.35 : 0.45;
      hemi.color.setHex(light ? 0xffffff : 0xa8b4ff); hemi.groundColor.setHex(light ? 0xb8bfd8 : 0x0b0d18);
      hemi.intensity = light ? 0.8 : 0.75;
      key.intensity = light ? 1.35 : 1.7;
      rim.intensity = light ? 0.3 : 0.9;
      scene.environmentIntensity = light ? 0.38 : 0.32;
      renderer.toneMappingExposure = light ? 0.92 : 1.05;
      bloom.strength = light ? 0.35 : 0.75; bloom.threshold = light ? 1.1 : 1.0;
      shadowCatcher.material.opacity = light ? 0.18 : 0.35;
      if (lastArgs) build(...lastArgs);
    },
    setStatus(id, status, task) { const p = persons.get(id); if (p) { applyStatus(p, status, task); updateBubble(p); } },
    handoff,
    select(id) {
      const prev = persons.get(selected);
      selected = id;
      if (!prev) { /* nothing */ }
    },
    focusEmployee(id) {
      const p = persons.get(id); if (!p) return;
      const pos = p.group.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 1.2, 0));
      focusAt(pos, 2.4, null);
    },
    focusRoom(id) {
      const ps = [...persons.entries()].filter(([pid]) => handlers.roomOf(pid) === id).map(([, p]) => p.group.getWorldPosition(new THREE.Vector3()));
      if (!ps.length) return;
      const c = ps.reduce((a, b) => a.add(b), new THREE.Vector3()).multiplyScalar(1 / ps.length).add(new THREE.Vector3(0, 1.4, -0.4));
      focusAt(c, 2.1, id);
    },
    resetView() {
      fit(false);
      // swing back to the default viewing angle
      const off = camera.position.clone().sub(controls.target);
      const want = DIR.clone().multiplyScalar(off.length());
      const from = off.clone();
      tween((p) => { camera.position.copy(controls.target).add(from.clone().lerp(want, p).setLength(off.length())); }, { dur: 700, curve: ease.inOut });
    },
    rotate(deg) {
      const off = camera.position.clone().sub(controls.target);
      let done = 0;
      const total = (deg * Math.PI) / 180;
      tween((p) => {
        const step = total * p - done; done = total * p;
        off.applyAxisAngle(new THREE.Vector3(0, 1, 0), step);
        camera.position.copy(controls.target).add(off);
      }, { dur: 650, curve: ease.inOut });
    },
    setInsets(next) {
      Object.assign(insets, next);
      if (!focusRoomId) view.h = fitHeight();
      frustum();
    },
    focusPreview() {
      const p = [...persons.entries()].find(([pid]) => String(pid).startsWith('__') || handlers.isDraft(pid));
      if (p) focusAt(p[1].group.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 1.3, -0.5)), 1.6, '__draft');
    },
  };
}
