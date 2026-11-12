/* ===================== traffic.js =====================
   Browser side: simulation (vehicles, lights), 3D drawing, dashboard, controls.
   Java is called every second to calculate density + green time.            */

const canvas = document.getElementById('view');
const ctx = canvas.getContext('2d');
const $ = id => document.getElementById(id);
const rand = (a, b) => a + Math.random() * (b - a);

// ---------- Constants ----------
const ROAD_LEN = 500;              // each arm is 500 units long
const STOP_S = ROAD_LEN - 54;      // distance (from spawn) where a car's front must stop
const YELLOW_TIME = 3, ALL_RED_TIME = 2, DEFAULT_GREEN = 8;
const ACC = 60, DECEL = 120;       // acceleration / braking
const SPAWN_GAP = { low: 4.5, medium: 2.5, high: 1.3 };  // seconds between cars
const TYPES = [
  { name: 'car',   len: 34, wid: 18, vmax: 90, weight: 70 },
  { name: 'bus',   len: 60, wid: 21, vmax: 70, weight: 12 },
  { name: 'truck', len: 48, wid: 20, vmax: 75, weight: 18 }
];
const COLORS = ['#e63946', '#457b9d', '#f4a261', '#2a9d8f', '#e9c46a', '#8d99ae', '#9b5de5', '#f1f1f1'];

// Arms: 0 = North, 1 = East, 2 = South, 3 = West.
// Everything is defined for the North arm, then rotated by 90 degrees per arm.
const rot = (k, x, y) => [[x, y], [-y, x], [-x, -y], [y, -x]][k];

// ---------- State ----------
let state, running = false, speed = 1, density = 'medium';
let backend = { online: false, greenSeconds: DEFAULT_GREEN, density: 'LOW' };
const cam = { angle: 0.7, tilt: 0.55, zoom: 1 };

function reset() {
  state = {
    time: 0, vehicles: [], crossed: [], rateTimer: 0,
    arms: [0, 1, 2, 3].map(() => ({ timer: rand(0.2, 2), rate: 1 })),
    group: 0,                // 0 = North/South has the signal, 1 = East/West
    phase: 'GREEN',          // GREEN -> YELLOW -> ALLRED -> (other group) GREEN
    remaining: DEFAULT_GREEN
  };
}

// Colour of the light seen by one arm
function lightState(arm) {
  if (arm % 2 !== state.group) return 'RED';
  return state.phase === 'ALLRED' ? 'RED' : state.phase;
}

function pickType() {
  let r = rand(0, 100);
  for (const t of TYPES) { if ((r -= t.weight) < 0) return t; }
  return TYPES[0];
}

// Vehicles that have not yet left the intersection, per arm
const counts = () => [0, 1, 2, 3].map(a =>
  state.vehicles.filter(v => v.arm === a && v.s < STOP_S + 60).length);

function flow() {
  state.crossed = state.crossed.filter(t => t > state.time - 60);
  const span = Math.max(10, Math.min(60, state.time));
  return Math.round(state.crossed.length * 60 / span);
}

// ---------- Talking to Java ----------
async function poll() {
  const c = counts();
  const next = state.group === 0 ? 'EW' : 'NS';   // group that will be green next
  try {
    const url = `/api/signal?north=${c[0]}&east=${c[1]}&south=${c[2]}&west=${c[3]}&next=${next}`;
    const r = await fetch(url);
    backend = await r.json();
    backend.online = true;
  } catch (e) {
    // Fallback so the simulator still works without Java
    const total = c[0] + c[1] + c[2] + c[3];
    backend = { online: false, greenSeconds: DEFAULT_GREEN,
                density: total < 8 ? 'LOW' : total < 16 ? 'MEDIUM' : 'HIGH' };
  }
  const b = $('javaStatus');
  b.textContent = backend.online ? 'Java backend: connected' : 'Java backend: offline (default timing)';
  b.className = 'badge ' + (backend.online ? 'on' : 'off');
}

