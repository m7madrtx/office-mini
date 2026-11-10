// First-person 3D house tour generated from /api/house (data/house.json).
import * as THREE from 'three';
import { t, L, getLang, applyDir } from './i18n.js';

const $ = (id) => document.getElementById(id);
const EYE = 1.6, SIT_EYE = 1.1, R = 0.22, SPEED = 2.3, WT = 0.06, DOOR_H = 2.15, SILL = 0.9, WIN_TOP = 2.35;
const DEG = Math.PI / 180;

const LABELS = {
  en: { door: ['Open door', 'Close door'], sit: ['Sit', 'Stand up'], faucet: ['Turn tap on', 'Turn tap off'], flush: ['Flush', 'Flush'],
        shower: ['Shower on', 'Shower off'], curtain: ['Open curtain', 'Close curtain'], tv: ['TV on', 'TV off'], lamp: ['Lamp on', 'Lamp off'],
        night: 'Night', day: 'Day' },
  ar: { door: ['افتح الباب', 'سكّر الباب'], sit: ['اقعد', 'قوم'], faucet: ['افتح الحنفية', 'سكّر الحنفية'], flush: ['اسحب السيفون', 'اسحب السيفون'],
        shower: ['شغّل الشور', 'طفّ الشور'], curtain: ['افتح الستارة', 'سكّر الستارة'], tv: ['شغّل التلفزيون', 'طفّ التلفزيون'], lamp: ['شغّل الأباجورة', 'طفّ الأباجورة'],
        night: 'ليل', day: 'نهار' },
};
const LB = () => LABELS[getLang()] || LABELS.en;

// ---------------------------------------------------------------- renderer
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
$('view').appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 300);
camera.rotation.order = 'YXZ';

const hemi = new THREE.HemisphereLight(0xffffff, 0xb9b2a6, 1.6);
const sun = new THREE.DirectionalLight(0xfff4e0, 1.3);
sun.position.set(18, 30, 12);
const ambient = new THREE.AmbientLight(0xffffff, 0.35);
scene.add(hemi, sun, ambient);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(300, 300), new THREE.MeshLambertMaterial({ color: 0xd8d3c8 }));
ground.rotation.x = -Math.PI / 2; ground.position.y = -0.13;
scene.add(ground);

const matCache = new Map();
function M(color, extra) {
  const key = String(color) + (extra ? JSON.stringify(extra) : '');
  if (!matCache.has(key)) matCache.set(key, new THREE.MeshLambertMaterial({ color, ...(extra || {}) }));
  return matCache.get(key);
}
function bx(parent, w, h, d, color, x, y, z, extra) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), extra?.isMaterial ? extra : M(color, extra));
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}
function cyl(parent, r, h, color, x, y, z, seg = 16, extra) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), M(color, extra));
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}
const GLASS = new THREE.MeshLambertMaterial({ color: 0xbfe3ff, transparent: true, opacity: 0.28, depthWrite: false });

// ---------------------------------------------------------------- world state
let house = null;
let world = null;
let floorGroups = [];
let colliders = [];      // per floor: [{x0,x1,z0,z1}]
let doors = [];          // {floor, pivot, open, t, closed, blocker}
let inters = [];         // interactables
let roomLights = [];     // per floor: [PointLight]
let bulbs = [];          // emissive materials that glow at night
let anims = [];          // per-frame callbacks
let tvScreens = [];
let stairs = null;
let roof = null;
let night = false;
let topView = false;
const player = { x: 0, z: 0, y: 0, floor: 0, yaw: 0, pitch: -0.05, sitting: null, back: null };

// ---------------------------------------------------------------- weather TV
const tvCanvas = document.createElement('canvas');
tvCanvas.width = 512; tvCanvas.height = 288;
const tvTex = new THREE.CanvasTexture(tvCanvas);
tvTex.colorSpace = THREE.SRGBColorSpace;
const WMO = { 0: ['Clear', 'صحو'], 1: ['Mostly clear', 'صحو غالباً'], 2: ['Partly cloudy', 'غائم جزئياً'], 3: ['Cloudy', 'غائم'],
  45: ['Fog', 'ضباب'], 48: ['Fog', 'ضباب'], 51: ['Drizzle', 'رذاذ'], 61: ['Rain', 'مطر'], 63: ['Rain', 'مطر'], 65: ['Heavy rain', 'مطر غزير'],
  80: ['Showers', 'زخات'], 95: ['Thunderstorm', 'عاصفة رعدية'] };
const wText = (c) => (WMO[c] || WMO[Math.floor(c / 10) * 10] || ['—', '—'])[getLang() === 'ar' ? 1 : 0];
let weather = null;
function drawTV() {
  const g = tvCanvas.getContext('2d');
  const ar = getLang() === 'ar';
  const grd = g.createLinearGradient(0, 0, 512, 288);
  grd.addColorStop(0, '#0d2a6b'); grd.addColorStop(1, '#1f5fbf');
  g.fillStyle = grd; g.fillRect(0, 0, 512, 288);
  g.fillStyle = '#d62828'; g.fillRect(0, 240, 512, 48);
  g.fillStyle = '#fff'; g.font = 'bold 22px Tajawal, sans-serif'; g.textBaseline = 'middle';
  g.textAlign = ar ? 'right' : 'left';
  const edge = ar ? 496 : 16;
  g.fillText(ar ? 'نشرة الطقس · مباشر' : 'WEATHER · LIVE', edge, 264);
  if (!weather || !weather.current) {
    g.font = 'bold 30px Tajawal, sans-serif'; g.fillText(ar ? 'جاري التحميل…' : 'Loading…', edge, 110);
  } else {
    const c = weather.current;
    g.font = 'bold 26px Tajawal, sans-serif'; g.fillText(weather.city, edge, 34);
    g.font = 'bold 84px Tajawal, sans-serif'; g.fillText(`${Math.round(c.temperature_2m)}°`, edge, 108);
    g.font = '24px Tajawal, sans-serif';
    g.fillText(`${wText(c.weather_code)} · 💧${c.relative_humidity_2m}% · 💨${Math.round(c.wind_speed_10m)} km/h`, edge, 172);
    // sun icon
    g.fillStyle = '#ffd34d'; g.beginPath(); g.arc(ar ? 70 : 442, 96, 34, 0, 7); g.fill();
    const d = weather.daily;
    if (d) {
      g.font = '18px Tajawal, sans-serif'; g.fillStyle = '#cfe0ff';
      const days = d.time.slice(1, 4).map((ts, i) => {
        const name = new Date(ts).toLocaleDateString(ar ? 'ar' : 'en', { weekday: 'short' });
        return `${name} ${Math.round(d.temperature_2m_max[i + 1])}°/${Math.round(d.temperature_2m_min[i + 1])}°`;
      });
      g.fillText(days.join('   '), edge, 212);
    }
  }
  tvTex.needsUpdate = true;
}
async function loadWeather() {
  try { weather = await (await fetch('/api/weather')).json(); } catch { weather = null; }
  drawTV();
}

