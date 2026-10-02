(() => {
'use strict';

/* ---------- constants & state ---------- */
const OUT_W = 300, OUT_H = 378;          // 1 in x 1.26 in at 300 DPI
const RATIO = OUT_H / OUT_W;             // 1.26
const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/model/';
const TOP_MARGIN = 0.07;                 // space above the hair, as a share of frame height

const state = { items: [], headRatio: 0.66, modelsReady: null, editing: null, nextId: 1 };
const $ = (s, r = document) => r.querySelector(s);
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

/* ---------- face detection ---------- */
function setStatus(text, cls) {
  const el = $('#detectorStatus');
  el.textContent = text;
  el.className = 'status ' + (cls || '');
}

function loadModels() {
  if (!state.modelsReady) {
    setStatus('Face detector: loading…');
    state.modelsReady = (async () => {
      if (!window.faceapi) throw new Error('face-api.js did not load');
      await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
      await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
      setStatus('Face detector: ready.', 'ok');
    })().catch(err => {
      state.modelsReady = null;
      setStatus('Face detector unavailable (needs an internet connection). Photos get a default crop; use Edit to adjust.', 'bad');
      throw err;
    });
  }
  return state.modelsReady;
}

async function detectFace(bmp) {
  try { await loadModels(); } catch { return null; }
  const s = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const found = await faceapi
    .detectAllFaces(c, new faceapi.TinyFaceDetectorOptions({ inputSize: 512, scoreThreshold: 0.35 }))
    .withFaceLandmarks();
  if (!found.length) return null;
  found.sort((a, b) => b.detection.box.area - a.detection.box.area);   // primary person = largest face
  const P = found[0].landmarks.positions.map(p => ({ x: p.x / s, y: p.y / s }));
  const chin = P[8].y;
  const brow = Math.min(...P.slice(17, 27).map(p => p.y));
  const headH = (chin - brow) * 1.65;      // brow-to-chin is ~60% of chin-to-crown incl. hair
  return { cx: (P[0].x + P[16].x) / 2, chin, headTop: chin - headH, headH, faceW: P[16].x - P[0].x };
}

/* ---------- composition ---------- */
function autoCrop(w, h, face) {
  if (!face) {                              // fallback: centred, biased toward the top of the photo
    const fw = Math.min(w, h / RATIO), fh = fw * RATIO;
    return { x: (w - fw) / 2, y: (h - fh) * 0.2, w: fw };
  }
  let fh = face.headH / state.headRatio, fw = fh / RATIO;
  const k = Math.min(1, w / fw, h / fh);    // never exceed the photo; never stretch
  fw *= k; fh *= k;
  return {
    x: clamp(face.cx - fw / 2, 0, w - fw),
    y: clamp(face.headTop - TOP_MARGIN * fh, 0, h - fh),
    w: fw
  };
}

function evalChecks(item) {
  const { x, y, w } = item.crop, h = w * RATIO, f = item.face;
  const base = [
    ['300 × 378 pixels', true], ['1 : 1.26 aspect ratio', true],
    ['No distortion (uniform scale)', true], ['Original filename preserved', true]
  ];
  if (!f) return [['No face detected. Check the framing by hand.', false], ...base];
  const topGap = (f.headTop - y) / h, below = (y + h - f.chin) / h, headRatio = f.headH / h;
  const sideOk = f.cx - f.faceW * 0.65 >= x && f.cx + f.faceW * 0.65 <= x + w;
  return [
    ['Face horizontally centred', Math.abs(f.cx - (x + w / 2)) <= w * 0.04],
    ['Head and hair not cut', topGap >= 0.02 && sideOk],
    ['Chin not cut', below >= 0.06],
    ['Shoulders visible', below >= 0.13],
    ['Appropriate head size', headRatio >= 0.5 && headRatio <= 0.8],
    ['Professional vertical position', topGap >= 0.02 && topGap <= 0.14],
    ...base
  ];
}

/* ---------- drawing ---------- */
function drawCrop(ctx, bmp, crop, dw, dh) {
  // Halve in steps first so big photos stay sharp when reduced to 300 px.
  let src = bmp, sx = crop.x, sy = crop.y, sw = crop.w, sh = crop.w * RATIO;
  while (sw / dw > 2) {
    const nw = Math.ceil(sw / 2), nh = Math.ceil(sh / 2);
    const t = document.createElement('canvas'); t.width = nw; t.height = nh;
    const tc = t.getContext('2d'); tc.imageSmoothingQuality = 'high';
    tc.drawImage(src, sx, sy, sw, sh, 0, 0, nw, nh);
    src = t; sx = 0; sy = 0; sw = nw; sh = nh;
  }
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, dw, dh);
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, dw, dh);
}

