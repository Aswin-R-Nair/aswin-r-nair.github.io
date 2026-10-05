// ===========================================================================
// koi pond - simulation + ascii rasteriser
// World space is isotropic: 1 unit = 1 cell WIDTH. A cell is 1/ASPECT tall.
//
// Usage: const pond = createKoiPond(mountEl);  ...  pond.destroy();
// The mount element is sized by the page's CSS; the pond fits itself inside it.
// Palette comes from CSS custom properties on the mount (see koi-pond.css).
// ===========================================================================

function createKoiPond(mount) {
  'use strict';

  // The grid adapts to the container. REF_* is the reference file's fixed
  // grid; fish and lily density are calibrated to it.
  const REF_COLS = 116, REF_ROWS = 46;
  const MIN_FONT = 6, MAX_FONT = 14, MAX_COLS = 240;
  const MIN_COLS = 72;                    // keeps koi in proportion on narrow screens
  let COLS = REF_COLS, ROWS = REF_ROWS;
  let N = COLS * ROWS;

  // palette layer ids -------------------------------------------------------
  const L_NONE = 0, L_WATER = 1, L_SHORE = 2, L_SHADOW = 3,
        L_WHITE = 4, L_ORANGE = 5, L_BLACK = 6, L_DIM_W = 7, L_DIM_O = 8,
        L_DIM_K = 9, L_LILY = 10, L_FOOD = 11, L_GLINT = 12,
        L_DIM_FOOD = 13;
  const LAYER_COUNT = 14;


  // -------------------------------------------------------------------------
  // buffers, reallocated only when the grid size changes
  // -------------------------------------------------------------------------
  let cellChar, cellLayer, waterField;

  let ASPECT = 0.5;                       // cellW / cellH, measured at runtime
  const toCellY = wy => wy * ASPECT;      // world y -> cell y
  const toWorldY = cy => cy / ASPECT;

  function hash2(a, b) {
    let h = a * 374761393 + b * 668265263;
    h = (h ^ (h >> 13)) * 1274126177;
    return ((h ^ (h >> 16)) >>> 0) / 4294967296;
  }

  // -------------------------------------------------------------------------
  // pond shape: a rounded box filling the grid. The boundary is never drawn;
  // it only steers the fish and fades the waves out before the edge.
  // negative inside, positive outside, roughly in world units
  // -------------------------------------------------------------------------
  let PW = COLS, PH = toWorldY(ROWS);
  const EDGE_MARGIN = 3;                  // world units between box and grid edge
  const WAVE_FADE = 16;                   // waves thin out over this distance
  const POOL_SHAPE = 3.5;                   // tint outline: 2 = ellipse, higher = squarer
  const POOL_FADE = 0.2;                 // tint fades over this outer fraction
  // The pond never moves, so its distance field and its wave mask are
  // computed once and memcpy'd in at the start of every frame. Evaluating an
  // SDF per cell per frame is pure waste.
  let sdCache, bgChar, bgLayer, inPond, waveMask, rowbuf;

  function allocate(cols, rows) {
    COLS = cols; ROWS = rows; N = COLS * ROWS;
    cellChar   = new Uint8Array(N);
    cellLayer  = new Uint8Array(N);
    waterField = new Float32Array(N);
    sdCache    = new Float32Array(N);
    bgChar     = new Uint8Array(N);
    bgLayer    = new Uint8Array(N);
    inPond     = new Uint8Array(N);
    waveMask   = new Uint8Array(N);
    rowbuf     = new Uint8Array(COLS);
  }

  function buildPond() {
    PW = COLS; PH = toWorldY(ROWS);
    for (let cy = 0; cy < ROWS; cy++) {
      const wy = toWorldY(cy + 0.5);
      for (let cx = 0; cx < COLS; cx++) {
        const i = cy * COLS + cx;
        const sd = sdPond(cx + 0.5, wy);
        sdCache[i] = sd;
        bgChar[i] = 32;
        // static dither: wave glyphs get sparser towards the edge, so the
        // water has no visible outline
        waveMask[i] = hash2(cx, cy) < Math.min(1, -sd / WAVE_FADE) ? 1 : 0;
        if (sd <= 0) { inPond[i] = 1; bgLayer[i] = L_WATER; }
        else         { inPond[i] = 0; bgLayer[i] = L_NONE; }
      }
    }
  }
  function sdPond(x, y) {                 // rounded box
    const hx = PW / 2 - EDGE_MARGIN, hy = PH / 2 - EDGE_MARGIN;
    const r = Math.min(hx, hy) * 0.6;
    const qx = Math.abs(x - PW / 2) - (hx - r);
    const qy = Math.abs(y - PH / 2) - (hy - r);
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
         + Math.min(Math.max(qx, qy), 0) - r;
  }
  function pondGradient(x, y) {           // outward normal, finite difference
    const e = 0.8;
    const gx = sdPond(x + e, y) - sdPond(x - e, y);
    const gy = sdPond(x, y + e) - sdPond(x, y - e);
    const m = Math.hypot(gx, gy) || 1e-6;
    return { x: gx / m, y: gy / m };
  }

  // -------------------------------------------------------------------------
  // koi
  // -------------------------------------------------------------------------
  const JOINTS = 7;

  // a pattern is a list of {from, to, layer} spans along the body, painted in
  // order over the base colour. s = 0 at the nose, 1 at the tail tip.
  const VARIETIES = [
    { base: L_WHITE,  dim: L_DIM_W, marks: [ {from:.10,to:.34,c:L_ORANGE,d:L_DIM_O},
                                             {from:.52,to:.74,c:L_ORANGE,d:L_DIM_O} ] },
    { base: L_ORANGE, dim: L_DIM_O, marks: [ {from:.62,to:.80,c:L_WHITE, d:L_DIM_W} ] },
    { base: L_WHITE,  dim: L_DIM_W, marks: [ {from:.16,to:.30,c:L_BLACK, d:L_DIM_K},
                                             {from:.40,to:.66,c:L_ORANGE,d:L_DIM_O},
                                             {from:.70,to:.84,c:L_BLACK, d:L_DIM_K} ] },
    { base: L_BLACK,  dim: L_DIM_K, marks: [ {from:.30,to:.58,c:L_ORANGE,d:L_DIM_O} ] },
    { base: L_ORANGE, dim: L_DIM_O, marks: [] },
    { base: L_WHITE,  dim: L_DIM_W, marks: [ {from:.44,to:.62,c:L_BLACK, d:L_DIM_K} ] },
  ];

  let nextId = 0;
  function makeKoi(x, y) {
    const len = 13 + Math.random() * 8;
    const k = {
      id: nextId++,
      len,
      segLen: len / (JOINTS - 1) * 0.82,
      width: len * 0.235,
      spine: [],
      heading: Math.random() * Math.PI * 2,
      turnTarget: 0,
      speed: 3 + Math.random() * 2,
      cruise: 3 + Math.random() * 2,
      z: Math.random(),                   // 0 = surface, 1 = pond floor
      zTarget: Math.random(),
      beat: Math.random() * 6.283,
      wanderPhase: Math.random() * 100,
      variety: VARIETIES[(Math.random() * VARIETIES.length) | 0],
      surfacedAt: -99,
    };
    for (let i = 0; i < JOINTS; i++) {
      k.spine.push({ x: x - Math.cos(k.heading) * k.segLen * i,
                     y: y - Math.sin(k.heading) * k.segLen * i });
    }
    return k;
  }

  const koi = [];
  const food = [];      // {x, y, z, life, floats}

  // Food sinks slowly to the floor (z = 1) and fades with depth; a share of
  // each handful floats on the surface instead. Koi only eat food at roughly
  // their own depth, so they dive after the sinking pellets.
  const SINK_RATE = 0.055;              // depth per second: ~22s to the floor
  const FLOAT_CHANCE = 0.3;
  const EAT_DEPTH = 0.18;
  const ripples = [];   // {x, y, t0, amp, speed}

  function spawnRipple(x, y, amp = 1, speed = 9) {
    if (ripples.length > 28) ripples.shift();
    ripples.push({ x, y, t0: simTime, amp, speed });
  }

  function init(seedFish = 11) {
    koi.length = 0;
    let guard = 0;
    while (koi.length < seedFish && guard++ < 4000) {
      const x = Math.random() * PW, y = Math.random() * PH;
      if (sdPond(x, y) < -8) koi.push(makeKoi(x, y));
    }
  }

  // -------------------------------------------------------------------------
  // steering + integration
  // -------------------------------------------------------------------------
  let simTime = 0;

  function angleDiff(a, b) {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  function update(dt) {
    simTime += dt;

    for (let i = food.length - 1; i >= 0; i--) {
      food[i].life -= dt;
      if (!food[i].floats) food[i].z = Math.min(1, food[i].z + dt * SINK_RATE);
      if (food[i].life <= 0) food.splice(i, 1);
    }
    for (let i = ripples.length - 1; i >= 0; i--) {
      if (simTime - ripples[i].t0 > 6) ripples.splice(i, 1);
    }

    for (const k of koi) {
      const head = k.spine[0];
      let desired = k.heading;
      let urgency = 0;

      // --- seek food ----------------------------------------------------
      // nearest pellet, with depth difference counted so koi prefer food
      // already near their own depth
      let best = null, bestD = 999, bestScore = 999;
      for (const f of food) {
        const d = Math.hypot(f.x - head.x, f.y - head.y);
        const score = d + Math.abs(f.z - k.z) * 20;
        if (d < 46 && score < bestScore) { bestScore = score; bestD = d; best = f; }
      }
      if (best) {
        desired = Math.atan2(best.y - head.y, best.x - head.x);
        urgency = 1.7;
        k.zTarget = best.z;
        if (bestD < 2.2 && Math.abs(best.z - k.z) < EAT_DEPTH) {
          food.splice(food.indexOf(best), 1);
          if (best.z < 0.15) {                      // only surface bites ripple
            spawnRipple(head.x, head.y, 1.3, 11);
            k.surfacedAt = simTime;
          }
        }
      } else {
        // --- wander: smooth low-frequency drift -------------------------
        k.wanderPhase += dt * 0.5;
        desired = k.heading + Math.sin(k.wanderPhase * 1.31) * 0.9
                            + Math.sin(k.wanderPhase * 0.47 + k.id) * 0.7;
        urgency = 0.35;
      }

      // --- separation ---------------------------------------------------
      let sx = 0, sy = 0, near = 0;
      for (const o of koi) {
        if (o === k) continue;
        const dx = head.x - o.spine[0].x, dy = head.y - o.spine[0].y;
        const dz = Math.abs(k.z - o.z);
        const d = Math.hypot(dx, dy);
        if (d < 19 && d > 0.001 && dz < 0.34) {
          sx += dx / (d * d); sy += dy / (d * d); near++;
        }
      }
      if (near) {
        const sa = Math.atan2(sy, sx);
        desired = k.heading + angleDiff(k.heading, sa) * 0.55;
        urgency = Math.max(urgency, 0.8);
      }

      // --- shore avoidance: look ahead, steer along the inward gradient --
      const la = 7 + k.speed;
      const ax = head.x + Math.cos(k.heading) * la;
      const ay = head.y + Math.sin(k.heading) * la;
      const sd = sdPond(ax, ay);
      if (sd > -5) {
        const g = pondGradient(head.x, head.y);
        const inward = Math.atan2(-g.y, -g.x);
        const push = Math.min(1, (sd + 5) / 9);
        desired = k.heading + angleDiff(k.heading, inward) * (0.35 + push * 0.8);
        urgency = Math.max(urgency, 1.1 + push);
      }
      // hard backstop so a fish can never escape the pond
      if (sdPond(head.x, head.y) > -1) {
        const g = pondGradient(head.x, head.y);
        k.heading = Math.atan2(-g.y, -g.x);
        desired = k.heading;
      }

      // --- limited turn rate --------------------------------------------
      const maxTurn = (1.0 + urgency * 1.3) * dt;
      const want = angleDiff(k.heading, desired);
      k.heading += Math.max(-maxTurn, Math.min(maxTurn, want));

      // --- speed: koi accelerate hard, decelerate lazily -----------------
      const targetSpeed = k.cruise * (best ? 2.5 : 1) * (1 - Math.abs(want) * 0.25);
      k.speed += (targetSpeed - k.speed) * dt * (targetSpeed > k.speed ? 3 : 0.9);

      // --- depth ---------------------------------------------------------
      if (!best && Math.random() < dt * 0.12) k.zTarget = Math.random();
      k.z += (k.zTarget - k.z) * dt * (best ? 1.6 : 0.5);   // dive quickly for food
      if (k.z < 0.12 && simTime - k.surfacedAt > 2.5 && Math.random() < dt * 1.2) {
        spawnRipple(head.x, head.y, 0.5 + Math.random() * 0.4, 8);
        k.surfacedAt = simTime;
      }

      // --- tail beat frequency tracks speed. this is what sells it. ------
      k.beat += dt * (2.2 + k.speed * 0.62);

      // --- integrate head, drag the chain --------------------------------
      head.x += Math.cos(k.heading) * k.speed * dt;
      head.y += Math.sin(k.heading) * k.speed * dt;
      for (let i = 1; i < JOINTS; i++) {
        const p = k.spine[i - 1], c = k.spine[i];
        const dx = c.x - p.x, dy = c.y - p.y;
        const d = Math.hypot(dx, dy) || 1e-6;
        c.x = p.x + dx / d * k.segLen;
        c.y = p.y + dy / d * k.segLen;
      }
    }
  }

  // -------------------------------------------------------------------------
  // water
  // -------------------------------------------------------------------------
  function renderWater() {
    cellChar.set(bgChar);
    cellLayer.set(bgLayer);

    // pass 1: the standing swell
    for (let cy = 0; cy < ROWS; cy++) {
      const wy = toWorldY(cy + 0.5);
      const base = cy * COLS;
      for (let cx = 0; cx < COLS; cx++) {
        const i = base + cx;
        if (!inPond[i]) { waterField[i] = 0; continue; }
        const wx = cx + 0.5;
        waterField[i] =
            Math.sin(wx * 0.17 + simTime * 0.55) * 0.55
          + Math.sin(wy * 0.29 - simTime * 0.41) * 0.45
          + Math.sin((wx * 0.7 + wy) * 0.21 + simTime * 0.9) * 0.40
          + Math.sin((wx - wy * 0.8) * 0.26 - simTime * 0.7) * 0.30;
      }
    }

    // pass 2: ripples, touching only the cells inside each expanding ring.
    // Testing every ripple against every cell is the obvious version and it
    // costs ~30x more for identical output.
    for (let r = 0; r < ripples.length; r++) {
      const rp = ripples[r];
      const age = simTime - rp.t0;
      const rad = age * rp.speed;
      const reach = rad + 9;
      const decay = Math.exp(-age * 0.6) * rp.amp;
      if (decay < 0.02) continue;

      const x0 = Math.max(0, Math.floor(rp.x - reach));
      const x1 = Math.min(COLS - 1, Math.ceil(rp.x + reach));
      const y0 = Math.max(0, Math.floor(toCellY(rp.y - reach)));
      const y1 = Math.min(ROWS - 1, Math.ceil(toCellY(rp.y + reach)));

      for (let cy = y0; cy <= y1; cy++) {
        const dy = toWorldY(cy + 0.5) - rp.y;
        const base = cy * COLS;
        for (let cx = x0; cx <= x1; cx++) {
          const i = base + cx;
          if (!inPond[i]) continue;
          const dx = cx + 0.5 - rp.x;
          const d = Math.sqrt(dx * dx + dy * dy);
          const off = d - rad;
          if (off > 9 || off < -9) continue;
          waterField[i] += Math.sin(off * 1.15) * Math.exp(-Math.abs(off) * 0.38) * decay * 3.0;
        }
      }
    }

    // pass 3: contour lines of the height field. Thin strokes read as light
    // on water; a filled density ramp reads as fog and buries the koi.
    const SPACING = 1.15, EPS = 0.17;
    for (let i = 0; i < N; i++) {
      if (!waveMask[i]) continue;
      const h = waterField[i];
      const lvl = Math.round(h / SPACING) * SPACING;
      const off = h < lvl ? lvl - h : h - lvl;
      if (off > EPS) continue;
      const strong = (lvl > 0.9 || lvl < -0.9) || off < 0.07;
      cellChar[i] = strong ? 126 : 46;                 // '~' crest, '.' faint
      cellLayer[i] = strong ? L_GLINT : L_WATER;
    }
  }

  // -------------------------------------------------------------------------
  // koi rasterisation
  // -------------------------------------------------------------------------

  // body half-width as a function of s (0 nose, 1 tail tip)
  function halfWidth(s, w) {
    if (s < 0.80) {
      const u = s / 0.80;
      // fast rise from the snout, broad shoulder around u=0.3, slow taper
      return w * Math.pow(Math.sin(Math.PI * Math.pow(u, 0.62)), 0.75);
    }
    const u = (s - 0.80) / 0.20;          // caudal fin flares back out
    return w * (0.18 + u * u * 0.95);
  }

  const _sa = { x: 0, y: 0 }, _sb = { x: 0, y: 0 };
  function spineAt(k, s, out) {
    const f = s * (JOINTS - 1);
    const i = Math.min(JOINTS - 2, f | 0);
    const t = f - i;
    const a = k.spine[i], b = k.spine[i + 1];
    out.x = a.x + (b.x - a.x) * t;
    out.y = a.y + (b.y - a.y) * t;
    return out;
  }

  function slopeChar(dxCell, dyCell) {
    const a = Math.abs(dyCell) / (Math.abs(dxCell) + 1e-6);
    if (a < 0.45) return 45;                        // -
    if (a > 2.4)  return 124;                       // |
    return (dxCell * dyCell < 0) ? 47 : 92;         // / or backslash
  }

  function stamp(cx, cy, ch, layer) {
    if (cx < 0 || cx >= COLS || cy < 0 || cy >= ROWS) return;
    const i = cy * COLS + cx;
    cellChar[i] = ch;
    cellLayer[i] = layer;
  }

  function layerFor(k, s, deep) {
    let lay = deep ? k.variety.dim : k.variety.base;
    for (const m of k.variety.marks) {
      if (s >= m.from && s <= m.to) lay = deep ? m.d : m.c;
    }
    return lay;
  }

  function renderKoi(k, shadowPass) {
    const deep = k.z > 0.45;
    const scale = 1 - k.z * 0.18;                  // deeper reads slightly smaller
    const w = k.width * scale;
    const shX = k.z * 2.6, shY = k.z * 2.2;        // shadow offset on the floor

    const STEPS = 34;
    for (let n = 0; n <= STEPS; n++) {
      const s = n / STEPS;
      const p = spineAt(k, s, _sa);
      const q = spineAt(k, Math.min(1, s + 0.03), _sb);
      let dx = q.x - p.x, dy = q.y - p.y;
      const dl = Math.hypot(dx, dy) || 1e-6;
      dx /= dl; dy /= dl;
      const px = -dy, py = dx;                     // perpendicular, world space

      // tail wave, applied at render time only
      const wave = Math.sin(k.beat - s * 4.4) * s * s * k.len * 0.14;

      const hw = halfWidth(s, w);
      const isFin = s > 0.80;
      const lay = shadowPass ? L_SHADOW : layerFor(k, s, deep);

      for (let t = -hw; t <= hw + 0.001; t += 0.55) {
        const wx = p.x + px * (t + wave);
        const wy = p.y + py * (t + wave);

        if (shadowPass) {
          const cx = Math.round(wx + shX);
          const cy = Math.round(toCellY(wy + shY));
          if (Math.abs(t) < hw * 0.85) stamp(cx, cy, 58, L_SHADOW);   // ':'
          continue;
        }

        const cx = Math.round(wx);
        const cy = Math.round(toCellY(wy));
        if (cx < 0 || cx >= COLS || cy < 0 || cy >= ROWS) continue;

        const r = Math.abs(t) / (hw || 1e-6);
        const dxc = dx, dyc = dy * ASPECT;

        let ch;
        if (isFin) {
          ch = (r > 0.5) ? slopeChar(px, py * ASPECT) : 61;           // '='
        } else if (r < 0.58) {
          ch = deep ? 37 : 35;                                        // '#' near, '%' deep
        } else if (r < 0.88) {
          ch = deep ? 61 : 37;                                        // '%' near, '=' deep
        } else {
          ch = slopeChar(dxc, dyc);
        }

        // surface ripples pass over the fish: bright crests thin the body out
        const wf = waterField[cy * COLS + cx];
        if (!deep && wf > 1.15 && r > 0.45) ch = 126;                 // '~'

        stamp(cx, cy, ch, lay);
      }
    }
  }

  // -------------------------------------------------------------------------
  // lily pads + food
  // -------------------------------------------------------------------------
  const lilies = [];
  function seedLilies(count = 5) {
    lilies.length = 0;
    let guard = 0;
    while (lilies.length < count && guard++ < 3000) {
      const x = Math.random() * PW, y = Math.random() * PH;
      if (sdPond(x, y) > -11) continue;
      if (lilies.some(l => Math.hypot(l.x - x, l.y - y) < 26)) continue;
      lilies.push({ x, y, r: 3.4 + Math.random() * 2.4,
                    notch: Math.random() * 6.283, bob: Math.random() * 6.283 });
    }
  }

  function renderLilies() {
    for (const l of lilies) {
      const bob = Math.sin(simTime * 0.6 + l.bob) * 0.35;
      const r = l.r + bob;
      for (let cy = Math.floor(toCellY(l.y - r)) - 1; cy <= toCellY(l.y + r) + 1; cy++) {
        for (let cx = Math.floor(l.x - r) - 1; cx <= l.x + r + 1; cx++) {
          if (cx < 0 || cx >= COLS || cy < 0 || cy >= ROWS) continue;
          const wx = cx + 0.5, wy = toWorldY(cy + 0.5);
          const dx = wx - l.x, dy = wy - l.y;
          const d = Math.hypot(dx, dy);
          if (d > r) continue;
          const a = Math.atan2(dy, dx);
          if (Math.abs(angleDiff(a, l.notch)) < 0.34) continue;   // the wedge cut
          stamp(cx, cy, d > r - 1.2 ? 111 : 64, L_LILY);          // 'o' rim, '@' body
        }
      }
    }
  }

  // bright 'o' near the surface, dim 'o' mid-water, dim '.' near the floor
  function renderPellet(f) {
    const cx = Math.round(f.x), cy = Math.round(toCellY(f.y));
    if (f.z < 0.35)      stamp(cx, cy, 111, L_FOOD);
    else if (f.z < 0.7)  stamp(cx, cy, 111, L_DIM_FOOD);
    else                 stamp(cx, cy, 46,  L_DIM_FOOD);
  }

  const SURFACE_Z = 0.05;               // at or above this, drawn over everything

  // -------------------------------------------------------------------------
  // frame
  // -------------------------------------------------------------------------
  function renderFrame() {
    renderWater();
    const sorted = koi.slice().sort((a, b) => b.z - a.z);   // deepest first
    for (const k of sorted) renderKoi(k, true);             // shadows
    // sunken pellets are interleaved with the koi by depth, so a koi
    // swimming above a pellet hides it
    const sunk = food.filter(f => f.z > SURFACE_Z).sort((a, b) => b.z - a.z);
    let j = 0;
    for (const k of sorted) {
      while (j < sunk.length && sunk[j].z >= k.z) renderPellet(sunk[j++]);
      renderKoi(k, false);
    }
    while (j < sunk.length) renderPellet(sunk[j++]);
    renderLilies();
    for (const f of food) if (f.z <= SURFACE_Z) renderPellet(f);
  }

  function dropFood(wx, wy, count = 6) {
    for (let i = 0; i < count; i++) {
      const x = wx + (Math.random() - 0.5) * 7;
      const y = wy + (Math.random() - 0.5) * 7;
      if (sdPond(x, y) >= -2) continue;
      const floats = Math.random() < FLOAT_CHANCE;
      // sinkers get time to reach the floor and rest there a while
      food.push({ x, y, z: 0, life: floats ? 22 : 32, floats });
    }
    spawnRipple(wx, wy, 1.5, 12);
  }

  function setAspect(a) { ASPECT = a; buildPond(); }

  // =========================================================================
  // browser driver: sizing, colour layers, canvas underlay, input, loop
  // =========================================================================

  const pond = document.createElement('div');
  pond.className = 'koi-pond__stage';
  const bg = document.createElement('canvas');
  pond.appendChild(bg);

  // one <pre> per palette colour, stacked. Because the frame is composited
  // into a single cell buffer first, exactly one layer holds a glyph at any
  // cell, so the layers never fight each other.
  const LAYER_VAR = [];
  LAYER_VAR[L_WATER]  = '--water-faint';
  LAYER_VAR[L_GLINT]  = '--glint';
  LAYER_VAR[L_SHADOW] = '--shadow';
  LAYER_VAR[L_WHITE]  = '--koi-white';
  LAYER_VAR[L_ORANGE] = '--koi-orange';
  LAYER_VAR[L_BLACK]  = '--koi-black';
  LAYER_VAR[L_DIM_W]  = '--dim-white';
  LAYER_VAR[L_DIM_O]  = '--dim-orange';
  LAYER_VAR[L_DIM_K]  = '--dim-black';
  LAYER_VAR[L_LILY]   = '--lily';
  LAYER_VAR[L_FOOD]   = '--food';
  LAYER_VAR[L_DIM_FOOD] = '--dim-food';

  const layerEls = [];
  for (let L = 1; L < LAYER_COUNT; L++) {
    if (!LAYER_VAR[L]) continue;
    const el = document.createElement('pre');
    el.style.color = `var(${LAYER_VAR[L]})`;
    el.setAttribute('aria-hidden', 'true');
    pond.appendChild(el);
    layerEls[L] = el;
  }
  mount.appendChild(pond);

  // ------------------------------------------------------------- sizing
  let cellW = 8, cellH = 16;

  // The font size is set from the container height, then the grid takes as
  // many columns and rows as fit, so a wide container gets a wide pond
  // rather than a letterboxed one. Fish and lily counts scale with area.
  function fishCount() { return Math.max(4, Math.round(7 * N / (REF_COLS * REF_ROWS))); }
  function lilyCount() { return Math.max(2, Math.round(5 * N / (REF_COLS * REF_ROWS))); }

  // returns true when the grid size changed
  function fitAndMeasure() {
    const availW = mount.clientWidth;
    const availH = mount.clientHeight;

    // 0.6 is only the initial guess; the real ratio is measured below
    // from the height, but small enough for MIN_COLS across: a tall phone
    // screen would otherwise give ~40 columns and koi half the screen wide
    const size = Math.max(MIN_FONT, Math.min(MAX_FONT, availH / REF_ROWS, availW / (MIN_COLS * 0.6)));
    pond.style.fontSize = size.toFixed(2) + 'px';

    // The probe lives inside the stage so it inherits the real font, but it
    // must explicitly cancel `inset: 0` from the `.koi-pond pre` rule. Without
    // that it stretches to the container, which is still 0x0 on first run,
    // and reports a cell size of zero -- collapsing the entire scene silently.
    const probe = document.createElement('pre');
    probe.style.cssText = 'position:absolute;inset:auto;top:0;left:0;' +
                          'width:auto;height:auto;visibility:hidden;margin:0;' +
                          'padding:0;white-space:pre;font:inherit;line-height:1;';
    probe.textContent = 'X'.repeat(100) + '\nX';
    pond.appendChild(probe);
    const r = probe.getBoundingClientRect();
    probe.remove();

    if (r.width > 0 && r.height > 0) {
      cellW = r.width / 100;
      cellH = r.height / 2;
    } else {
      cellW = size * 0.6; cellH = size;    // fall back rather than collapse
    }

    const cols = Math.max(24, Math.min(MAX_COLS, Math.floor(availW / cellW)));
    const rows = Math.max(16, Math.floor(availH / cellH));
    const regrid = !cellChar || cols !== COLS || rows !== ROWS;
    if (regrid) allocate(cols, rows);

    const oldPW = PW, oldPH = PH;
    setAspect(cellW / cellH);
    if (PW !== oldPW || PH !== oldPH) rescaleWorld(PW / oldPW, PH / oldPH);
    pond.style.width  = (COLS * cellW) + 'px';
    pond.style.height = (ROWS * cellH) + 'px';
    paintUnderlay();
    return regrid;
  }

  // Keep the existing fish when the pond is resized: stretch everything to
  // the new world size. Segment lengths are restored by the next update.
  function rescaleWorld(sx, sy) {
    for (const k of koi) for (const p of k.spine) { p.x *= sx; p.y *= sy; }
    for (const o of lilies) { o.x *= sx; o.y *= sy; }
    for (const o of food) { o.x *= sx; o.y *= sy; }
    for (const o of ripples) { o.x *= sx; o.y *= sy; }
  }

  // ----------------------------------------------------- canvas underlay
  // The SDF already knows how deep every cell is. Painting that once into a
  // low-res canvas and letting the browser smooth it gives continuous depth
  // shading for free, which characters alone cannot do. It fades to fully
  // transparent well inside the boundary, so the page background shows at
  // the edges. The colours come from CSS so the underlay follows the page's
  // colour scheme.
  function cssRGB(name) {
    const v = getComputedStyle(mount).getPropertyValue(name).trim();
    const m = /^#([0-9a-f]{6})$/i.exec(v);
    const n = m ? parseInt(m[1], 16) : 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function paintUnderlay() {
    const shallow = cssRGB('--water-shallow'), deepC = cssRGB('--water-deep');
    bg.width = COLS; bg.height = ROWS;
    const ctx = bg.getContext('2d');
    const img = ctx.createImageData(COLS, ROWS);
    const d = img.data;
    for (let cy = 0; cy < ROWS; cy++) {
      for (let cx = 0; cx < COLS; cx++) {
        // 0 shallow, 1 deep. Shaded as an oval pool over the whole grid, not
        // from the box SDF: in a wide box the SDF is deepest along a long
        // centre line, which reads as a stripe rather than water.
        // Full colour over most of the pool, fading out over the outer band.
        const nx = (cx + 0.5) / COLS * 2 - 1, ny = (cy + 0.5) / ROWS * 2 - 1;
        const r = Math.pow(Math.pow(Math.abs(nx), POOL_SHAPE) + Math.pow(Math.abs(ny), POOL_SHAPE), 1 / POOL_SHAPE);
        const u = Math.max(0, Math.min(1, (1 - r) / POOL_FADE));
        if (u === 0) continue;                         // outside: transparent
        const t = u * u * (3 - 2 * u);
        const i = (cy * COLS + cx) * 4;
        d[i]   = shallow[0] + (deepC[0] - shallow[0]) * t;
        d[i+1] = shallow[1] + (deepC[1] - shallow[1]) * t;
        d[i+2] = shallow[2] + (deepC[2] - shallow[2]) * t;
        d[i+3] = 255 * t;                              // no visible edge
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  // ---------------------------------------------------------- layer flush
  function flush() {
    for (let L = 1; L < LAYER_COUNT; L++) {
      const el = layerEls[L];
      if (!el) continue;
      let out = '';
      for (let y = 0; y < ROWS; y++) {
        const base = y * COLS;
        for (let x = 0; x < COLS; x++) {
          const i = base + x;
          rowbuf[x] = (cellLayer[i] === L) ? cellChar[i] : 32;
        }
        out += String.fromCharCode.apply(null, rowbuf);
        if (y < ROWS - 1) out += '\n';
      }
      el.textContent = out;
    }
  }

  function draw() { renderFrame(); flush(); }

  function seed() {
    food.length = 0; ripples.length = 0;
    init(fishCount());
    seedLilies(lilyCount());
    for (let i = 0; i < 60; i++) update(1 / 24);   // settle before first paint
  }

  // after a regrid, top the fish and lilies up (or down) to suit the new area
  function repopulate() {
    const target = fishCount();
    koi.length = Math.min(koi.length, target);
    let guard = 0;
    while (koi.length < target && guard++ < 4000) {
      const x = Math.random() * PW, y = Math.random() * PH;
      if (sdPond(x, y) < -8) koi.push(makeKoi(x, y));
    }
    if (lilies.length !== lilyCount()) seedLilies(lilyCount());
  }

  function refit() {
    if (fitAndMeasure()) { if (koi.length) repopulate(); else seed(); }
    draw();
  }

  // --------------------------------------------------------------- input
  // Reduced motion: the pond is a still picture and does not take food.
  const motionOK = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!motionOK) mount.classList.add('koi-pond--still');

  function feedAt(clientX, clientY) {
    const r = pond.getBoundingClientRect();
    const cx = (clientX - r.left) / r.width * COLS;
    const cy = (clientY - r.top) / r.height * ROWS;
    dropFood(cx, cy / (cellW / cellH), 7);
  }
  function onPointerDown(e) { e.preventDefault(); feedAt(e.clientX, e.clientY); }
  if (motionOK) pond.addEventListener('pointerdown', onPointerDown);

  // ---------------------------------------------------------------- loop
  // 24fps. Faster makes the ramp dither into static; slower makes the koi
  // look like they are teleporting between cells.
  // Runs only while the pond is on screen and the tab is visible.
  const FPS = 24, INTERVAL = 1000 / FPS;
  let last = 0, rafId = 0, inView = false, destroyed = false;

  function tick(now) {
    rafId = requestAnimationFrame(tick);
    const elapsed = now - last;
    if (elapsed < INTERVAL) return;
    last = now - (elapsed % INTERVAL);
    update(Math.min(0.1, elapsed / 1000));
    draw();
  }

  function syncLoop() {
    const run = motionOK && inView && !document.hidden && !destroyed;
    if (run && !rafId) {
      last = performance.now();
      rafId = requestAnimationFrame(tick);
    } else if (!run && rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  const io = new IntersectionObserver(entries => {
    inView = entries[entries.length - 1].isIntersecting;
    syncLoop();
  });
  io.observe(mount);
  document.addEventListener('visibilitychange', syncLoop);

  let resizeTimer = 0, lastW = -1, lastH = -1;
  const ro = new ResizeObserver(() => {
    const w = mount.clientWidth, h = mount.clientHeight;
    if (w === lastW && h === lastH) return;
    const first = lastW < 0;
    lastW = w; lastH = h;
    clearTimeout(resizeTimer);
    if (first) return;                    // boot() already fitted this size
    resizeTimer = setTimeout(refit, 120);
  });
  ro.observe(mount);

  // the water underlay is painted from CSS colours, so repaint it when the
  // site's theme flips (theme.js sets data-theme on <html>)
  const themeMO = new MutationObserver(paintUnderlay);
  themeMO.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  // boot
  refit();
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => { if (!destroyed) refit(); });
  }

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      syncLoop();
      clearTimeout(resizeTimer);
      io.disconnect();
      ro.disconnect();
      document.removeEventListener('visibilitychange', syncLoop);
      themeMO.disconnect();
      pond.removeEventListener('pointerdown', onPointerDown);
      pond.remove();
      mount.classList.remove('koi-pond--still');
    },
  };
}