// ---------- Simulation step (dt = simulated seconds) ----------
function update(dt) {
  state.time += dt;

  // 1) Signal state machine
  state.remaining -= dt;
  if (state.remaining <= 0) {
    if (state.phase === 'GREEN') { state.phase = 'YELLOW'; state.remaining = YELLOW_TIME; }
    else if (state.phase === 'YELLOW') { state.phase = 'ALLRED'; state.remaining = ALL_RED_TIME; }
    else {
      state.group = 1 - state.group;
      state.phase = 'GREEN';
      state.remaining = backend.greenSeconds;   // duration decided by Java
    }
  }

  // 2) Each road gets a different arrival rate, re-rolled every 20 s
  state.rateTimer -= dt;
  if (state.rateTimer <= 0) { state.rateTimer = 20; state.arms.forEach(a => a.rate = rand(0.4, 1.7)); }

  // 3) Spawn new vehicles (only if there is free space at the start of the road)
  state.arms.forEach((a, arm) => {
    a.timer -= dt;
    if (a.timer > 0) return;
    const t = pickType();
    const free = state.vehicles.every(o => o.arm !== arm || o.s - o.type.len / 2 - t.len / 2 > 12);
    if (free) {
      state.vehicles.push({ arm, type: t, s: 0, v: t.vmax * 0.6, color: COLORS[Math.floor(rand(0, COLORS.length))] });
      a.timer = SPAWN_GAP[density] / a.rate * rand(0.6, 1.4);
    } else a.timer = 0.3;
  });

  // 4) Move vehicles: keep distance from the leader, stop at red/yellow
  for (let arm = 0; arm < 4; arm++) {
    const list = state.vehicles.filter(v => v.arm === arm).sort((a, b) => b.s - a.s);
    const light = lightState(arm);
    list.forEach((v, i) => {
      const lead = list[i - 1], half = v.type.len / 2, oldFront = v.s + half;
      let limit = Infinity, room = Infinity;       // limit = furthest allowed position

      if (lead) {                                  // do not touch the car in front
        limit = lead.s - lead.type.len / 2 - half - 4;
        room = limit - v.s - 4 - v.v * 0.3;        // extra gap grows with speed
      }
      if (light !== 'GREEN' && oldFront <= STOP_S + 0.5) {
        const stopLimit = STOP_S - half, d = stopLimit - v.s;
        const canStop = d > (v.v * v.v) / (2 * DECEL * 0.8);
        if (light === 'RED' || canStop) { limit = Math.min(limit, stopLimit); room = Math.min(room, d - 2); }
      }
      const target = Math.min(v.type.vmax, Math.sqrt(2 * DECEL * Math.max(0, room)));
      v.v = target > v.v ? Math.min(target, v.v + ACC * dt) : Math.max(target, v.v - 2 * DECEL * dt);
      v.s = Math.max(v.s, Math.min(v.s + v.v * dt, limit));

      if (oldFront <= STOP_S && v.s + half > STOP_S) state.crossed.push(state.time); // flow counter
    });
  }
  state.vehicles = state.vehicles.filter(v => v.s < 2 * ROAD_LEN + 40);
}

// ---------- 3D projection (camera) ----------
let W = 0, H = 0;
function resize() {
  const d = window.devicePixelRatio || 1;
  W = canvas.clientWidth; H = canvas.clientHeight;
  canvas.width = W * d; canvas.height = H * d;
  ctx.setTransform(d, 0, 0, d, 0, 0);
}
window.addEventListener('resize', resize);