async function exportBlob(item) {
  const c = document.createElement('canvas'); c.width = OUT_W; c.height = OUT_H;
  drawCrop(c.getContext('2d'), item.bmp, item.crop, OUT_W, OUT_H);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.95));
  const buf = new Uint8Array(await blob.arrayBuffer());
  // Write 300 DPI into the JFIF header (units = dots per inch).
  if (buf[2] === 0xFF && buf[3] === 0xE0 && buf[6] === 0x4A && buf[7] === 0x46) {
    buf[13] = 1; buf[14] = 0x01; buf[15] = 0x2C; buf[16] = 0x01; buf[17] = 0x2C;
  }
  return new Blob([buf], { type: 'image/jpeg' });
}

const outName = n => n.replace(/\.[^.]+$/, '') + '.jpg';

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------- cards ---------- */
function renderCard(item) {
  let el = item.el;
  if (!el) {
    el = item.el = document.createElement('article');
    el.className = 'card';
    $('#grid').appendChild(el);
  }
  if (item.pending) {
    el.innerHTML = `<div class="name"></div><span class="badge wait">Detecting face…</span>`;
    $('.name', el).textContent = item.file.name;
    return;
  }
  const checks = evalChecks(item);
  const bad = checks.filter(c => !c[1]).length;
  el.innerHTML = `
    <canvas width="${OUT_W}" height="${OUT_H}"></canvas>
    <div class="name"></div>
    <div><span class="badge ${bad ? 'warn' : 'ok'}">${bad ? 'Needs a look' : 'Looks good'}</span>${item.edited ? ' <span class="badge wait">Edited</span>' : ''}</div>
    <details><summary>Quality check</summary><ul class="checks">${
      checks.map(c => `<li class="${c[1] ? '' : 'fail'}">${c[0]}</li>`).join('')}</ul></details>
    <div class="row">
      <button type="button" class="btn" data-a="edit">Edit</button>
      <button type="button" class="btn primary" data-a="dl">Download</button>
    </div>`;
  $('.name', el).textContent = outName(item.file.name);
  drawCrop($('canvas', el).getContext('2d'), item.bmp, item.crop, OUT_W, OUT_H);
  $('[data-a=edit]', el).onclick = () => openEditor(item);
  $('[data-a=dl]', el).onclick = async () => download(await exportBlob(item), outName(item.file.name));
}

function updateBar() {
  $('#bar').hidden = !state.items.length;
  const n = state.items.filter(i => !i.pending).length;
  $('#count').textContent = `${n} photo${n === 1 ? '' : 's'} ready`;
}

async function addFiles(files) {
  const list = [...files].filter(f => f.type.startsWith('image/'));
  for (const file of list) {
    const item = { id: state.nextId++, file, pending: true, crop: null, face: null, edited: false };
    state.items.push(item); renderCard(item); updateBar();
    try {
      item.bmp = await createImageBitmap(file);          // applies EXIF orientation
      item.face = await detectFace(item.bmp);
      item.crop = autoCrop(item.bmp.width, item.bmp.height, item.face);
      item.pending = false;
    } catch (e) {
      state.items = state.items.filter(i => i !== item);
      item.el.remove();
      alert(`"${file.name}" could not be opened as an image.`);
      continue;
    }
    renderCard(item); updateBar();
  }
}

/* ---------- editor ---------- */
const dlg = $('#editor'), edCanvas = $('#edCanvas'), edCtx = edCanvas.getContext('2d');
let draft = null, startCrop = null;

function guideSvg() {
  const hr = state.headRatio, ry = hr * OUT_H / 2, cy = (TOP_MARGIN + hr / 2) * OUT_H;
  const eyeY = (TOP_MARGIN + hr * 0.45) * OUT_H;
  return `<g fill="none" stroke="#ff3d81" stroke-width="2">
    <ellipse cx="150" cy="${cy}" rx="${ry * 0.68}" ry="${ry}"/>
    <path d="M0 372 C8 330 70 312 112 304 L188 304 C230 312 292 330 300 372"/>
    <line x1="150" y1="0" x2="150" y2="378" stroke-dasharray="5 5" stroke-width="1.2"/>
    <line x1="50" y1="${eyeY}" x2="250" y2="${eyeY}" stroke-dasharray="5 5" stroke-width="1.2"/></g>`;
}

function drawEditor() {
  const bmp = state.editing.bmp;
  edCtx.imageSmoothingQuality = 'high';
  edCtx.fillStyle = '#fff'; edCtx.fillRect(0, 0, 450, 567);
  edCtx.drawImage(bmp, draft.x, draft.y, draft.w, draft.w * RATIO, 0, 0, 450, 567);
  const tmp = { ...state.editing, crop: draft };
  $('#edChecks').innerHTML = evalChecks(tmp).map(c => `<li class="${c[1] ? '' : 'fail'}">${c[0]}</li>`).join('');
}

function limits(bmp) {
  return { maxW: Math.min(bmp.width, bmp.height / RATIO), minW: Math.max(40, bmp.width * 0.08) };
}
function fit(c, bmp) {
  const { maxW, minW } = limits(bmp);
  c.w = clamp(c.w, minW, maxW);
  c.x = clamp(c.x, 0, bmp.width - c.w);
  c.y = clamp(c.y, 0, bmp.height - c.w * RATIO);
  return c;
}