// ---------------------------------------------------------------- helpers
function addCollider(floor, cx, cz, w, d) {
  colliders[floor].push({ x0: cx - w / 2, x1: cx + w / 2, z0: cz - d / 2, z1: cz + d / 2 });
}
function addInter(floor, root, pos, kind, act, stateFn) {
  inters.push({ floor, root, pos, kind, act, state: stateFn });
}
function local(group, x, y, z) {
  group.updateMatrixWorld(true);
  return group.localToWorld(new THREE.Vector3(x, y, z));
}

// ---------------------------------------------------------------- furniture builders (local space, facing +z)
const B = {
  sofa_l(g) {
    bx(g, 2.8, 0.42, 0.9, 0x6e4e3e, 0, 0.21, -0.55);
    bx(g, 2.8, 0.5, 0.2, 0x5f4234, 0, 0.67, -0.9);
    bx(g, 0.95, 0.42, 1.1, 0x6e4e3e, 0.92, 0.21, 0.45);
    bx(g, 0.2, 0.5, 2.0, 0x5f4234, 1.3, 0.67, 0);
    bx(g, 0.2, 0.55, 0.9, 0x5f4234, -1.3, 0.5, -0.55);
    for (const x of [-0.9, -0.1]) bx(g, 0.75, 0.1, 0.75, 0x86634f, x, 0.47, -0.5);
    return { w: 2.8, d: 2.0, seat: [-0.5, -0.4] };
  },
  sofa(g) {
    bx(g, 2.2, 0.42, 0.9, 0x6e4e3e, 0, 0.21, 0);
    bx(g, 2.2, 0.5, 0.2, 0x5f4234, 0, 0.67, -0.35);
    return { w: 2.2, d: 0.9, seat: [0, 0.05] };
  },
  coffee_table(g) {
    bx(g, 1.2, 0.06, 0.7, 0xf6f6f4, 0, 0.42, 0);
    bx(g, 1.0, 0.39, 0.5, 0xe9e6df, 0, 0.2, 0);
    cyl(g, 0.06, 0.25, 0xffffff, 0.2, 0.57, 0, 12, { transparent: true, opacity: 0.6 });
    for (const [dx, dy, c] of [[0, 0.95, 0xe63946], [0.09, 0.88, 0xff6b81], [-0.08, 0.9, 0xf1f1f1], [0.03, 1.02, 0xe63946]]) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 10), M(c));
      s.position.set(0.2 + dx, dy, 0); g.add(s);
    }
    return { w: 1.2, d: 0.7 };
  },
  tv_wall(g, item, floor) {
    for (let i = 0; i < 26; i++) bx(g, 0.08, 2.9, 0.06, i % 2 ? 0x5b3a2a : 0x4a2f22, -1.5 + i * 0.12, 1.45, -0.2);
    bx(g, 2.6, 0.38, 0.45, 0xd8b892, 0, 0.24, 0.0);
    for (let i = 0; i < 18; i++) bx(g, 0.03, 0.34, 0.01, 0xc4a17a, -1.25 + i * 0.147, 0.24, 0.23);
    bx(g, 1.7, 0.98, 0.07, 0x111111, 0, 1.6, -0.13);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.9), new THREE.MeshBasicMaterial({ map: tvTex }));
    screen.position.set(0, 1.6, -0.09); g.add(screen);
    bx(g, 0.9, 0.08, 0.12, 0x222222, 0, 0.47, 0.05);
    const tv = { on: true };
    tvScreens.push({ screen, tv });
    addInter(floor, g, local(g, 0, 1.4, 0.4), 'tv', () => {
      tv.on = !tv.on;
      screen.material = tv.on ? new THREE.MeshBasicMaterial({ map: tvTex }) : new THREE.MeshBasicMaterial({ color: 0x0b0b0b });
    }, () => tv.on);
    return { w: 3.1, d: 0.5 };
  },
  plant(g) {
    cyl(g, 0.2, 0.42, 0xeeeeee, 0, 0.21, 0);
    for (const [x, y, z, r] of [[0, 0.75, 0, 0.26], [0.12, 0.98, 0.05, 0.18], [-0.12, 0.92, -0.06, 0.2]]) {
      const s = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), M(0x3f9b4f)); s.position.set(x, y, z); g.add(s);
    }
    return { w: 0.45, d: 0.45 };
  },
  tree(g) {
    bx(g, 0.75, 0.5, 0.75, 0xcfc9bf, 0, 0.25, 0);
    cyl(g, 0.05, 1.5, 0x7b5a3a, 0, 1.2, 0, 8);
    for (let i = 0; i < 6; i++) {
      const s = new THREE.Mesh(new THREE.IcosahedronGeometry(0.22 + (i % 3) * 0.05, 0), M(0x7a9a52));
      s.position.set(Math.cos(i) * 0.3, 1.75 + (i % 3) * 0.2, Math.sin(i * 1.7) * 0.3); g.add(s);
    }
    return { w: 0.75, d: 0.75 };
  },
  kitchen_island(g) {
    bx(g, 2.6, 0.88, 1.0, 0x2b2b2e, 0, 0.44, 0);
    bx(g, 2.75, 0.05, 1.12, 0xf3f3f3, 0, 0.905, 0);
    for (const x of [-0.8, 0, 0.8]) {
      cyl(g, 0.18, 0.05, 0x1e1e1e, x, 0.72, 0.85);
      cyl(g, 0.025, 0.7, 0x777777, x, 0.36, 0.85, 8);
      cyl(g, 0.006, 0.6, 0x111111, x, 2.68, 0, 6);
      const shade = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.24, 18, 1, true), M(0x151515, { side: THREE.DoubleSide }));
      shade.position.set(x, 2.27, 0); g.add(shade);
      const bulbMat = new THREE.MeshBasicMaterial({ color: 0x999999 });
      bulbs.push(bulbMat);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), bulbMat); bulb.position.set(x, 2.17, 0); g.add(bulb);
    }
    bx(g, 0.35, 0.2, 0.25, 0xd9a066, -0.5, 1.02, -0.1);
    return { w: 2.75, d: 1.12 };
  },
  kitchen_counter(g, item, floor) {
    const w = item.w || 4;
    bx(g, w - 0.8, 0.88, 0.62, 0xf4f4f4, -0.4, 0.44, 0);
    bx(g, w - 0.8, 0.04, 0.66, 0xe2e2e2, -0.4, 0.9, 0);
    for (let x = -w / 2 + 0.3; x < w / 2 - 0.8; x += 0.6) bx(g, 0.3, 0.02, 0.01, 0x444444, x, 0.78, 0.315);
    bx(g, 0.8, 2.25, 0.66, 0xc9cdd1, w / 2 - 0.4, 1.125, 0);
    bx(g, 0.02, 0.9, 0.01, 0x666666, w / 2 - 0.75, 1.4, 0.335);
    for (const [a, b] of [[-w / 2, -1.25], [1.25, w / 2 - 0.8]]) if (b - a > 0.2) bx(g, b - a, 0.7, 0.35, 0xf4f4f4, (a + b) / 2, 2.2, -0.15);
    bx(g, 0.6, 0.01, 0.42, 0x2a2a2a, -1.5, 0.925, 0.02);
    const sx = 0.2;
    bx(g, 0.62, 0.02, 0.42, 0x8f959b, sx, 0.921, 0.03);
    cyl(g, 0.02, 0.32, 0xc0c0c0, sx, 1.08, -0.22, 8);
    bx(g, 0.03, 0.03, 0.2, 0xc0c0c0, sx, 1.23, -0.13);
    return { w, d: 0.66, faucet: [sx, 1.21, -0.04] };
  },
  dining_table(g) {
    bx(g, 1.6, 0.05, 0.9, 0x6b4a36, 0, 0.75, 0);
    for (const [x, z] of [[-0.7, -0.35], [0.7, -0.35], [-0.7, 0.35], [0.7, 0.35]]) bx(g, 0.05, 0.75, 0.05, 0x4a3326, x, 0.375, z);
    for (const [x, z] of [[-0.4, -0.7], [0.4, -0.7], [-0.4, 0.7], [0.4, 0.7]]) bx(g, 0.42, 0.45, 0.42, 0xe8e2d8, x, 0.225, z);
    return { w: 1.6, d: 1.8 };
  },
  bed(g) {
    bx(g, 1.85, 0.35, 2.1, 0x8a6a50, 0, 0.175, 0);
    bx(g, 1.75, 0.22, 2.0, 0xfafafa, 0, 0.46, 0);
    bx(g, 1.95, 1.15, 0.1, 0x6b4f3a, 0, 0.58, -1.05);
    for (const x of [-0.45, 0.45]) bx(g, 0.62, 0.14, 0.38, 0xffffff, x, 0.64, -0.75);
    bx(g, 1.77, 0.07, 1.25, 0x8fa3c7, 0, 0.6, 0.35);
    return { w: 1.95, d: 2.2, seat: [0, 0.75] };
  },
  wardrobe(g) {
    bx(g, 2.0, 2.3, 0.6, 0xe8e2d8, 0, 1.15, 0);
    for (const x of [-0.5, 0, 0.5]) bx(g, 0.01, 2.2, 0.01, 0x9a9183, x, 1.15, 0.305);
    for (const x of [-0.08, 0.08, -0.58, 0.58]) bx(g, 0.02, 0.3, 0.03, 0x555555, x, 1.15, 0.32);
    return { w: 2.0, d: 0.6 };
  },
  desk(g) {
    bx(g, 1.4, 0.05, 0.7, 0xf4f4f4, 0, 0.74, 0);
    for (const x of [-0.65, 0.65]) bx(g, 0.05, 0.72, 0.65, 0xdedede, x, 0.36, 0);
    bx(g, 0.62, 0.38, 0.03, 0x111111, 0, 1.08, -0.22);
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.58, 0.34), new THREE.MeshBasicMaterial({ color: 0x3d7bff }));
    scr.position.set(0, 1.08, -0.2); g.add(scr);
    bx(g, 0.05, 0.3, 0.05, 0x333333, 0, 0.9, -0.24);
    bx(g, 0.5, 0.08, 0.5, 0x2f2f33, 0, 0.47, 0.6);
    bx(g, 0.5, 0.55, 0.07, 0x2f2f33, 0, 0.8, 0.84);
    return { w: 1.4, d: 0.7, seat: [0, 0.6], seatYaw: 180 };
  },
  printer_cabinet(g) {
    const W = 1.8, H = 2.25, Dp = 0.55, wood = 0x5a3b2a;
    bx(g, 0.05, H, Dp, wood, -W / 2 + 0.025, H / 2, 0);
    bx(g, 0.05, H, Dp, wood, W / 2 - 0.025, H / 2, 0);
    bx(g, 0.05, H - 0.5, Dp, wood, 0, (H + 0.5) / 2, 0);
    bx(g, W, 0.05, Dp, wood, 0, H - 0.025, 0);
    bx(g, W, 0.5, Dp, 0x4c3122, 0, 0.25, 0);
    bx(g, W, 0.05, Dp, wood, 0, 1.36, 0);
    bx(g, W, 0.02, Dp, 0x3e281c, 0, H / 2, -Dp / 2 + 0.01);
    const spools = [0xe63946, 0xf4a261, 0x2a9d8f, 0x457b9d, 0xffffff, 0x8338ec, 0xffbe0b, 0x06d6a0];
    let k = 0;
    for (const y of [0.52, 1.39]) for (const x of [-0.44, 0.44]) {
      bx(g, 0.66, 0.62, 0.46, 0x3a3d42, x, y + 0.31, 0);
      bx(g, 0.56, 0.48, 0.01, 0, x, y + 0.3, 0.235, GLASS);
      bx(g, 0.4, 0.02, 0.3, 0x1c1c1c, x, y + 0.1, 0);
      bx(g, 0.12, 0.12, 0.12, [0xff8a3d, 0xf3efe6, 0x7a5cff, 0x2ee59d][k % 4], x, y + 0.17, 0);
      for (const dx of [-0.2, -0.07, 0.07, 0.2]) {
        const s = cyl(g, 0.055, 0.07, spools[k++ % spools.length], x + dx, y + 0.66, 0.05, 14);
        s.rotation.x = Math.PI / 2;
      }
    }
    return { w: W, d: Dp };
  },
  bathroom_sink(g) {
    bx(g, 1.0, 0.78, 0.5, 0x8a6a50, 0, 0.39, 0);
    bx(g, 1.05, 0.05, 0.52, 0xf7f7f7, 0, 0.805, 0);
    bx(g, 0.46, 0.1, 0.36, 0xffffff, 0, 0.88, 0.02);
    cyl(g, 0.02, 0.25, 0xc0c0c0, 0, 1.0, -0.2, 8);
    bx(g, 0.03, 0.03, 0.14, 0xc0c0c0, 0, 1.12, -0.13);
    bx(g, 0.85, 0.75, 0.02, 0xdbe6ee, 0, 1.65, -0.24);
    return { w: 1.0, d: 0.5, faucet: [0, 1.1, -0.07] };
  },
  toilet(g, item, floor) {
    bx(g, 0.4, 0.4, 0.5, 0xfdfdfd, 0, 0.2, 0.05);
    bx(g, 0.46, 0.42, 0.2, 0xf4f4f4, 0, 0.6, -0.22);
    bx(g, 0.42, 0.04, 0.46, 0xffffff, 0, 0.42, 0.07);
    const water = cyl(g, 0.13, 0.01, 0x7fc8ff, 0, 0.445, 0.08, 18, { transparent: true, opacity: 0.85 });
    let spin = 0;
    anims.push((dt) => {
      if (spin > 0) { spin -= dt; water.rotation.y += dt * 12; water.scale.setScalar(0.5 + 0.5 * Math.abs(Math.sin(spin * 6))); }
      else water.scale.setScalar(1);
    });
    addInter(floor, g, local(g, 0, 0.7, 0.1), 'flush', () => { spin = 2.2; }, () => false);
    return { w: 0.46, d: 0.7 };
  },
  shower(g, item, floor) {
    bx(g, 1.0, 0.06, 1.0, 0xfafafa, 0, 0.03, 0);
    bx(g, 1.0, 2.0, 0.02, 0, 0, 1.06, 0.5, GLASS);
    bx(g, 0.02, 2.0, 1.0, 0, -0.5, 1.06, 0, GLASS);
    cyl(g, 0.015, 0.4, 0xc0c0c0, 0.35, 2.15, -0.35, 8);
    cyl(g, 0.12, 0.02, 0xc0c0c0, 0.2, 2.1, -0.2, 18);
    const N = 160;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) { pos[i * 3] = 0.2 + (Math.random() - 0.5) * 0.22; pos[i * 3 + 1] = Math.random() * 2; pos[i * 3 + 2] = -0.2 + (Math.random() - 0.5) * 0.22; }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const drops = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0x6fb9ff, size: 0.03, transparent: true, opacity: 0.8 }));
    drops.visible = false; g.add(drops);
    anims.push((dt) => {
      if (!drops.visible) return;
      for (let i = 0; i < N; i++) { pos[i * 3 + 1] -= dt * 4; if (pos[i * 3 + 1] < 0.06) pos[i * 3 + 1] = 2.05; }
      geo.attributes.position.needsUpdate = true;
    });
    addInter(floor, g, local(g, 0, 1.2, 0.3), 'shower', () => { drops.visible = !drops.visible; }, () => drops.visible);
    return { w: 1.0, d: 1.0 };
  },
  curtain(g, item, floor) {
    const w = item.w || 2;
    bx(g, w + 0.3, 0.03, 0.03, 0x777777, 0, 2.55, 0.08);
    const panels = [-1, 1].map((s) => {
      const p = bx(g, w / 2, 2.45, 0.04, 0xe9e4da, s * w / 4, 1.3, 0.1);
      p.userData.side = s;
      return p;
    });
    const st = { open: false, k: 0 };
    anims.push((dt) => {
      st.k += ((st.open ? 1 : 0) - st.k) * Math.min(1, dt * 5);
      for (const p of panels) {
        p.scale.x = 1 - 0.75 * st.k;
        p.position.x = p.userData.side * (w / 4 + (w / 4) * 0.75 * st.k);
      }
    });
    addInter(floor, g, local(g, 0, 1.3, 0.6), 'curtain', () => { st.open = !st.open; }, () => st.open);
    return { w, d: 0.15, noCollide: true };
  },
  rug(g) {
    bx(g, 2.4, 0.012, 1.7, 0xb9a99a, 0, 0.006, 0);
    return { w: 2.4, d: 1.7, noCollide: true };
  },
  bookshelf(g) {
    const wood = 0x6b4a36;
    bx(g, 1.2, 2.0, 0.04, wood, 0, 1.0, -0.16);
    for (const x of [-0.58, 0.58]) bx(g, 0.04, 2.0, 0.35, wood, x, 1.0, 0);
    const cols = [0xe63946, 0x457b9d, 0xf4a261, 0x2a9d8f, 0x1d3557, 0xe9c46a];
    for (let s = 0; s < 5; s++) {
      bx(g, 1.2, 0.03, 0.35, wood, 0, 0.02 + s * 0.45, 0);
      if (s === 4) break;
      for (let i = 0; i < 7; i++) bx(g, 0.1, 0.3 + (i % 3) * 0.04, 0.24, cols[(s + i) % cols.length], -0.45 + i * 0.14, 0.2 + s * 0.45 + (i % 3) * 0.02, 0);
    }
    return { w: 1.2, d: 0.36 };
  },
  floor_lamp(g, item, floor) {
    cyl(g, 0.16, 0.03, 0x333333, 0, 0.015, 0);
    cyl(g, 0.015, 1.5, 0x333333, 0, 0.77, 0, 8);
    const shadeMat = new THREE.MeshLambertMaterial({ color: 0xf2e6cf, emissive: 0x000000 });
    const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, 0.3, 18, 1, true), shadeMat);
    shade.material.side = THREE.DoubleSide;
    shade.position.y = 1.6; g.add(shade);
    const light = new THREE.PointLight(0xffd9a0, 0, 6, 1.6);
    light.position.y = 1.55; g.add(light);
    const st = { on: false };
    const apply = () => { light.intensity = st.on ? 3 : 0; shadeMat.emissive.setHex(st.on ? 0x8a6a3a : 0); };
    addInter(floor, g, local(g, 0, 1.2, 0), 'lamp', () => { st.on = !st.on; apply(); }, () => st.on);
    return { w: 0.35, d: 0.35 };
  },
};