// world (x, y, height z) -> screen. Rotates around the centre, tilts, adds perspective.
function P(x, y, z = 0) {
  const c = Math.cos(cam.angle), s = Math.sin(cam.angle);
  const rx = x * c - y * s, ry = x * s + y * c;
  const k = 1 + ry * 0.0006, sc = (W / 1100) * cam.zoom * k;
  return { x: W / 2 + rx * sc, y: H * 0.52 + ry * cam.tilt * sc - z * sc, d: ry, sc };
}
function poly(pts, fill) {
  ctx.beginPath();
  pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
  ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
}
const circle = (x, y, r) => { ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); };
const flat = (x0, y0, x1, y1, fill) => poly([P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)], fill);
function armFlat(k, x0, y0, x1, y1, fill) {   // rectangle given in North-arm coordinates
  poly([[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(p => { const r = rot(k, p[0], p[1]); return P(r[0], r[1]); }), fill);
}
function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16), m = v => Math.min(255, Math.round(v * f));
  return `rgb(${m((n >> 16) & 255)},${m((n >> 8) & 255)},${m(n & 255)})`;
}

// A 3D box: centre (cx,cy), base height z0, length L along (ux,uy), width Wd, height h.
const LIGHT = [-0.53, -0.85];
const corners = (cx, cy, L, Wd, ux, uy) => {
  const vx = -uy, vy = ux;
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) =>
    [cx + ux * i * L / 2 + vx * j * Wd / 2, cy + uy * i * L / 2 + vy * j * Wd / 2]);
};
function box(cx, cy, z0, L, Wd, h, ux, uy, color) {
  const vx = -uy, vy = ux, sA = Math.sin(cam.angle), cA = Math.cos(cam.angle);
  const C = corners(cx, cy, L, Wd, ux, uy);
  const N = [[-vx, -vy], [ux, uy], [vx, vy], [-ux, -uy]];     // outward side normals
  for (let k = 0; k < 4; k++) {
    const n = N[k];
    if (n[0] * sA + n[1] * cA <= 0) continue;                 // side faces away from camera
    const a = C[k], b = C[(k + 1) % 4];
    const f = Math.max(0.4, Math.min(1, 0.65 + 0.35 * (n[0] * LIGHT[0] + n[1] * LIGHT[1])));
    poly([P(a[0], a[1], z0), P(b[0], b[1], z0), P(b[0], b[1], z0 + h), P(a[0], a[1], z0 + h)], shade(color, f));
  }
  poly(C.map(p => P(p[0], p[1], z0 + h)), shade(color, 1.12)); // top face
}
function shadowBox(cx, cy, L, Wd, h, ux, uy) {
  poly(corners(cx, cy, L, Wd, ux, uy).map(p => P(p[0] + h * 0.5, p[1] + h * 0.35)), 'rgba(0,0,0,0.25)');
}

// ---------- Scenery (built once) ----------
const scenery = (() => {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pal = ['#8d99ae', '#adb5bd', '#b08968', '#6c757d', '#9a8c98', '#7f9cb5'];
  const items = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1])
    for (let x = 120; x <= 350; x += 95) for (let y = 120; y <= 350; y += 95) {
      if (rnd() < 0.2) continue;
      items.push({ t: 'b', x: sx * (x + rnd() * 10), y: sy * (y + rnd() * 10),
                   w: 50 + rnd() * 20, d: 50 + rnd() * 20, h: 40 + rnd() * 100, color: pal[Math.floor(rnd() * pal.length)] });
    }
  for (const s of [-1, 1]) for (const t of [-1, 1]) {
    for (let d = 100; d <= 420; d += 65) { items.push({ t: 't', x: s * 64, y: t * d }); items.push({ t: 't', x: t * d, y: s * 64 }); }
    for (const d of [110, 230, 350])     { items.push({ t: 'l', x: s * 47, y: t * d }); items.push({ t: 'l', x: t * d, y: s * 47 }); }
  }
  return items;
})();

