import * as THREE from 'three';
import { CONFIG } from './config.js';
import { pick } from './util.js';

const cv = (w, h) => {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return { c, g: c.getContext('2d') };
};
const tex = (c, { srgb = true, wrap = false } = {}) => {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (wrap) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  return t;
};

/* ═══════════════════════════════════════════════════════════════════════════
   КОРПУС: альбедо + маска каналов (R=вода, G=растительность, B=покрытие)
   Оба холста рисуются из одних и тех же секторов CONFIG.
   ═══════════════════════════════════════════════════════════════════════════ */
export function makeHullMaps(size, rnd) {
  const W = size, H = size, A = cv(W, H);
  const M = cv(CONFIG.MASK_TEX, CONFIG.MASK_TEX);
  const X = deg => (deg / 360) * W;
  const XM = deg => (deg / 360) * M.c.width;
  const a = A.g, m = M.g;
  const mh = M.c.height;

  /* маска: по умолчанию всё — растительность */
  m.fillStyle = '#00ff00'; m.fillRect(0, 0, M.c.width, mh);   // чистый G

  /* базовая почва переходных зон */
  a.fillStyle = '#54703c'; a.fillRect(0, 0, W, H);
  for (let i = 0; i < 6000; i++) {
    a.fillStyle = pick(rnd, ['#5e7a42', '#4b653a', '#66834a', '#48603a', '#6d8a4e']);
    a.globalAlpha = 0.3 + rnd() * 0.45;
    const s = 4 + rnd() * 26;
    a.fillRect(rnd() * W, rnd() * H, s, s * (0.4 + rnd()));
  }
  a.globalAlpha = 1;

  /* ── ПОЛЯ: пэчворк делянок ── */
  const fieldPal = ['#7d8f3e', '#96a24a', '#6d8438', '#b5ab52', '#c9bd63', '#5f7a33', '#8ea04a', '#a89b45', '#d0c778'];
  for (const [s0, s1] of CONFIG.SECT.fields) {
    const x0 = X(s0), x1 = X(s1);
    a.save(); a.beginPath(); a.rect(x0, 0, x1 - x0, H); a.clip();
    let y = -40;
    while (y < H + 40) {
      const bh = 46 + rnd() * 120;
      let x = x0 - 30;
      while (x < x1 + 30) {
        const bw = 44 + rnd() * 130, j = 8;
        a.fillStyle = pick(rnd, fieldPal);
        a.beginPath();
        a.moveTo(x + (rnd() - .5) * j, y + (rnd() - .5) * j);
        a.lineTo(x + bw + (rnd() - .5) * j, y + (rnd() - .5) * j);
        a.lineTo(x + bw + (rnd() - .5) * j, y + bh + (rnd() - .5) * j);
        a.lineTo(x + (rnd() - .5) * j, y + bh + (rnd() - .5) * j);
        a.closePath(); a.fill();
        a.globalAlpha = 0.13; a.strokeStyle = '#31401f'; a.lineWidth = 1;
        const step = 5 + rnd() * 8, horiz = rnd() < 0.5;
        a.beginPath();
        if (horiz) for (let k = y + step; k < y + bh; k += step) { a.moveTo(x, k); a.lineTo(x + bw, k); }
        else for (let k = x + step; k < x + bw; k += step) { a.moveTo(k, y); a.lineTo(k, y + bh); }
        a.stroke();
        a.globalAlpha = 0.22; a.strokeStyle = '#4d5f2c'; a.lineWidth = 3; a.strokeRect(x, y, bw, bh);
        a.globalAlpha = 1;
        x += bw;
      }
      y += bh;
    }
    a.globalAlpha = 0.3; a.strokeStyle = '#b9b08a'; a.lineWidth = 3;
    for (let i = 0; i < 8; i++) {
      const yy = rnd() * H;
      a.beginPath(); a.moveTo(x0, yy); a.lineTo(x1, yy + (rnd() - .5) * 40); a.stroke();
    }
    a.globalAlpha = 1; a.restore();
  }

  /* ── ПАРКИ ── */
  for (const [s0, s1] of CONFIG.SECT.parks) {
    const x0 = X(s0), x1 = X(s1);
    a.save(); a.beginPath(); a.rect(x0, 0, x1 - x0, H); a.clip();
    a.fillStyle = '#42682f'; a.fillRect(x0, 0, x1 - x0, H);
    for (let i = 0; i < 1800; i++) {
      a.fillStyle = pick(rnd, ['#4d7536', '#385c28', '#598040', '#6b8f45', '#2f4f22']);
      a.globalAlpha = 0.5 + rnd() * 0.5;
      a.beginPath();
      a.ellipse(x0 + rnd() * (x1 - x0), rnd() * H, 8 + rnd() * 44, 6 + rnd() * 32, rnd() * Math.PI, 0, 6.2832);
      a.fill();
    }
    a.globalAlpha = 0.5;
    for (let i = 0; i < 30; i++) {
      a.fillStyle = '#7d9a4e';
      a.beginPath();
      a.ellipse(x0 + rnd() * (x1 - x0), rnd() * H, 14 + rnd() * 48, 10 + rnd() * 36, rnd() * Math.PI, 0, 6.2832);
      a.fill();
    }
    /* гравийные дорожки — и в маску как покрытие */
    a.globalAlpha = 0.4; a.strokeStyle = '#c4b894'; a.lineWidth = 3;
    m.strokeStyle = '#000040'; m.lineWidth = 2;   // слабый B: зерно есть, фонарей нет
    for (let i = 0; i < 14; i++) {
      let px = x0 + rnd() * (x1 - x0), py = 0;
      const pts = [[px, py]];
      while (py < H) { py += 26; px += (rnd() - .5) * 48; pts.push([px, py]); }
      a.beginPath(); m.beginPath();
      a.moveTo(pts[0][0], pts[0][1]);
      m.moveTo(pts[0][0] / W * M.c.width, pts[0][1] / H * mh);
      for (const [qx, qy] of pts) { a.lineTo(qx, qy); m.lineTo(qx / W * M.c.width, qy / H * mh); }
      a.stroke(); m.stroke();
    }
    a.globalAlpha = 1; a.restore();
  }

  /* ── ГОРОДА ── */
  for (const [s0, s1] of CONFIG.SECT.cities) {
    const x0 = X(s0), x1 = X(s1);
    a.save(); a.beginPath(); a.rect(x0, 0, x1 - x0, H); a.clip();
    a.fillStyle = '#5a5f63'; a.fillRect(x0, 0, x1 - x0, H);
    /* Город в маске: сплошная заливка даёт лишь зернистость покрытия.
       Ярким B помечаются только магистрали — по нему шейдер зажигает
       уличные фонари. Раньше светился весь сектор целиком и ночью
       читался как подсвеченная снизу площадка. */
    m.fillStyle = '#000040'; m.fillRect(XM(s0), 0, XM(s1) - XM(s0), mh);

    const bs = Math.max(20, 34 * (W / 2048)), st = Math.max(8, 12 * (W / 2048));
    for (let y = -bs; y < H + bs; y += bs + st) {
      for (let x = x0 - bs; x < x1 + bs; x += bs + st) {
        if (rnd() < 0.1) {
          a.fillStyle = pick(rnd, ['#4f7038', '#5b7d3f']);
          a.fillRect(x, y, bs, bs);
          m.fillStyle = '#00ff00';
          m.fillRect(x / W * M.c.width, y / H * mh, bs / W * M.c.width, bs / H * mh);
          continue;
        }
        a.fillStyle = pick(rnd, ['#6e7377', '#787d81', '#63686c', '#82868a', '#585d61']);
        a.fillRect(x, y, bs, bs);
        const n = 2 + ((rnd() * 3) | 0), cell = bs / n;
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
          if (rnd() < 0.4) continue;
          a.fillStyle = pick(rnd, ['#8a8f93', '#565b60', '#767b80', '#9aa0a4', '#4e5358']);
          a.fillRect(x + i * cell + 1, y + j * cell + 1, cell - 2, cell - 2);
        }
      }
    }
    /* магистрали: и в альбедо, и ярким B в маску — это линии фонарей */
    const kx = M.c.width / W, ky = mh / H;
    m.strokeStyle = '#0000ff'; m.lineWidth = Math.max(2, st * kx * 0.8);
    for (let y = -bs; y < H + bs; y += (bs + st) * 3) {
      a.globalAlpha = 0.6; a.strokeStyle = '#3c4145'; a.lineWidth = Math.max(5, st);
      a.beginPath(); a.moveTo(x0, y); a.lineTo(x1, y); a.stroke();
      a.globalAlpha = 0.5; a.strokeStyle = '#e8d98a'; a.lineWidth = 1.5;
      a.beginPath(); a.moveTo(x0, y); a.lineTo(x1, y); a.stroke();
      m.beginPath(); m.moveTo(XM(s0), y * ky); m.lineTo(XM(s1), y * ky); m.stroke();
    }
    for (let x = x0; x < x1; x += (bs + st) * 3) {
      a.globalAlpha = 0.6; a.strokeStyle = '#3c4145'; a.lineWidth = Math.max(5, st);
      a.beginPath(); a.moveTo(x, 0); a.lineTo(x, H); a.stroke();
      m.beginPath(); m.moveTo(x * kx, 0); m.lineTo(x * kx, mh); m.stroke();
    }
    a.globalAlpha = 1;
    for (let i = 0; i < 6; i++) {
      a.fillStyle = '#9aa0a4'; a.globalAlpha = 0.7;
      a.beginPath(); a.arc(x0 + rnd() * (x1 - x0), rnd() * H, 20 + rnd() * 36, 0, 6.2832); a.fill();
      a.globalAlpha = 1;
    }
    a.restore();
  }

  /* ── РЕКИ: альбедо + канал воды в маске ── */
  for (const [s0, s1] of CONFIG.SECT.rivers) {
    const cx = X((s0 + s1) / 2), half = (X(s1) - X(s0)) / 2;
    const pts = [];
    for (let y = -20; y <= H + 20; y += 24) pts.push([cx + Math.sin(y * 0.011 + s0) * half * 0.55 + (rnd() - .5) * 6, y]);
    const stroke = (ctx, w, col, sx, sy) => {
      ctx.strokeStyle = col; ctx.lineWidth = w; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(pts[0][0] * sx, pts[0][1] * sy);
      for (const [px, py] of pts) ctx.lineTo(px * sx, py * sy);
      ctx.stroke();
    };
    stroke(a, half * 2 + 22, '#a8a173', 1, 1);
    stroke(a, half * 2 + 11, '#7f9a55', 1, 1);
    stroke(a, half * 2 - 2, '#2f5f8a', 1, 1);
    a.globalAlpha = 0.5; stroke(a, half * 0.8, '#4d86b5', 1, 1); a.globalAlpha = 1;
    /* маска воды: чуть уже русла, чтобы блик не лез на берег */
    stroke(m, (half * 2 - 6) / W * M.c.width, '#ff0000', M.c.width / W, mh / H);
  }

  /* ── техническая кромка у торцов ── */
  const edge = H * 0.022;
  a.fillStyle = '#6a6d72'; a.fillRect(0, 0, W, edge); a.fillRect(0, H - edge, W, edge);
  m.fillStyle = '#000040';
  m.fillRect(0, 0, M.c.width, edge / H * mh); m.fillRect(0, mh - edge / H * mh, M.c.width, edge / H * mh);
  a.globalAlpha = 0.5; a.strokeStyle = '#3a3e44'; a.lineWidth = 2;
  for (let x = 0; x < W; x += W / CONFIG.HULL_SEG) {
    a.beginPath(); a.moveTo(x, 0); a.lineTo(x, edge); a.moveTo(x, H - edge); a.lineTo(x, H); a.stroke();
  }
  a.globalAlpha = 1;

  if (CONFIG.DEBUG_UV_MARKER) { a.fillStyle = '#ff0033'; a.fillRect(X(0), 0, X(10) - X(0), H); }

  const albedo = tex(A.c, { wrap: true });
  const mask = tex(M.c, { srgb: false, wrap: true });
  return { albedo, mask };
}