// ---------------------------------------------------------------- build the house
function edgeGaps(fl, axis, fixed, a, b) {
  const gaps = [];
  for (const d of fl.doors || []) {
    if (d.axis !== axis) continue;
    const line = axis === 'x' ? d.z : d.x, c = axis === 'x' ? d.x : d.z;
    if (Math.abs(line - fixed) < 0.05 && c > a && c < b) gaps.push({ s: Math.max(a, c - d.width / 2), e: Math.min(b, c + d.width / 2), kind: 'door' });
  }
  for (const w of fl.windows || []) {
    if (w.axis !== axis) continue;
    const line = axis === 'x' ? w.z : w.x, c = axis === 'x' ? w.x : w.z;
    if (Math.abs(line - fixed) < 0.05 && c > a && c < b) gaps.push({ s: Math.max(a, c - w.width / 2), e: Math.min(b, c + w.width / 2), kind: 'window' });
  }
  return gaps.sort((p, q) => p.s - q.s);
}

function buildWalls(g, fi, fl, r, elev) {
  const WH = house.wallHeight;
  const edges = [
    { axis: 'x', fixed: r.z0, a: r.x0, b: r.x1, inward: 1 },
    { axis: 'x', fixed: r.z1, a: r.x0, b: r.x1, inward: -1 },
    { axis: 'z', fixed: r.x0, a: r.z0, b: r.z1, inward: 1 },
    { axis: 'z', fixed: r.x1, a: r.z0, b: r.z1, inward: -1 },
  ];
  const wallMat = M(r.wall);
  for (const e of edges) {
    const off = e.fixed + e.inward * WT / 2;
    const piece = (s, en, y0, y1, solid = true) => {
      const L = en - s; if (L < 0.01 || y1 - y0 < 0.01) return;
      const mid = (s + en) / 2, h = y1 - y0;
      const mesh = e.axis === 'x'
        ? bx(g, L, h, WT, 0, mid, elev + y0 + h / 2, off, wallMat)
        : bx(g, WT, h, L, 0, off, elev + y0 + h / 2, mid, wallMat);
      if (solid && y0 < 1.5) {
        if (e.axis === 'x') colliders[fi].push({ x0: s, x1: en, z0: Math.min(e.fixed, e.fixed + e.inward * WT), z1: Math.max(e.fixed, e.fixed + e.inward * WT) });
        else colliders[fi].push({ x0: Math.min(e.fixed, e.fixed + e.inward * WT), x1: Math.max(e.fixed, e.fixed + e.inward * WT), z0: s, z1: en });
      }
      return mesh;
    };
    let cur = e.a;
    for (const gap of edgeGaps(fl, e.axis, e.fixed, e.a, e.b)) {
      piece(cur, gap.s, 0, WH);
      if (gap.kind === 'door') piece(gap.s, gap.e, DOOR_H, WH, false);
      else {
        piece(gap.s, gap.e, 0, SILL); piece(gap.s, gap.e, WIN_TOP, WH, false);
        // glass + collider for the window opening
        const L = gap.e - gap.s, mid = (gap.s + gap.e) / 2;
        if (e.axis === 'x') { bx(g, L, WIN_TOP - SILL, 0.02, 0, mid, elev + (SILL + WIN_TOP) / 2, e.fixed, GLASS); colliders[fi].push({ x0: gap.s, x1: gap.e, z0: e.fixed - 0.05, z1: e.fixed + 0.05 }); }
        else { bx(g, 0.02, WIN_TOP - SILL, L, 0, e.fixed, elev + (SILL + WIN_TOP) / 2, mid, GLASS); colliders[fi].push({ x0: e.fixed - 0.05, x1: e.fixed + 0.05, z0: gap.s, z1: gap.e }); }
      }
      cur = gap.e;
    }
    piece(cur, e.b, 0, WH);
  }
}