function sceneItem(o) {
  const d = P(o.x, o.y).d;
  if (o.t === 'b') return { d, shadow: () => shadowBox(o.x, o.y, o.w, o.d, o.h, 1, 0), draw: () => box(o.x, o.y, 0, o.w, o.d, o.h, 1, 0, o.color) };
  if (o.t === 't') return {
    d,
    shadow: () => { const g = P(o.x + 10, o.y + 8); ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.beginPath(); ctx.ellipse(g.x, g.y, 15 * g.sc, 15 * g.sc * cam.tilt, 0, 0, 7); ctx.fill(); },
    draw: () => {
      box(o.x, o.y, 0, 5, 5, 20, 1, 0, '#6b4423');
      const p = P(o.x, o.y, 32), r = 16 * p.sc;
      ctx.fillStyle = '#2f7d32'; circle(p.x, p.y, r);
      ctx.fillStyle = '#4caf50'; circle(p.x - r * 0.25, p.y - r * 0.3, r * 0.65);
    }
  };
  return { d, shadow: () => shadowBox(o.x, o.y, 3, 3, 52, 1, 0), draw: () => {   // street light
    box(o.x, o.y, 0, 3, 3, 52, 1, 0, '#444');
    const p = P(o.x, o.y, 55);
    ctx.fillStyle = 'rgba(255,233,168,.3)'; circle(p.x, p.y, 10 * p.sc);
    ctx.fillStyle = '#ffe9a8'; circle(p.x, p.y, 4.5 * p.sc);
  } };
}

function vehicleItem(v) {
  const [x, y] = rot(v.arm, 20, -ROAD_LEN + v.s), [ux, uy] = rot(v.arm, 0, 1), t = v.type;
  return {
    d: P(x, y).d,
    shadow: () => shadowBox(x, y, t.len, t.wid, 14, ux, uy),
    draw: () => {
      box(x, y, 0, t.len * 0.95, t.wid * 0.95, 3, ux, uy, '#111');          // wheels/underbody
      if (t.name === 'car') {
        box(x, y, 3, t.len, t.wid, 8, ux, uy, v.color);
        box(x - ux * 2, y - uy * 2, 11, t.len * 0.5, t.wid * 0.85, 7, ux, uy, '#cfe3f3'); // cabin
      } else if (t.name === 'bus') {
        box(x, y, 3, t.len, t.wid, 22, ux, uy, v.color);
      } else {
        box(x - ux * t.len * 0.14, y - uy * t.len * 0.14, 3, t.len * 0.7, t.wid, 20, ux, uy, '#d9d9d9'); // cargo
        box(x + ux * t.len * 0.36, y + uy * t.len * 0.36, 3, t.len * 0.26, t.wid, 14, ux, uy, v.color);  // cab
      }
    }
  };
}

function lightItem(k) {
  const [x, y] = rot(k, 48, -58), [fx, fy] = rot(k, 0, -1), st = lightState(k);
  return {
    d: P(x, y).d,
    shadow: () => shadowBox(x, y, 4, 4, 34, 1, 0),
    draw: () => {
      box(x, y, 0, 4, 4, 32, 1, 0, '#333');       // pole
      box(x, y, 32, 10, 10, 26, 1, 0, '#1a1a1a'); // lamp housing
      if (fx * Math.sin(cam.angle) + fy * Math.cos(cam.angle) <= 0) return; // lamps face away
      [['RED', 53, '#ff3b30'], ['YELLOW', 44, '#ffcc00'], ['GREEN', 35, '#2ecc71']].forEach(([name, z, col]) => {
        const p = P(x + fx * 5.2, y + fy * 5.2, z), on = st === name, r = 3.6 * p.sc;
        if (on) { ctx.fillStyle = col + '55'; circle(p.x, p.y, r * 2.2); }
        ctx.fillStyle = on ? col : '#3b3b3b'; circle(p.x, p.y, r);
      });
    }
  };
}

