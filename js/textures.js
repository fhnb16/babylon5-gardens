import * as THREE from 'three';
import { CONFIG } from './config.js';
import { pick, D2R, cityBlock, cityCenter, cellInfo, cellUsable } from './util.js';

/** Мелкий разброс тона квартала: одинаковые прямоугольники читаются как
    штампованные лотки */
const tint = (hex, k) => {
  const n = parseInt(hex.slice(1), 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map(v => Math.max(0, Math.min(255, Math.round(v * k))));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
};

/** Плавная линия через точки: ведём кривую по серединам отрезков, опорные
    точки становятся касательными. Ломаная по случайному блужданию давала
    зигзаги, которые в парке читались как небрежная штриховка. */
const smoothLine = (ctx, pts, sx = 1, sy = 1) => {
  ctx.beginPath();
  ctx.moveTo(pts[0][0] * sx, pts[0][1] * sy);
  for (let k = 1; k < pts.length - 1; k++) {
    ctx.quadraticCurveTo(pts[k][0] * sx, pts[k][1] * sy,
      (pts[k][0] + pts[k + 1][0]) / 2 * sx, (pts[k][1] + pts[k + 1][1]) / 2 * sy);
  }
  const e = pts[pts.length - 1];
  ctx.lineTo(e[0] * sx, e[1] * sy);
  ctx.stroke();
};

const TAU_2D = Math.PI * 2;
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
   КАРТЫ НОРМАЛЕЙ ИЗ ГОТОВОГО АЛЬБЕДО

   Рельеф уже нарисован: оконные ниши, швы плит, бордюры, борозды полей. Брать
   его как карту высот и считать градиент — дешевле и точнее, чем рисовать
   рельеф отдельно: карта не может разъехаться с картинкой, потому что она из
   неё и сделана. Размер берётся меньше исходного — нормали не нуждаются в той
   же детализации, а Собель по 4 млн пикселей стоит заметных долей секунды.
   ═══════════════════════════════════════════════════════════════════════════ */
export function heightToNormal(srcCanvas, strength = 1, size = 0) {
  const w = size || srcCanvas.width, h = size || srcCanvas.height;
  const { c, g } = cv(w, h);
  g.drawImage(srcCanvas, 0, 0, w, h);
  const src = g.getImageData(0, 0, w, h).data;
  const out = g.createImageData(w, h);
  const d = out.data;

  /* высота = яркость; края замыкаются по кругу — текстура тайлится */
  const H = (x, y) => {
    const i = ((((y % h) + h) % h) * w + (((x % w) + w) % w)) * 4;
    return (src[i] * 0.299 + src[i + 1] * 0.587 + src[i + 2] * 0.114) / 255;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * strength;
      const dy = (H(x, y + 1) - H(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * w + x) * 4;
      d[i] = (-dx / len * 0.5 + 0.5) * 255;
      d[i + 1] = (-dy / len * 0.5 + 0.5) * 255;
      d[i + 2] = (1 / len * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  g.putImageData(out, 0, 0);
  return tex(c, { srgb: false, wrap: true });
}

/* ═══════════════════════════════════════════════════════════════════════════
   КОРПУС: альбедо + маска каналов (R=вода, G=растительность, B=покрытие)
   Оба холста рисуются из одних и тех же секторов CONFIG.
   ═══════════════════════════════════════════════════════════════════════════ */
export function makeHullMaps(size, maskSize, rnd, ponds = []) {
  const W = size, H = size, A = cv(W, H);
  const M = cv(maskSize, maskSize);
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
    /* Дорожка — плавный меандр из двух гармоник, а не случайное блуждание:
       ломаная давала зигзаги под прямыми углами. */
    a.globalAlpha = 0.4; a.strokeStyle = '#c4b894'; a.lineWidth = 3;
    m.strokeStyle = '#000040'; m.lineWidth = 2;   // слабый B: зерно есть, фонарей нет
    for (let i = 0; i < 14; i++) {
      const base = x0 + rnd() * (x1 - x0);
      const ph0 = rnd() * 6.2832, ph1 = rnd() * 6.2832;
      const am0 = 16 + rnd() * 30, am1 = 5 + rnd() * 11;
      const fr0 = 0.005 + rnd() * 0.004, fr1 = 0.017 + rnd() * 0.011;
      const drift = (rnd() - 0.5) * 0.25;
      const pts = [];
      for (let py = -20; py <= H + 20; py += 16) {
        pts.push([base + py * drift
          + Math.sin(py * fr0 + ph0) * am0
          + Math.sin(py * fr1 + ph1) * am1, py]);
      }
      smoothLine(a, pts);
      smoothLine(m, pts, M.c.width / W, mh / H);
    }
    a.globalAlpha = 1; a.restore();
  }

  /* ── ГОРОДА ──
     План рисуется по ТОЙ ЖЕ сетке кварталов, по которой расставляются дома,
     и содержимое квартала обе стороны берут из cellInfo. Домов в текстуре
     нет: они только объёмные. Асфальт кладётся по столбцам сетки, а не по
     всему сектору, — тогда город обрывается ровно по последнему кварталу. */
  {
    const B = cityBlock(), C = CONFIG.CITY;
    const circ = 2 * Math.PI * CONFIG.R;
    const pxT = W / circ, pxZ = H / CONFIG.L;         // юниты мира → пиксели
    const hw = B.wT * pxT / 2, hh = B.wZ * pxZ / 2;
    const kx = M.c.width / W, ky = mh / H;
    const colW = B.stepT * pxT, rowH = B.stepZ * pxZ;
    const streets = [];                               // осевые линии улиц для маски

    for (let i = 0; i < C.cols; i++) {
      const rows = [];
      for (let j = 0; j < C.rows; j++) if (cellUsable(i, j)) rows.push(j);
      if (!rows.length) continue;

      const cx = (cityCenter(i, 0).t / (2 * Math.PI)) * W;
      const y0 = (cityCenter(i, rows[0]).z + CONFIG.L / 2) * pxZ - rowH / 2;
      const y1 = (cityCenter(i, rows[rows.length - 1]).z + CONFIG.L / 2) * pxZ + rowH / 2;

      /* асфальт полосой этого столбца */
      a.fillStyle = '#4e5359';
      a.fillRect(cx - colW / 2, y0, colW, y1 - y0);
      m.fillStyle = '#000040';
      m.fillRect((cx - colW / 2) * kx, y0 * ky, colW * kx, (y1 - y0) * ky);

      /* продольная улица слева от столбца и поперечные между рядами */
      streets.push(['v', cx - colW / 2, y0, y1, i % 3 === 0]);
      if (i === C.cols - 1 || !cellUsable(i + 1, rows[0])) {
        streets.push(['v', cx + colW / 2, y0, y1, false]);
      }
      for (const j of rows) {
        const cy = (cityCenter(i, j).z + CONFIG.L / 2) * pxZ;
        streets.push(['h', cy - rowH / 2, cx - colW / 2, cx + colW / 2, j % 3 === 0]);

        const info = cellInfo(i, j);
        const x = cx - hw, y = cy - hh, bw = hw * 2, bh = hh * 2;
        const shade = 0.92 + info.tint * 0.16;         // мелкий разброс тона

        if (info.kind === 'park') {
          a.fillStyle = pick(rnd, ['#4f7038', '#5b7d3f', '#456630']);
          a.fillRect(x, y, bw, bh);
          a.globalAlpha = 0.3; a.fillStyle = '#6f9048';
          for (let k = 0; k < 12; k++) {
            a.beginPath();
            a.ellipse(x + rnd() * bw, y + rnd() * bh, 2 + rnd() * 6, 2 + rnd() * 5, 0, 0, 6.2832);
            a.fill();
          }
          a.globalAlpha = 0.25; a.strokeStyle = '#c4b894'; a.lineWidth = 2;
          a.beginPath(); a.moveTo(x, y + bh * (0.3 + info.w * 0.4));
          a.lineTo(x + bw, y + bh * (0.3 + info.d * 0.4)); a.stroke();
          a.globalAlpha = 1;
          m.fillStyle = '#00ff00'; m.fillRect(x * kx, y * ky, bw * kx, bh * ky);
          continue;
        }

        /* мощение и неяркий тротуар по периметру */
        a.fillStyle = tint('#6f757b', shade); a.fillRect(x, y, bw, bh);
        a.fillStyle = tint('#7e848a', shade);
        a.fillRect(x, y, bw, 2); a.fillRect(x, y + bh - 2, bw, 2);
        a.fillRect(x, y, 2, bh); a.fillRect(x + bw - 2, y, 2, bh);

        if (info.kind === 'plaza') {
          a.globalAlpha = 0.55; a.fillStyle = '#8b9197';
          a.beginPath(); a.arc(x + bw / 2, y + bh / 2, Math.min(bw, bh) * 0.38, 0, 6.2832); a.fill();
          a.globalAlpha = 0.22; a.strokeStyle = '#565c62'; a.lineWidth = 1.4;
          for (let k = 1; k <= 3; k++) {
            a.beginPath();
            a.arc(x + bw / 2, y + bh / 2, Math.min(bw, bh) * 0.38 * k / 3.4, 0, 6.2832);
            a.stroke();
          }
          a.globalAlpha = 0.4; a.fillStyle = '#54763a';
          for (let k = 0; k < 4; k++) {
            const ang = (k / 4) * 6.2832 + info.w * 3;
            a.beginPath();
            a.arc(x + bw / 2 + Math.cos(ang) * bw * 0.34,
                  y + bh / 2 + Math.sin(ang) * bh * 0.34, bw * 0.07, 0, 6.2832);
            a.fill();
          }
          a.globalAlpha = 1;
        } else if (info.kind === 'lot') {
          a.fillStyle = tint('#5a6066', shade);
          a.fillRect(x + 3, y + 3, bw - 6, bh - 6);
          a.globalAlpha = 0.3; a.strokeStyle = '#cfd5da'; a.lineWidth = 1.1;
          a.beginPath();
          const vert = info.spin % 2 === 0;
          for (let k = 8; k < (vert ? bw : bh) - 6; k += 5) {
            if (vert) {
              a.moveTo(x + k, y + 7); a.lineTo(x + k, y + bh * 0.44);
              a.moveTo(x + k, y + bh * 0.56); a.lineTo(x + k, y + bh - 7);
            } else {
              a.moveTo(x + 7, y + k); a.lineTo(x + bw * 0.44, y + k);
              a.moveTo(x + bw * 0.56, y + k); a.lineTo(x + bw - 7, y + k);
            }
          }
          a.stroke(); a.globalAlpha = 1;
        } else {
          /* застроенный квартал: газон по краям, мощёная площадка под дом */
          const g = Math.min(bw, bh) * (0.11 + info.w * 0.06);
          a.fillStyle = tint('#547239', shade);
          a.fillRect(x + g, y + g, bw - g * 2, bh - g * 2);
          const px = bw * (0.2 + info.d * 0.06), py = bh * (0.2 + info.w * 0.06);
          a.fillStyle = tint('#767c82', shade);
          a.fillRect(x + px, y + py, bw - px * 2, bh - py * 2);
          a.globalAlpha = 0.35; a.strokeStyle = '#bfb694'; a.lineWidth = 2;
          a.beginPath();
          if (info.spin % 2) { a.moveTo(x + bw / 2, y + g); a.lineTo(x + bw / 2, y + bh - g); }
          else { a.moveTo(x + g, y + bh / 2); a.lineTo(x + bw - g, y + bh / 2); }
          a.stroke(); a.globalAlpha = 1;
        }
      }
    }

    /* Улицы поверх кварталов. В маске каждая улица — мягкий гребень из трёх
       проходов: резкая линия давала ночью квадратные светящиеся полосы. */
    for (const [dir, p, q0, q1, main] of streets) {
      const wide = main ? C.street * pxT * 1.15 : C.street * pxT * 0.9;
      a.strokeStyle = main ? '#3a3f44' : '#44494f';
      a.lineWidth = wide;
      a.beginPath();
      if (dir === 'v') { a.moveTo(p, q0); a.lineTo(p, q1); }
      else { a.moveTo(q0, p); a.lineTo(q1, p); }
      a.stroke();
      if (main) {
        a.globalAlpha = 0.5; a.strokeStyle = '#e8d98a'; a.lineWidth = 1.3;
        a.setLineDash([9, 7]);
        a.beginPath();
        if (dir === 'v') { a.moveTo(p, q0); a.lineTo(p, q1); }
        else { a.moveTo(q0, p); a.lineTo(q1, p); }
        a.stroke();
        a.setLineDash([]); a.globalAlpha = 1;
      }
      /* мягкий след фонарей в канал B */
      m.strokeStyle = '#0000ff';
      for (const [mul, alpha] of [[2.1, 0.22], [1.4, 0.45], [0.75, 1]]) {
        m.globalAlpha = alpha * (main ? 1 : 0.75);
        m.lineWidth = Math.max(1.5, wide * kx * mul);
        m.beginPath();
        if (dir === 'v') { m.moveTo(p * kx, q0 * ky); m.lineTo(p * kx, q1 * ky); }
        else { m.moveTo(q0 * kx, p * ky); m.lineTo(q1 * kx, p * ky); }
        m.stroke();
      }
      m.globalAlpha = 1;
    }
  }

  /* ── РЕКИ: альбедо + канал воды в маске ── */
  for (const [s0, s1] of CONFIG.SECT.rivers) {
    const cx = X((s0 + s1) / 2), half = (X(s1) - X(s0)) / 2;
    const pts = [];
    for (let y = -20; y <= H + 20; y += 24) pts.push([cx + Math.sin(y * 0.011 + s0) * half * 0.55 + (rnd() - .5) * 6, y]);
    const stroke = (ctx, w, col, sx, sy) => {
      ctx.strokeStyle = col; ctx.lineWidth = w; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      smoothLine(ctx, pts, sx, sy);
    };
    stroke(a, half * 2 + 22, '#a8a173', 1, 1);
    stroke(a, half * 2 + 11, '#7f9a55', 1, 1);
    stroke(a, half * 2 - 2, '#3a5c47', 1, 1);      // дно у берега
    stroke(a, half * 1.5, '#2c4c5e', 1, 1);        // дно поглубже
    a.globalAlpha = 0.35; stroke(a, half * 0.7, '#20384a', 1, 1); a.globalAlpha = 1;
    /* Маска воды тремя проходами: канал R становится не признаком «вода да
       или нет», а глубиной — 0 у берега, 1 на стрежне. Шейдер по ней и
       затемняет цвет, и гасит рябь на отмели. */
    const kw = M.c.width / W, kh = mh / H;
    stroke(m, (half * 2 - 4) * kw, '#330000', kw, kh);
    stroke(m, (half * 1.45) * kw, '#990000', kw, kh);
    stroke(m, (half * 0.75) * kw, '#ff0000', kw, kh);
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
  /* ─── ПРУДЫ ───
     Низины корпуса заливаются водой. Канал тот же, что у рек, поэтому им
     достаётся весь водный шейдер даром: глубина, кайма, отражение. Течения
     нет — оно привязано к руслам.

     Рисуем ровно как реки: обычной заливкой, а не сложением. Сложение
     оставляло зелёный канал на месте, и трава ложилась поверх воды — озера
     не было видно вовсе. */
  for (const p of ponds) {
    const u = ((p.t / TAU_2D) % 1 + 1) % 1;
    const v = p.z / CONFIG.L + 0.5;
    /* радиус в пикселях считается отдельно по осям: по дуге и по длине
       масштабы разные */
    const ellipse = (ctx, size, rr, fill) => {
      const rxp = p.r * rr / (TAU_2D * CONFIG.R) * size;
      const ryp = p.r * rr / CONFIG.L * size;
      ctx.save();
      ctx.translate(u * size, v * size);
      ctx.scale(rxp / Math.max(rxp, ryp), ryp / Math.max(rxp, ryp));
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.arc(0, 0, Math.max(rxp, ryp), 0, TAU_2D);
      ctx.fill();
      ctx.restore();
    };

    /* альбедо: берег, отмель, глубина — теми же цветами, что у рек */
    ellipse(a, W, 1.18, '#a8a173');
    ellipse(a, W, 1.06, '#7f9a55');
    ellipse(a, W, 1.0, '#3a5c47');
    ellipse(a, W, 0.82, '#2c4c5e');
    ellipse(a, W, 0.55, '#20384a');

    /* маска: R растёт к середине — та же глубина, что у русла */
    ellipse(m, M.c.width, 1.0, '#330000');
    ellipse(m, M.c.width, 0.78, '#990000');
    ellipse(m, M.c.width, 0.5, '#ff0000');
  }

  return { albedo, mask, canvas: A.c };


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
  /* Контакт со землёй читается только если темнеет и САМ объект, а не одна
     лишь земля под ним: плоская декаль на грунте без этого выглядит
     наклейкой. Мягкий градиент по нижней восьмой части стены. */
  const foot = Math.round(H * 0.13);
  for (let y = 0; y < foot; y++) {
    const k = y / foot;                       // 0 у пола, 1 вверх
    a.g.fillStyle = `rgba(14,19,26,${(0.62 * Math.pow(1 - k, 1.7)).toFixed(3)})`;
    a.g.fillRect(0, H - foot + y, W, 1);
  }
  a.g.fillStyle = 'rgba(20,26,34,.5)';
  a.g.fillRect(0, H - 3, W, 3);               // тень примыкания

  return { map: tex(a.c), emis: tex(b.c), canvas: a.c };
}

/* ═══════════════════════════════════════════════════════════════════════════
   ТОРЕЦ: концентрические кольца, серые + пыльно-розовые сектора
   ═══════════════════════════════════════════════════════════════════════════ */
export function makeEndCapTexture(size, rnd) {
  const S = size, C = S / 2;
  const a = cv(S, S), b = cv(S, S);
  a.g.fillStyle = '#7e848c';
  a.g.beginPath(); a.g.arc(C, C, C, 0, TAU_2D); a.g.fill();
  b.g.fillStyle = '#000'; b.g.fillRect(0, 0, S, S);

  /* Торец собран как настоящая торцевая переборка: концентрические пояса,
     каждый поделён на секции по дуге, и в секциях — мелкие блоки. Ровные
     кольца одного тона читались диском, а не конструкцией: масштаб не
     считывался, потому что не за что зацепиться. */
  const rings = 22;
  for (let i = rings; i >= 1; i--) {
    const r1 = C * (i / rings), r0 = C * ((i - 1) / rings);
    /* число секций растёт к краю: длина дуги должна оставаться соизмеримой */
    const seg = Math.max(6, Math.round(i * 2.6));
    for (let k = 0; k < seg; k++) {
      const a0 = (k / seg) * TAU_2D + rnd() * 0.01;
      const a1 = ((k + 1) / seg) * TAU_2D;
      const tone = 0.72 + rnd() * 0.5;
      const v = Math.round(132 * tone);
      a.g.fillStyle = `rgb(${v},${v + 4},${v + 9})`;
      a.g.beginPath();
      a.g.arc(C, C, r1, a0, a1);
      a.g.arc(C, C, r0, a1, a0, true);
      a.g.closePath();
      a.g.fill();

      /* мелкие блоки внутри секции — по ним и читается размер */
      const blocks = 1 + Math.floor(rnd() * 3);
      for (let m = 0; m < blocks; m++) {
        const rr = r0 + (r1 - r0) * (0.2 + rnd() * 0.6);
        const aa = a0 + (a1 - a0) * (0.15 + rnd() * 0.7);
        const bw = (r1 - r0) * (0.12 + rnd() * 0.3);
        /* ширина блока тоже от радиуса, иначе у края они растягиваются */
        const ba = Math.min((a1 - a0) * 0.7, bw * (0.7 + rnd() * 1.4) / Math.max(1, rr));
        a.g.fillStyle = rnd() < 0.5 ? 'rgba(48,54,62,.5)' : 'rgba(206,214,224,.34)';
        a.g.beginPath();
        a.g.arc(C, C, rr + bw, aa, aa + ba);
        a.g.arc(C, C, rr, aa + ba, aa, true);
        a.g.closePath();
        a.g.fill();
      }

      /* Светящиеся иллюминаторы. Угловой размер обязан считаться ОТ радиуса:
         постоянный угол даёт дугу, растущую вместе с радиусом, и у края окна
         вытягивались впятеро против тех, что у ступицы. */
      if (rnd() < 0.1) {
        const rr = r0 + (r1 - r0) * 0.5;
        const side = (r1 - r0) * 0.34;            // сторона окна в пикселях
        const ba = Math.min((a1 - a0) * 0.8, side / Math.max(1, rr));
        const aa = a0 + (a1 - a0) * 0.5 - ba / 2;
        b.g.fillStyle = pick(rnd, ['#ffe6b4', '#cfe0f2', '#ffd08a']);
        b.g.beginPath();
        b.g.arc(C, C, rr + side, aa, aa + ba);
        b.g.arc(C, C, rr, aa + ba, aa, true);
        b.g.closePath();
        b.g.fill();
      }
    }
    /* радиальный шов пояса */
    a.g.strokeStyle = 'rgba(38,44,52,.42)';
    a.g.lineWidth = 1.4;
    a.g.beginPath(); a.g.arc(C, C, r0, 0, TAU_2D); a.g.stroke();
  }

  /* шесть силовых спиц поверх поясов */
  for (let k = 0; k < 6; k++) {
    const ang = (k / 6) * TAU_2D + 0.26;
    a.g.save();
    a.g.translate(C, C);
    a.g.rotate(ang);
    a.g.fillStyle = 'rgba(150,158,168,.85)';
    a.g.fillRect(-C * 0.018, -C * 0.96, C * 0.036, C * 0.9);
    a.g.fillStyle = 'rgba(44,50,58,.5)';
    a.g.fillRect(-C * 0.02, -C * 0.96, C * 0.006, C * 0.9);
    a.g.restore();
  }

  /* ступица */
  a.g.fillStyle = '#6c727a';
  a.g.beginPath(); a.g.arc(C, C, C * 0.085, 0, TAU_2D); a.g.fill();
  a.g.strokeStyle = 'rgba(36,42,50,.6)'; a.g.lineWidth = 2;
  a.g.beginPath(); a.g.arc(C, C, C * 0.085, 0, TAU_2D); a.g.stroke();

  return { map: tex(a.c), emis: tex(b.c), canvas: a.c };
}

/* ═══════════════════════════════════════════════════════════════════════════
   ТЕХНИЧЕСКИЕ ПАНЕЛИ — для осевой трубы, ферм и башни
   ═══════════════════════════════════════════════════════════════════════════ */
export function makePanelTexture(rnd) {
  const S = 512, { c, g } = cv(S, S);
  g.fillStyle = '#8e959d'; g.fillRect(0, 0, S, S);

  /* Плиты РАЗНОГО размера, а не ровная сетка. Одинаковые прямоугольники
     читаются как заглушка: глазу не за что зацепиться, масштаб не считывается.
     Панель набирается рядами разной высоты, ряд делится на плиты разной
     ширины — так выглядит настоящая обшивка. */
  let y = 0;
  while (y < S) {
    const h = 26 + Math.floor(rnd() * 46);
    let x = -Math.floor(rnd() * 60);
    while (x < S) {
      const w = 34 + Math.floor(rnd() * 92);
      const tone = 0.78 + rnd() * 0.42;
      const base = Math.round(150 * tone);
      g.fillStyle = `rgb(${base},${base + 5},${base + 11})`;
      g.fillRect(x, y, w - 1, h - 1);

      /* фаска: светлая сверху-слева, тёмная снизу-справа — плита читается
         объёмной даже без карты нормалей */
      g.fillStyle = 'rgba(255,255,255,.10)';
      g.fillRect(x, y, w - 1, 1);
      g.fillRect(x, y, 1, h - 1);
      g.fillStyle = 'rgba(24,30,38,.30)';
      g.fillRect(x, y + h - 2, w - 1, 1);
      g.fillRect(x + w - 2, y, 1, h - 1);
      x += w;
    }
    y += h;
  }

  /* Потёки вниз от стыков: главная примета обшивки, работавшей годами.
     Без них металл выглядит только что отлитым. */
  for (let i = 0; i < 220; i++) {
    const sx = rnd() * S, sy = rnd() * S;
    const len = 12 + rnd() * 90, wdt = 1 + rnd() * 5;
    const gr = g.createLinearGradient(sx, sy, sx, sy + len);
    const dark = rnd() < 0.62;
    gr.addColorStop(0, dark ? 'rgba(38,44,52,.34)' : 'rgba(226,232,240,.20)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect(sx, sy, wdt, len);
  }

  /* Мелкие люки и вставки — по ним считывается масштаб конструкции */
  for (let i = 0; i < 130; i++) {
    const x2 = rnd() * S, y2 = rnd() * S;
    const w2 = 5 + rnd() * 22, h2 = 4 + rnd() * 12;
    g.fillStyle = rnd() < 0.5 ? 'rgba(56,64,74,.42)' : 'rgba(196,204,214,.28)';
    g.fillRect(x2, y2, w2, h2);
    g.strokeStyle = 'rgba(30,36,44,.35)'; g.lineWidth = 1;
    g.strokeRect(x2 + 0.5, y2 + 0.5, w2, h2);
  }

  /* заклёпки */
  for (let i = 0; i < 700; i++) {
    g.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,.16)' : 'rgba(28,34,42,.26)';
    g.beginPath(); g.arc(rnd() * S, rnd() * S, 1.2, 0, TAU_2D); g.fill();
  }

  /* Маркировка. Прежняя была цветной и яркой: красные, жёлтые и синие
     полосы бросались в глаза сильнее самой обшивки. Оставляем разницу в
     тоне, а не в цвете — так метка читается вблизи и не пестрит издали. */
  for (let i = 0; i < 18; i++) {
    g.fillStyle = pick(rnd, ['rgba(228,232,238,.30)', 'rgba(40,46,54,.34)',
      'rgba(196,186,150,.22)']);
    g.fillRect(rnd() * S, rnd() * S, 8 + rnd() * 26, 2 + rnd() * 3);
  }
  return { map: tex(c, { wrap: true }), canvas: c };
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
  gr.addColorStop(0, 'rgba(0,0,0,.78)');
  gr.addColorStop(0.42, 'rgba(0,0,0,.44)');
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
  return tex(c);
}

/** След дома на земле. Свет — труба на оси: поперёк станции она видна под
    5°, вдоль оси под 142°. Поэтому тень резкая поперёк улицы и растянутая
    на десятки метров вдоль оси. Плюс тёмная кайма у самого контакта —
    смыкание объекта с землёй, из-за которого появляется ощущение объёма. */
export function makeFootprintTexture() {
  const S = 256, { c, g } = cv(S, S);
  const px = S / 2, py = S / 2;
  const halfX = S * 0.42, halfY = S * 0.21;      // след внутри декали
  g.clearRect(0, 0, S, S);
  for (let y = 0; y < S; y++) {
    const dy = Math.abs(y - py) / halfY;
    /* вдоль оси — длинный мягкий спад */
    const fy = dy <= 1 ? 1 : Math.max(0, 1 - (dy - 1) / 1.35);
    if (fy <= 0) continue;
    for (let x = 0; x < S; x++) {
      const dx = Math.abs(x - px) / halfX;
      /* поперёк улицы — почти резкий край */
      const fx = dx <= 1 ? 1 : Math.max(0, 1 - (dx - 1) / 0.16);
      if (fx <= 0) continue;
      let a2 = fx * fy * fy;
      /* контактная кайма: у самой кромки следа темнее */
      const edge = Math.max(dx, dy);
      if (edge > 0.62 && edge <= 1.04) a2 = Math.min(1, a2 * 1.25);
      g.fillStyle = `rgba(0,0,0,${(a2 * 0.82).toFixed(3)})`;
      g.fillRect(x, y, 1, 1);
    }
  }
  const tex2 = new THREE.CanvasTexture(c);
  tex2.colorSpace = THREE.SRGBColorSpace;
  return tex2;
}

/** Полоса окон на кузове машины. UV коробки идут 0…1 на каждую грань,
    поэтому одна горизонтальная полоса даёт остекление по всем бортам. */
/** Карта шероховатости корпуса из канала глубины воды.

    Трассировщик пути читает только стандартные свойства материала: наши
    волны и зеркало живут в патче шейдера, и он их не видит. У корпуса
    шероховатость 0.95 на всё, включая реку, — вода выходила матовым пятном.
    Здесь тот же канал маски превращается в карту: где вода, там гладко. */
export function makeWaterRoughness(mask, size) {
  const { c, g } = cv(size, size);
  g.drawImage(mask.image || mask, 0, 0, size, size);
  const d = g.getImageData(0, 0, size, size);
  const px = d.data;
  for (let i = 0; i < px.length; i += 4) {
    const water = px[i] / 255;                    // R — глубина воды
    /* шероховатость в зелёном канале: three читает её оттуда */
    const rough = 0.95 - water * 0.9;
    px[i] = 0;
    px[i + 1] = Math.round(rough * 255);
    px[i + 2] = 0;
    px[i + 3] = 255;
  }
  g.putImageData(d, 0, 0);
  return tex(c, { srgb: false, wrap: true });
}

/** Карта нормалей воды: волны там, где маска показывает реку.

    Рябь у нас считается в патче шейдера, а трассировщик патчей не видит —
    вода выходила зеркально-гладкой, без единой волны. Здесь тот же рисунок
    волн выкладывается в карту высот и переводится в нормали. */
export function makeWaterNormal(mask, size, strength) {
  const { c, g } = cv(size, size);
  g.drawImage(mask.image || mask, 0, 0, size, size);
  const src = g.getImageData(0, 0, size, size).data;
  const out = g.createImageData(size, size);
  const d = out.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const water = src[i] / 255;                 // R — глубина воды
      /* пять волн разной длины и направления: одна синусоида читается
         как гофра, несколько дают рябь */
      const u = x / size * Math.PI * 2, v = y / size * Math.PI * 2;
      let h = 0;
      h += Math.sin(u * 120 + v * 14) * 0.5;
      h += Math.sin(u * 74 - v * 31) * 0.36;
      h += Math.sin(u * 191 + v * 7) * 0.24;
      h += Math.sin(v * 143 + u * 5) * 0.3;
      h += Math.sin(u * 47 + v * 61) * 0.2;
      const val = 128 + h * 60 * water;
      d[i] = d[i + 1] = d[i + 2] = Math.max(0, Math.min(255, val));
      d[i + 3] = 255;
    }
  }
  g.putImageData(out, 0, 0);
  return heightToNormal(c, strength, size);
}

/** Кровля: рубероид, вентиляция, парапет, разводы от воды.

    Раньше на крышу шла та же текстура, что на стены, — окна ложились на
    горизонтальную плоскость, и дом выглядел вывернутым. Кровля устроена
    иначе: сплошное покрытие, техника блоками, парапет по краю. */
export function makeRoofTexture(rnd) {
  const S = 256, { c, g } = cv(S, S);
  const base = 52 + Math.floor(rnd() * 16);
  g.fillStyle = `rgb(${base},${base + 3},${base + 6})`;
  g.fillRect(0, 0, S, S);

  /* полосы рубероида внахлёст */
  for (let y = 0; y < S; y += 26) {
    const v = base + 6 + Math.floor(rnd() * 12);
    g.fillStyle = `rgb(${v},${v + 3},${v + 6})`;
    g.fillRect(0, y, S, 24);
    g.fillStyle = 'rgba(20,24,30,.35)';
    g.fillRect(0, y + 24, S, 2);
  }

  /* разводы от стоячей воды — по ним крыша и читается крышей */
  for (let i = 0; i < 26; i++) {
    const x = rnd() * S, y = rnd() * S, r = 8 + rnd() * 34;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, 'rgba(28,34,42,.30)');
    gr.addColorStop(1, 'rgba(28,34,42,0)');
    g.fillStyle = gr;
    g.beginPath(); g.arc(x, y, r, 0, TAU_2D); g.fill();
  }

  /* вентиляция, короба, люки */
  for (let i = 0; i < 22; i++) {
    const w = 8 + rnd() * 26, h = 8 + rnd() * 22;
    const x = rnd() * (S - w), y = rnd() * (S - h);
    const v = 96 + Math.floor(rnd() * 46);
    g.fillStyle = `rgb(${v},${v + 4},${v + 10})`;
    g.fillRect(x, y, w, h);
    g.fillStyle = 'rgba(255,255,255,.14)';
    g.fillRect(x, y, w, 1.5);
    g.fillStyle = 'rgba(16,20,26,.45)';
    g.fillRect(x, y + h - 2, w, 2);
    /* решётка на крупных коробах */
    if (w > 18) {
      g.fillStyle = 'rgba(18,22,28,.45)';
      for (let k = 3; k < w - 2; k += 4) g.fillRect(x + k, y + 3, 1.5, h - 7);
    }
  }

  /* трубы и кабельные лотки */
  g.strokeStyle = 'rgba(120,128,138,.55)';
  g.lineWidth = 2.5;
  for (let i = 0; i < 7; i++) {
    g.beginPath();
    const y = rnd() * S;
    g.moveTo(0, y);
    g.lineTo(S, y + (rnd() - 0.5) * 26);
    g.stroke();
  }

  /* парапет по краю плитки: крыша не сливается со стеной на стыке */
  g.strokeStyle = 'rgba(150,158,168,.6)';
  g.lineWidth = 5;
  g.strokeRect(2.5, 2.5, S - 5, S - 5);
  return tex(c, { wrap: true });
}

/** Листва: силуэт кроны с прозрачным фоном для дальнего уровня и карта
    фактуры для ближних. Одна и та же — рисунок листьев не зависит от того,
    натянут он на плоскость или на многогранник. */
export function makeLeafTexture(rnd) {
  const S = 256, { c, g } = cv(S, S);
  g.clearRect(0, 0, S, S);

  /* силуэт: несколько перекрывающихся куп, чтобы край не читался кругом */
  const blobs = [];
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * TAU_2D + rnd() * 0.5;
    const rr = S * (0.16 + rnd() * 0.14);
    blobs.push([S / 2 + Math.cos(a) * S * 0.2 * rnd(),
      S * 0.42 + Math.sin(a) * S * 0.18 * rnd(), rr]);
  }
  g.fillStyle = '#5c8a3a';
  for (const [x, y, rr] of blobs) {
    g.beginPath(); g.arc(x, y, rr, 0, TAU_2D); g.fill();
  }

  /* отдельные листья: мазки поперёк, они и дают фактуру вблизи */
  for (let i = 0; i < 900; i++) {
    const b = blobs[(rnd() * blobs.length) | 0];
    const a = rnd() * TAU_2D, d = rnd() * b[2];
    const x = b[0] + Math.cos(a) * d, y = b[1] + Math.sin(a) * d;
    const v = 60 + rnd() * 90;
    g.fillStyle = `rgba(${(v * 0.55) | 0},${v},${(v * 0.42) | 0},.75)`;
    g.save();
    g.translate(x, y);
    g.rotate(rnd() * TAU_2D);
    g.beginPath();
    g.ellipse(0, 0, 2 + rnd() * 5, 1 + rnd() * 2.4, 0, 0, TAU_2D);
    g.fill();
    g.restore();
  }

  /* ствол под кроной: без него крест висит в воздухе */
  g.fillStyle = '#6b5236';
  g.fillRect(S / 2 - S * 0.022, S * 0.55, S * 0.044, S * 0.42);

  return tex(c, { wrap: false });
}

export function makeCarWindows() {
  const S = 32, { c, g } = cv(S, S);
  g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
  g.fillStyle = '#cfe0f2';
  g.fillRect(0, S * 0.30, S, S * 0.26);
  g.fillStyle = '#000';
  for (let x = 2; x < S; x += 9) g.fillRect(x, S * 0.30, 2, S * 0.26);   // стойки
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