/* ═══════════════════════════════════════════════════════════════════════════
   ДЕТАЛЬНЫЙ ШУМ — тайлится 70×70 по корпусу, лечит 1.5 м на тексель
   ═══════════════════════════════════════════════════════════════════════════ */
export function makeDetailTexture(rnd) {
  const S = 256, { c, g } = cv(S, S);
  g.fillStyle = '#808080'; g.fillRect(0, 0, S, S);
  /* волокна травы */
  for (let i = 0; i < 5000; i++) {
    const x = rnd() * S, y = rnd() * S, len = 2 + rnd() * 6, ang = rnd() * Math.PI;
    g.strokeStyle = rnd() < 0.5 ? 'rgba(255,255,255,.22)' : 'rgba(0,0,0,.22)';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, y);
    g.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    g.stroke();
  }
  /* крупные пятна */
  for (let i = 0; i < 90; i++) {
    g.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.1)';
    g.beginPath();
    g.ellipse(rnd() * S, rnd() * S, 6 + rnd() * 26, 6 + rnd() * 26, 0, 0, 6.2832);
    g.fill();
  }
  const t = tex(c, { srgb: false, wrap: true });
  return t;
}

/* ═══════════════════════════════════════════════════════════════════════════
   ФАСАДЫ ЗДАНИЙ (4 типа) + парная маска горящих окон, те же UV
   ═══════════════════════════════════════════════════════════════════════════ */