function buildDoor(g, fi, d, elev) {
  if (d.kind !== 'door') return;
  const w = d.width;
  const pivot = new THREE.Group();
  const alongX = d.axis === 'x';
  pivot.position.set(alongX ? d.x - w / 2 : d.x, elev, alongX ? d.z : d.z - w / 2);
  const base = alongX ? 0 : -Math.PI / 2;
  pivot.rotation.y = base;
  g.add(pivot);
  const panel = bx(pivot, w - 0.03, DOOR_H - 0.02, 0.05, 0x5a3626, w / 2, DOOR_H / 2, 0);
  for (let i = 1; i < 5; i++) bx(pivot, 0.01, DOOR_H - 0.1, 0.055, 0x4a2c1f, (w / 5) * i, DOOR_H / 2, 0);
  bx(pivot, 0.12, 0.03, 0.09, 0xc0c0c0, w - 0.12, 1.05, 0);
  // frame
  const fm = 0x3e281c;
  if (alongX) { bx(g, 0.05, DOOR_H, 0.14, fm, d.x - w / 2, elev + DOOR_H / 2, d.z); bx(g, 0.05, DOOR_H, 0.14, fm, d.x + w / 2, elev + DOOR_H / 2, d.z); bx(g, w + 0.1, 0.05, 0.14, fm, d.x, elev + DOOR_H, d.z); }
  else { bx(g, 0.14, DOOR_H, 0.05, fm, d.x, elev + DOOR_H / 2, d.z - w / 2); bx(g, 0.14, DOOR_H, 0.05, fm, d.x, elev + DOOR_H / 2, d.z + w / 2); bx(g, 0.14, 0.05, w + 0.1, fm, d.x, elev + DOOR_H, d.z); }
  const door = { floor: fi, pivot, base, open: false, k: 0, panel,
    blocker: alongX ? { x0: d.x - w / 2, x1: d.x + w / 2, z0: d.z - 0.08, z1: d.z + 0.08 } : { x0: d.x - 0.08, x1: d.x + 0.08, z0: d.z - w / 2, z1: d.z + w / 2 } };
  doors.push(door);
  addInter(fi, pivot, new THREE.Vector3(d.x, elev + 1.2, d.z), 'door', () => { door.open = !door.open; }, () => door.open);
}