// ---------- Draw one frame ----------
function render() {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#bfe3f7'); g.addColorStop(1, '#e9f5fb');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  flat(-1500, -1500, 1500, 1500, '#4f9142');                       // ground
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    flat(sx * 40, sy * 40, sx * 1500, sy * 1500, '#c9c9c4');       // sidewalk
    flat(sx * 54, sy * 54, sx * 1500, sy * 1500, '#58a04a');       // grass
  }
  flat(-40, -1500, 40, 1500, '#2f3237');                           // roads
  flat(-1500, -40, 1500, 40, '#2f3237');
  for (let k = 0; k < 4; k++) {                                    // markings, per arm
    for (let y = -1500; y < -62; y += 36) armFlat(k, -1.5, y, 1.5, y + 20, '#f4f4f4'); // lane divider
    armFlat(k, -39, -1500, -37, -40, '#f4f4f4'); armFlat(k, 37, -1500, 39, -40, '#f4f4f4'); // edges
    for (let i = 0; i < 8; i++) armFlat(k, -38 + i * 10, -51, -33 + i * 10, -42, '#f4f4f4'); // zebra
    armFlat(k, 1, -56, 39, -54, '#f4f4f4');                        // stop line
  }

  const items = scenery.map(sceneItem);
  state.vehicles.forEach(v => items.push(vehicleItem(v)));
  for (let k = 0; k < 4; k++) items.push(lightItem(k));
  items.forEach(i => i.shadow && i.shadow());                      // shadows first
  items.sort((a, b) => a.d - b.d).forEach(i => i.draw());          // far -> near (painter's algorithm)
}

// ---------- Dashboard ----------
function updateDashboard() {
  const c = counts();
  $('vN').textContent = c[0]; $('vE').textContent = c[1];
  $('vS').textContent = c[2]; $('vW').textContent = c[3];
  $('vTotal').textContent = c[0] + c[1] + c[2] + c[3];
  $('greenDir').textContent = state.group === 0 ? 'North / South' : 'East / West';
  const sig = state.phase === 'ALLRED' ? 'RED' : state.phase;
  $('signal').textContent = sig; $('signal').className = 'chip ' + sig.toLowerCase();
  $('timer').textContent = Math.ceil(Math.max(0, state.remaining)) + ' s';
  $('density').textContent = backend.density;
  $('flow').textContent = flow() + ' veh/min';
}

// ---------- Controls ----------
$('btnStart').onclick = () => running = true;
$('btnPause').onclick = () => running = false;
$('btnReset').onclick = () => { running = false; reset(); };
$('selDensity').onchange = e => density = e.target.value;
$('selSpeed').onchange = e => speed = +e.target.value;
document.querySelectorAll('[data-cam]').forEach(b => b.onclick = () => {
  const a = b.dataset.cam;
  if (a === 'left') cam.angle -= 0.15;  if (a === 'right') cam.angle += 0.15;
  if (a === 'up') cam.tilt = Math.min(0.95, cam.tilt + 0.08);
  if (a === 'down') cam.tilt = Math.max(0.25, cam.tilt - 0.08);
  if (a === 'in') cam.zoom = Math.min(2.2, cam.zoom * 1.15);
  if (a === 'out') cam.zoom = Math.max(0.5, cam.zoom / 1.15);
});
let drag = null;
canvas.onmousedown = e => drag = { x: e.clientX, y: e.clientY };
window.onmouseup = () => drag = null;
window.onmousemove = e => {
  if (!drag) return;
  cam.angle -= (e.clientX - drag.x) * 0.008;
  cam.tilt = Math.max(0.25, Math.min(0.95, cam.tilt + (e.clientY - drag.y) * 0.004));
  drag = { x: e.clientX, y: e.clientY };
};

// ---------- Start ----------
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (running) for (let i = 0; i < speed; i++) update(dt);   // 2x/5x = more steps per frame
  if (canvas.clientWidth !== W || canvas.clientHeight !== H) resize();
  render(); updateDashboard();
  requestAnimationFrame(frame);
}
reset(); resize(); poll(); setInterval(poll, 1000);
requestAnimationFrame(frame);