function openEditor(item) {
  state.editing = item;
  draft = { ...item.crop }; startCrop = { ...item.crop };
  $('#edName').textContent = outName(item.file.name);
  $('#edGuide').innerHTML = guideSvg();
  $('#edGuide').style.display = $('#guideToggle').checked ? '' : 'none';
  dlg.showModal(); drawEditor();
}

function act(a) {
  const bmp = state.editing.bmp, step = draft.w * 0.03;
  if (a === 'zoomIn' || a === 'zoomOut') {
    const f = a === 'zoomIn' ? 0.94 : 1 / 0.94, nw = draft.w * f;
    draft.x += (draft.w - nw) / 2; draft.y += (draft.w - nw) * RATIO / 2; draft.w = nw;
  }
  if (a === 'left') draft.x -= step;
  if (a === 'right') draft.x += step;
  if (a === 'up') draft.y -= step;
  if (a === 'down') draft.y += step;
  if (a === 'reset') draft = { ...startCrop };
  if (a === 'auto') draft = autoCrop(bmp.width, bmp.height, state.editing.face);
  fit(draft, bmp); drawEditor();
}

dlg.addEventListener('click', e => { const b = e.target.closest('[data-act]'); if (b) act(b.dataset.act); });
$('#guideToggle').onchange = e => { $('#edGuide').style.display = e.target.checked ? '' : 'none'; };
$('#edCancel').onclick = () => dlg.close();
$('#edSave').onclick = () => {
  const it = state.editing;
  it.crop = { ...draft }; it.edited = true;
  dlg.close(); renderCard(it);
};
dlg.addEventListener('keydown', e => {
  const m = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', '+': 'zoomIn', '=': 'zoomIn', '-': 'zoomOut' };
  if (m[e.key] && !['INPUT'].includes(document.activeElement.tagName)) { e.preventDefault(); act(m[e.key]); }
});
$('.stage').addEventListener('wheel', e => { e.preventDefault(); act(e.deltaY < 0 ? 'zoomIn' : 'zoomOut'); }, { passive: false });
let drag = null;
edCanvas.addEventListener('pointerdown', e => { drag = { px: e.clientX, py: e.clientY, x: draft.x, y: draft.y }; edCanvas.setPointerCapture(e.pointerId); });
edCanvas.addEventListener('pointermove', e => {
  if (!drag) return;
  const k = draft.w / edCanvas.getBoundingClientRect().width;     // screen px -> source px
  draft.x = drag.x - (e.clientX - drag.px) * k;
  draft.y = drag.y - (e.clientY - drag.py) * k;
  fit(draft, state.editing.bmp); drawEditor();
});
['pointerup', 'pointercancel'].forEach(t => edCanvas.addEventListener(t, () => { drag = null; }));

/* ---------- page wiring ---------- */
const drop = $('#drop'), input = $('#fileInput');
input.onchange = () => { addFiles(input.files); input.value = ''; };
drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => addFiles(e.dataTransfer.files));

$('#headSize').oninput = e => {
  state.headRatio = e.target.value / 100;
  $('#headSizeOut').textContent = e.target.value + '%';
  const k = state.headRatio, hy = (TOP_MARGIN + k / 2) * OUT_H, ry = k * OUT_H / 2;
  const sh = $('#sampleHead'); sh.setAttribute('cy', hy); sh.setAttribute('ry', ry); sh.setAttribute('rx', ry * 0.68);
  $('#sampleEye').setAttribute('y1', (TOP_MARGIN + k * 0.45) * OUT_H); $('#sampleEye').setAttribute('y2', (TOP_MARGIN + k * 0.45) * OUT_H);
  state.items.forEach(it => {
    if (it.pending || it.edited) return;
    it.crop = autoCrop(it.bmp.width, it.bmp.height, it.face); renderCard(it);
  });
};
$('#headSize').dispatchEvent(new Event('input'));

$('#clearBtn').onclick = () => { state.items.forEach(i => i.el && i.el.remove()); state.items = []; updateBar(); };

$('#zipBtn').onclick = async () => {
  const ready = state.items.filter(i => !i.pending);
  if (!ready.length) return;
  const btn = $('#zipBtn'); btn.disabled = true; btn.textContent = 'Building ZIP…';
  try {
    if (!window.JSZip) { for (const i of ready) download(await exportBlob(i), outName(i.file.name)); return; }
    const zip = new JSZip(), used = new Set();
    for (const i of ready) {
      let name = outName(i.file.name), n = 1;
      while (used.has(name.toLowerCase())) name = outName(i.file.name).replace(/\.jpg$/, `_${++n}.jpg`);
      used.add(name.toLowerCase());
      zip.file(name, await exportBlob(i));
    }
    download(await zip.generateAsync({ type: 'blob' }), 'id-photos.zip');
  } finally { btn.disabled = false; btn.textContent = 'Download all as ZIP'; }
};
})();