function buildStairs(g, s, FH) {
  const n = 16;
  const alongZ = s.dir.endsWith('z');
  const len = alongZ ? s.z1 - s.z0 : s.x1 - s.x0;
  const width = alongZ ? s.x1 - s.x0 : s.z1 - s.z0;
  const run = len / n;
  for (let i = 0; i < n; i++) {
    const p = (i + 0.5) / n;
    const y = ((i + 1) * FH) / n - 0.035;
    const along = stairCoord(s, p);
    if (alongZ) bx(g, width, 0.07, run + 0.03, 0x4a3326, (s.x0 + s.x1) / 2, y, along);
    else bx(g, run + 0.03, 0.07, width, 0x4a3326, along, y, (s.z0 + s.z1) / 2);
  }
  // sloped glass railing on the open side
  const slope = Math.atan2(FH, len), diag = Math.hypot(len, FH);
  const rail = new THREE.Mesh(new THREE.BoxGeometry(alongZ ? 0.02 : diag, 0.9, alongZ ? diag : 0.02), GLASS);
  const mid = stairCoord(s, 0.5);
  if (alongZ) { rail.position.set(s.x1, FH / 2 + 0.5, mid); rail.rotation.x = s.dir[0] === '-' ? slope : -slope; }
  else { rail.position.set(mid, FH / 2 + 0.5, s.z1); rail.rotation.z = s.dir[0] === '-' ? -slope : slope; }
  g.add(rail);
}
// world coordinate along the stairs at progress p (0 bottom, 1 top)
function stairCoord(s, p) {
  if (s.dir === '-z') return s.z1 - p * (s.z1 - s.z0);
  if (s.dir === '+z') return s.z0 + p * (s.z1 - s.z0);
  if (s.dir === '-x') return s.x1 - p * (s.x1 - s.x0);
  return s.x0 + p * (s.x1 - s.x0);
}
function stairProgress(s, x, z) {
  if (s.dir === '-z') return (s.z1 - z) / (s.z1 - s.z0);
  if (s.dir === '+z') return (z - s.z0) / (s.z1 - s.z0);
  if (s.dir === '-x') return (s.x1 - x) / (s.x1 - s.x0);
  return (x - s.x0) / (s.x1 - s.x0);
}
function stairColliders(s, which) {
  const alongZ = s.dir.endsWith('z');
  const sides = alongZ
    ? [{ x0: s.x0 - 0.06, x1: s.x0, z0: s.z0, z1: s.z1 }, { x0: s.x1, x1: s.x1 + 0.06, z0: s.z0, z1: s.z1 }]
    : [{ x0: s.x0, x1: s.x1, z0: s.z0 - 0.06, z1: s.z0 }, { x0: s.x0, x1: s.x1, z0: s.z1, z1: s.z1 + 0.06 }];
  const endAt = (p) => {
    const c = stairCoord(s, p);
    return alongZ ? { x0: s.x0, x1: s.x1, z0: c - 0.04, z1: c + 0.04 } : { x0: c - 0.04, x1: c + 0.04, z0: s.z0, z1: s.z1 };
  };
  if (which === 'on') return sides;
  if (which === 0) return [...sides, endAt(1)];
  return [...sides, endAt(0)];
}