export function makeFacade(rnd, variant) {
  const W = 256, H = 256;
  const a = cv(W, H), b = cv(W, H);
  const base = ['#8d949c', '#7a838d', '#98a0a8', '#a08a7c'][variant];
  a.g.fillStyle = base; a.g.fillRect(0, 0, W, H);
  b.g.fillStyle = '#000'; b.g.fillRect(0, 0, W, H);

  /* вертикальные пилястры */
  a.g.globalAlpha = 0.16;
  for (let x = 0; x < W; x += 18) {
    a.g.fillStyle = rnd() < 0.5 ? '#ffffff' : '#20262e';
    a.g.fillRect(x, 0, 3, H);
  }
  a.g.globalAlpha = 1;

  /* Верхние 12% текстуры — кровельная полоса. На стенах она читается как
     парапет, а горизонтальные грани зданий переводятся ровно в неё
     (см. roofUV в world.js), иначе крыши оказываются оклеены окнами. */
  const ROOF = Math.round(H * 0.12);
  a.g.fillStyle = '#6f7580'; a.g.fillRect(0, 0, W, ROOF);
  for (let i = 0; i < 260; i++) {           // гравий и потёки
    a.g.fillStyle = pick(rnd, ['#7b818c', '#646a74', '#868d98', '#5b616a']);
    a.g.fillRect(rnd() * W, rnd() * ROOF, 2 + rnd() * 9, 2 + rnd() * 7);
  }
  /* Полоса повторяется и по вертикали стены, поэтому её содержимое должно
     читаться и как кровля сверху, и как технический этаж сбоку: жалюзи и
     решётки, а не разбросанные будки. */
  for (let x = 4; x < W - 6; x += 21) {
    const hh = 7 + (rnd() * 5 | 0);
    a.g.fillStyle = '#4d535c'; a.g.fillRect(x, 5, 15, hh);
    a.g.fillStyle = 'rgba(255,255,255,.14)'; a.g.fillRect(x, 5, 15, 1.5);
    a.g.fillStyle = 'rgba(25,30,38,.55)';
    for (let s = 0; s < hh - 2; s += 3) a.g.fillRect(x + 1, 7 + s, 13, 1.4);
  }
  a.g.strokeStyle = 'rgba(35,40,48,.45)'; a.g.lineWidth = 1.5;
  for (let x = 0; x < W; x += 32) { a.g.beginPath(); a.g.moveTo(x, 0); a.g.lineTo(x, ROOF); a.g.stroke(); }
  a.g.fillStyle = 'rgba(30,36,44,.5)'; a.g.fillRect(0, ROOF - 3, W, 3);   // парапет
  for (let i = 0; i < 3; i++) {             // проблесковые огни на кровле
    const x = 12 + rnd() * (W - 24), y = 4 + rnd() * (ROOF - 10);
    a.g.fillStyle = '#8a3a30'; a.g.fillRect(x, y, 3, 3);
    b.g.fillStyle = '#ff5a3c'; b.g.fillRect(x, y, 3, 3);
  }

  /* столбцов — под шаг проёма ~3.5 м, строк — по числу этажей типа */
  const cols = [8, 7, 9, 8][variant], rows = CONFIG.BLD[variant].rows;
  const mx = 10, my = ROOF + 8;
  const cw = (W - mx * 2) / cols, ch = (H - my - 14) / rows;
  const ww = cw * 0.66, wh = ch * 0.52;
  const glow = ['#ffd9a0', '#ffc477', '#ffeccb', '#f0dcbc', '#cfe0f2'];
  for (let r = 0; r < rows; r++) {
    /* межэтажный поясок — «полосатые» фасады Вавилона */
    if (r % 3 === 0) {
      a.g.fillStyle = 'rgba(30,40,54,.28)';
      a.g.fillRect(0, my + r * ch - 2, W, 3);
    }
    for (let c2 = 0; c2 < cols; c2++) {
      const x = mx + c2 * cw + (cw - ww) / 2, y = my + r * ch + (ch - wh) / 2;
      a.g.fillStyle = pick(rnd, ['#2b3644', '#354252', '#222b36', '#3d4c5e']);
      a.g.fillRect(x, y, ww, wh);
      a.g.fillStyle = 'rgba(255,255,255,.14)';
      a.g.fillRect(x, y, ww, 1.5);
      if (rnd() < 0.4) {
        b.g.fillStyle = pick(rnd, glow);
        b.g.fillRect(x, y, ww, wh);
      }
    }
  }
  a.g.fillStyle = 'rgba(20,26,34,.45)';
  a.g.fillRect(0, H - 11, W, 11);

  return { map: tex(a.c), emis: tex(b.c) };
}