function build() {
  if (world) scene.remove(world);
  world = new THREE.Group();
  scene.add(world);
  floorGroups = []; colliders = []; doors = []; inters = []; roomLights = []; bulbs = []; anims = []; tvScreens = [];
  const FH = house.floorHeight;
  house.floors.forEach((fl, fi) => {
    const elev = fi * FH;
    const g = new THREE.Group();
    world.add(g); floorGroups.push(g); colliders.push([]); roomLights.push([]);
    for (const r of fl.rooms) {
      bx(g, r.x1 - r.x0, 0.12, r.z1 - r.z0, r.floor, (r.x0 + r.x1) / 2, elev - 0.06, (r.z0 + r.z1) / 2);
      buildWalls(g, fi, fl, r, elev);
      const light = new THREE.PointLight(0xffe2b8, 0, Math.max(r.x1 - r.x0, r.z1 - r.z0) * 1.4, 1.3);
      light.position.set((r.x0 + r.x1) / 2, elev + house.wallHeight - 0.4, (r.z0 + r.z1) / 2);
      g.add(light); roomLights[fi].push(light);
      for (const item of r.furniture || []) {
        const builder = B[item.type];
        if (!builder) continue;
        const fg = new THREE.Group();
        fg.position.set(item.x, elev, item.z);
        fg.rotation.y = (item.rot || 0) * DEG;
        g.add(fg);
        const info = builder(fg, item, fi) || {};
        const swap = Math.abs(Math.round((item.rot || 0) / 90)) % 2 === 1;
        if (!info.noCollide) addCollider(fi, item.x, item.z, swap ? info.d : info.w, swap ? info.w : info.d);
        if (info.seat) {
          const seatYaw = (item.rot || 0) * DEG + (info.seatYaw || 0) * DEG;
          const st = { };
          addInter(fi, fg, local(fg, info.seat[0], 0.6, info.seat[1]), 'sit', () => toggleSit(st, local(fg, info.seat[0], 0, info.seat[1]), seatYaw, fi), () => player.sitting === st);
        }
        if (info.faucet) {
          const [fx, fy, fz] = info.faucet;
          const stream = cyl(fg, 0.012, fy - 0.9, 0x8fd0ff, fx, (fy + 0.9) / 2, fz, 8, { transparent: true, opacity: 0.7 });
          stream.visible = false;
          addInter(fi, fg, local(fg, fx, fy, fz + 0.3), 'faucet', () => { stream.visible = !stream.visible; }, () => stream.visible);
        }
      }
    }
    for (const d of fl.doors || []) buildDoor(g, fi, d, elev);
    if (fl.stairs) { stairs = fl.stairs; buildStairs(g, fl.stairs, FH); }
  });
  // one roof over the whole footprint (hidden in top view)
  const all = house.floors.flatMap((f) => f.rooms);
  const minX = Math.min(...all.map((r) => r.x0)), maxX = Math.max(...all.map((r) => r.x1));
  const minZ = Math.min(...all.map((r) => r.z0)), maxZ = Math.max(...all.map((r) => r.z1));
  roof = bx(world, maxX - minX, 0.12, maxZ - minZ, 0xf7f7f5, (minX + maxX) / 2, (house.floors.length - 1) * FH + house.wallHeight + 0.06, (minZ + maxZ) / 2);
  applyNight();
  drawTV();
}

// ---------------------------------------------------------------- interactions
function toggleSit(st, seatPos, seatYaw, floor) {
  if (player.sitting === st) {
    Object.assign(player, player.back, { sitting: null, back: null });
    return;
  }
  player.back = { x: player.x, z: player.z, floor: player.floor };
  player.sitting = st;
  player.x = seatPos.x; player.z = seatPos.z; player.floor = floor;
  // seat faces local +z rotated by seatYaw; camera yaw that looks along that direction
  player.yaw = seatYaw + Math.PI;
  player.pitch = -0.1;
}