/* ═══════════════════════════════════════════════════════════════════════════
   ТОРЕЦ: концентрические кольца, серые + пыльно-розовые сектора
   ═══════════════════════════════════════════════════════════════════════════ */
export function makeEndCapTexture(size, rnd) {
  const S = size, C = S / 2;
  const a = cv(S, S), b = cv(S, S);
  a.g.fillStyle = '#5c5f66'; a.g.beginPath(); a.g.arc(C, C, C, 0, 6.2832); a.g.fill();
  b.g.fillStyle = '#000'; b.g.fillRect(0, 0, S, S);

  const rings = 16;
  for (let i = rings; i >= 1; i--) {
    const r1 = C * (i / rings), r0 = C * ((i - 1) / rings);
    const sectors = 12 + i * 4;
    for (let s = 0; s < sectors; s++) {
      const a0 = (s / sectors) * 6.2832, a1 = ((s + 1) / sectors) * 6.2832;
      a.g.fillStyle = rnd() < 0.34
        ? pick(rnd, ['#a98d95', '#b79aa0', '#96787f', '#c0a5aa'])
        : pick(rnd, ['#6a6e75', '#7b8087', '#5a5e65', '#868b92']);
      a.g.beginPath(); a.g.arc(C, C, r1, a0, a1); a.g.arc(C, C, r0, a1, a0, true); a.g.closePath(); a.g.fill();
      if (rnd() < 0.32) {
        b.g.fillStyle = pick(rnd, ['#ffca7d', '#ffe0ac', '#7fb6ff']);
        b.g.beginPath(); b.g.arc(C, C, r1 * 0.97, a0 + 0.01, a1 - 0.01);
        b.g.arc(C, C, r0 * 1.05, a1 - 0.01, a0 + 0.01, true); b.g.closePath(); b.g.fill();
      }
    }
    a.g.strokeStyle = 'rgba(30,34,40,.55)'; a.g.lineWidth = 2;
    a.g.beginPath(); a.g.arc(C, C, r1, 0, 6.2832); a.g.stroke();
  }
  a.g.strokeStyle = 'rgba(28,32,38,.4)'; a.g.lineWidth = 2;
  for (let i = 0; i < 96; i++) {
    const ang = (i / 96) * 6.2832;
    a.g.beginPath();
    a.g.moveTo(C + Math.cos(ang) * C * 0.1, C + Math.sin(ang) * C * 0.1);
    a.g.lineTo(C + Math.cos(ang) * C, C + Math.sin(ang) * C);
    a.g.stroke();
  }
  a.g.fillStyle = '#43474e'; a.g.beginPath(); a.g.arc(C, C, C * 0.1, 0, 6.2832); a.g.fill();
  a.g.strokeStyle = '#8b9098'; a.g.lineWidth = 3;
  a.g.beginPath(); a.g.arc(C, C, C * 0.1, 0, 6.2832); a.g.stroke();

  return { map: tex(a.c), emis: tex(b.c) };
}