function nearestInter() {
  if (player.sitting) return inters.find((i) => i.kind === 'sit' && i.state());
  const fwd = new THREE.Vector2(-Math.sin(player.yaw), -Math.cos(player.yaw));
  let best = null, bestD = 2.1;
  for (const it of inters) {
    if (it.floor !== player.floor) continue;
    const dx = it.pos.x - player.x, dz = it.pos.z - player.z;
    const d = Math.hypot(dx, dz);
    if (d > bestD) continue;
    if (d > 0.5 && (dx * fwd.x + dz * fwd.y) / d < 0.35) continue;
    best = it; bestD = d;
  }
  return best;
}
function labelFor(it) {
  const pair = LB()[it.kind];
  return pair[it.state() ? 1 : 0];
}

// ---------------------------------------------------------------- input: joystick, drag-to-look, keys, tap
const joy = { x: 0, y: 0, id: null };
const joyEl = $('joy'), knob = $('knob');
joyEl.addEventListener('pointerdown', (e) => { joy.id = e.pointerId; joyEl.setPointerCapture(e.pointerId); moveJoy(e); e.preventDefault(); });
joyEl.addEventListener('pointermove', (e) => { if (e.pointerId === joy.id) moveJoy(e); });
const endJoy = (e) => { if (e.pointerId !== joy.id) return; joy.id = null; joy.x = joy.y = 0; knob.style.transform = ''; };
joyEl.addEventListener('pointerup', endJoy);
joyEl.addEventListener('pointercancel', endJoy);
function moveJoy(e) {
  const r = joyEl.getBoundingClientRect();
  let dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
  const max = r.width / 2 - 10, d = Math.hypot(dx, dy);
  if (d > max) { dx *= max / d; dy *= max / d; }
  knob.style.transform = `translate(${dx}px, ${dy}px)`;
  joy.x = dx / max; joy.y = -dy / max;
}

const look = { id: null, x: 0, y: 0, sx: 0, sy: 0 };
const canvas = renderer.domElement;
canvas.addEventListener('pointerdown', (e) => {
  if (look.id !== null) return;
  look.id = e.pointerId; look.x = look.sx = e.clientX; look.y = look.sy = e.clientY;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerId !== look.id || topView) return;
  player.yaw -= (e.clientX - look.x) * 0.005;
  player.pitch = Math.max(-1.2, Math.min(1.1, player.pitch - (e.clientY - look.y) * 0.004));
  look.x = e.clientX; look.y = e.clientY;
});
const endLook = (e) => {
  if (e.pointerId !== look.id) return;
  look.id = null;
  if (Math.hypot(e.clientX - look.sx, e.clientY - look.sy) < 8) tapAt(e.clientX, e.clientY);
};
canvas.addEventListener('pointerup', endLook);
canvas.addEventListener('pointercancel', (e) => { if (e.pointerId === look.id) look.id = null; });

const ray = new THREE.Raycaster();
function tapAt(cx, cy) {
  const r = canvas.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), camera);
  const hit = ray.intersectObjects(floorGroups.filter((g) => g.visible), true)[0];
  if (!hit || hit.distance > 5 && !topView) return;
  const it = inters.find((i) => { let o = hit.object; while (o) { if (o === i.root) return true; o = o.parent; } return false; });
  if (it && (it.kind !== 'sit' || !topView)) it.act();
}

const keys = new Set();
window.addEventListener('keydown', (e) => {
  keys.add(e.key.toLowerCase());
  if (e.key.toLowerCase() === 'e') { const it = nearestInter(); if (it) it.act(); }
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

$('context').onclick = () => { const it = nearestInter(); if (it) it.act(); };
$('help').onclick = () => $('help').classList.toggle('min');
$('topBtn').onclick = () => { topView = !topView; $('topBtn').classList.toggle('on', topView); $('topBtn').textContent = t(topView ? 'firstPerson' : 'topView'); };
$('nightBtn').onclick = () => { night = !night; applyNight(); };
$('floorBtn').onclick = () => {
  const next = (player.floor + 1) % house.floors.length;
  const sp = house.floors[next].spawn;
  Object.assign(player, { x: sp.x, z: sp.z, floor: next, yaw: sp.yaw * DEG, pitch: -0.05, sitting: null, back: null });
};
$('mapBtn').onclick = () => { $('map').hidden = false; drawMap(); };
$('map').onclick = () => { $('map').hidden = true; };

function applyNight() {
  scene.background = new THREE.Color(night ? 0x0b1020 : 0xf2f2f0);
  scene.fog = null;
  hemi.intensity = night ? 0.12 : 1.6;
  sun.intensity = night ? 0 : 1.3;
  ambient.intensity = night ? 0.12 : 0.35;
  ground.material.color.setHex(night ? 0x1a1d26 : 0xd8d3c8);
  bulbs.forEach((m) => m.color.setHex(night ? 0xfff1c9 : 0x999999));
  roomLights.forEach((ls, fi) => ls.forEach((l) => { l.intensity = night && fi === player.floor ? 9 : 0; }));
  $('nightBtn').textContent = night ? LB().day : LB().night;
  $('nightBtn').classList.toggle('on', night);
}

// ---------------------------------------------------------------- movement + collisions
function blocked(x, z) {
  const list = [...colliders[player.floor]];
  for (const d of doors) if (d.floor === player.floor && d.k < 0.5) list.push(d.blocker);
  if (stairs) {
    const inside = x > stairs.x0 && x < stairs.x1 && z > stairs.z0 && z < stairs.z1;
    const onNow = player.x > stairs.x0 && player.x < stairs.x1 && player.z > stairs.z0 && player.z < stairs.z1;
    list.push(...stairColliders(stairs, inside || onNow ? 'on' : player.floor));
  }
  for (const c of list) if (x + R > c.x0 && x - R < c.x1 && z + R > c.z0 && z - R < c.z1) return true;
  return false;
}

let lastFloor = -1;
function update(dt) {
  for (const d of doors) {
    d.k += ((d.open ? 1 : 0) - d.k) * Math.min(1, dt * 4);
    d.pivot.rotation.y = d.base - d.k * (Math.PI / 2) * 0.95;
  }
  anims.forEach((f) => f(dt));

  if (!player.sitting) {
    let mx = joy.x, mz = joy.y;
    if (keys.has('w') || keys.has('arrowup')) mz += 1;
    if (keys.has('s') || keys.has('arrowdown')) mz -= 1;
    if (keys.has('a') || keys.has('arrowleft')) mx -= 1;
    if (keys.has('d') || keys.has('arrowright')) mx += 1;
    const len = Math.hypot(mx, mz);
    if (len > 1) { mx /= len; mz /= len; }
    let dx, dz;
    if (topView) { dx = mx * SPEED * dt; dz = -mz * SPEED * dt; }
    else {
      const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
      const rx = Math.cos(player.yaw), rz = -Math.sin(player.yaw);
      dx = (fx * mz + rx * mx) * SPEED * dt; dz = (fz * mz + rz * mx) * SPEED * dt;
    }
    if (dx && !blocked(player.x + dx, player.z)) player.x += dx;
    if (dz && !blocked(player.x, player.z + dz)) player.z += dz;
  }

  const FH = house.floorHeight;
  if (stairs && player.x > stairs.x0 && player.x < stairs.x1 && player.z > stairs.z0 && player.z < stairs.z1) {
    const p = Math.max(0, Math.min(1, stairProgress(stairs, player.x, player.z)));
    player.y = p * FH;
    player.floor = p > 0.5 ? 1 : 0;
  } else {
    player.y = player.floor * FH;
  }
  if (player.floor !== lastFloor) {
    lastFloor = player.floor;
    $('floorBtn').textContent = L(house.floors[player.floor].name);
    applyNight();
  }

  if (roof) roof.visible = !topView;
  if (topView) {
    floorGroups.forEach((g, i) => { g.visible = i <= player.floor; });
    camera.up.set(0, 0, -1);
    camera.position.set(player.x, player.floor * FH + 15, player.z + 0.001);
    camera.lookAt(player.x, player.floor * FH, player.z);
    marker.visible = true;
    marker.position.set(player.x, player.y + 0.4, player.z);
    marker.rotation.y = player.yaw;
  } else {
    floorGroups.forEach((g) => { g.visible = true; });
    camera.up.set(0, 1, 0);
    camera.position.set(player.x, player.y + (player.sitting ? SIT_EYE : EYE), player.z);
    camera.rotation.set(player.pitch, player.yaw, 0, 'YXZ');
    marker.visible = false;
  }

  const it = nearestInter();
  const btn = $('context');
  if (it && !topView) { btn.hidden = false; btn.textContent = labelFor(it); } else btn.hidden = true;
  if (!$('map').hidden) drawMap();
}

const marker = new THREE.Mesh(new THREE.ConeGeometry(0.35, 0.8, 12), new THREE.MeshBasicMaterial({ color: 0xff4f8b }));
marker.geometry.rotateX(-Math.PI / 2);
scene.add(marker);

// ---------------------------------------------------------------- 2D map
function drawMap() {
  const fl = house.floors[player.floor];
  const cv = $('mapCanvas');
  const xs = fl.rooms.flatMap((r) => [r.x0, r.x1]), zs = fl.rooms.flatMap((r) => [r.z0, r.z1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const scale = Math.min((window.innerWidth * 0.9) / (maxX - minX + 2), (window.innerHeight * 0.8) / (maxZ - minZ + 2));
  cv.width = (maxX - minX + 2) * scale; cv.height = (maxZ - minZ + 2) * scale;
  const g = cv.getContext('2d');
  const P = (x, z) => [(x - minX + 1) * scale, (z - minZ + 1) * scale];
  g.fillStyle = '#fbfaf7'; g.fillRect(0, 0, cv.width, cv.height);
  for (const r of fl.rooms) {
    const [x0, z0] = P(r.x0, r.z0), [x1, z1] = P(r.x1, r.z1);
    g.fillStyle = r.floor; g.globalAlpha = 0.55; g.fillRect(x0, z0, x1 - x0, z1 - z0); g.globalAlpha = 1;
    g.strokeStyle = '#333'; g.lineWidth = 3; g.strokeRect(x0, z0, x1 - x0, z1 - z0);
    g.fillStyle = '#222'; g.font = `bold ${Math.max(11, scale * 0.32)}px Tajawal, sans-serif`; g.textAlign = 'center';
    g.fillText(L(r.name), (x0 + x1) / 2, (z0 + z1) / 2);
  }
  for (const d of fl.doors || []) {
    const [cx, cz] = P(d.x, d.z);
    g.strokeStyle = '#fbfaf7'; g.lineWidth = 6; g.beginPath();
    if (d.axis === 'x') { g.moveTo(cx - (d.width / 2) * scale, cz); g.lineTo(cx + (d.width / 2) * scale, cz); }
    else { g.moveTo(cx, cz - (d.width / 2) * scale); g.lineTo(cx, cz + (d.width / 2) * scale); }
    g.stroke();
  }
  if (stairs) {
    const [x0, z0] = P(stairs.x0, stairs.z0), [x1, z1] = P(stairs.x1, stairs.z1);
    g.strokeStyle = '#8a6a50'; g.lineWidth = 1.5;
    for (let i = 0; i <= 16; i++) { const z = z0 + ((z1 - z0) * i) / 16; g.beginPath(); g.moveTo(x0, z); g.lineTo(x1, z); g.stroke(); }
  }
  const [px, pz] = P(player.x, player.z);
  g.save(); g.translate(px, pz); g.rotate(-player.yaw);
  g.fillStyle = '#ff4f8b'; g.beginPath(); g.moveTo(0, -14); g.lineTo(9, 10); g.lineTo(-9, 10); g.closePath(); g.fill();
  g.restore();
}

// ---------------------------------------------------------------- boot
function resize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', resize);

async function loadHouse(keepPlayer) {
  house = await (await fetch('/api/house', { cache: 'no-store' })).json();
  build();
  if (!keepPlayer) {
    const sp = house.floors[0].spawn;
    Object.assign(player, { x: sp.x, z: sp.z, floor: 0, yaw: sp.yaw * DEG });
  }
  player.sitting = null;
  lastFloor = -1;
}

// handy for testing from the browser console (step() advances the simulation without rendering)
window.tourDebug = { player, nearestInter, keys, step: (n = 1, dt = 1 / 60) => { for (let i = 0; i < n; i++) update(dt); } };

(async () => {
  applyDir();
  resize();
  await loadHouse(false);
  loadWeather();
  setInterval(loadWeather, 30 * 60 * 1000);
  $('loading').classList.add('off');
  setTimeout(() => $('help').classList.add('min'), 7000);  // tap the "?" to show it again
  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    update(Math.min(clock.getDelta(), 0.05));
    renderer.render(scene, camera);
  });
  // live updates when the Contractor agent edits the house
  const es = new EventSource('/api/events');
  es.onmessage = (ev) => { if (JSON.parse(ev.data).type === 'house') loadHouse(true); };
})();