/* ═══════════════════════════════════════════════════════════════════════════
   ТЕХНИЧЕСКИЕ ПАНЕЛИ — для осевой трубы, ферм и башни
   ═══════════════════════════════════════════════════════════════════════════ */
export function makePanelTexture(rnd) {
  const S = 512, { c, g } = cv(S, S);
  g.fillStyle = '#9aa3ac'; g.fillRect(0, 0, S, S);
  /* плиты */
  for (let y = 0; y < S; y += 64) for (let x = 0; x < S; x += 128) {
    g.fillStyle = pick(rnd, ['#a4adb6', '#909aa3', '#b0b8c0', '#858e97']);
    g.fillRect(x + 1, y + 1, 126, 62);
  }
  /* швы */
  g.strokeStyle = 'rgba(40,46,54,.5)'; g.lineWidth = 2;
  for (let y = 0; y <= S; y += 64) { g.beginPath(); g.moveTo(0, y); g.lineTo(S, y); g.stroke(); }
  for (let x = 0; x <= S; x += 128) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, S); g.stroke(); }
  /* заклёпки и подписи */
  for (let i = 0; i < 900; i++) {
    g.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,.2)' : 'rgba(30,36,44,.3)';
    g.beginPath(); g.arc(rnd() * S, rnd() * S, 1.4, 0, 6.2832); g.fill();
  }
  for (let i = 0; i < 40; i++) {
    g.fillStyle = pick(rnd, ['rgba(230,180,60,.5)', 'rgba(200,60,50,.45)', 'rgba(70,120,190,.45)']);
    g.fillRect(rnd() * S, rnd() * S, 6 + rnd() * 40, 3 + rnd() * 5);
  }
  return tex(c, { wrap: true });
}

/* ═══════════════════════════════════════════════════════════════════════════
   СПРАЙТЫ: частицы, тени-пятна, градиент солнца
   ═══════════════════════════════════════════════════════════════════════════ */
export function makeSoftSprite(hardness = 0) {
  const S = 128, { c, g } = cv(S, S);
  const gr = g.createRadialGradient(S / 2, S / 2, S * 0.02, S / 2, S / 2, S / 2);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.25 + hardness * 0.4, 'rgba(255,255,255,.55)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
  return tex(c);
}

/** Пятно контактной тени. Свет — линия на оси, значит тень падает точно под объект. */
export function makeBlobTexture() {
  const S = 128, { c, g } = cv(S, S);
  const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  gr.addColorStop(0, 'rgba(0,0,0,.72)');
  gr.addColorStop(0.45, 'rgba(0,0,0,.42)');
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
  return tex(c);
}

export function makeGlowTexture() {
  const W = 64, H = 8, { c, g } = cv(W, H);
  const gr = g.createLinearGradient(0, 0, W, 0);
  gr.addColorStop(0, 'rgba(255,255,255,0)');
  gr.addColorStop(0.5, 'rgba(255,255,255,1)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, W, H);
  return tex(c);
}
