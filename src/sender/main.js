import QRCode from 'qrcode';
import { LTEncoder } from '../shared/fountain.js';
import { HEADER_LEN, fnv1a, packFrame } from '../shared/protocol.js';
import { COLORS, FINDER_SIZE, FINDER_PATTERN, getFinderPositions, getDataCells, bytesPerFrame, encodeGrid } from '../shared/colorgrid.js';

const MARGIN = 4;
const LOOKAHEAD = 3;
const COLOR_GRID_SIZE = 64;

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const fileInfo = document.getElementById('file-info');
const canvas = document.getElementById('qr');
const specs = document.getElementById('specs');
const stage = document.getElementById('stage');
const cfgFps = document.getElementById('cfg-fps');
const cfgBytes = document.getElementById('cfg-bytes');
const cfgEcc = document.getElementById('cfg-ecc');
const cfgSize = document.getElementById('cfg-size');
const cfgMode = document.getElementById('cfg-mode');
const cfgGrid = document.getElementById('cfg-grid');

let generation = 0;
let currentPayload = null;

function formatSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function buildPayload(name, fileBytes) {
  const nameEnc = new TextEncoder().encode(name);
  const out = new Uint8Array(2 + nameEnc.length + fileBytes.length);
  new DataView(out.buffer).setUint16(0, nameEnc.length, true);
  out.set(nameEnc, 2);
  out.set(fileBytes, 2 + nameEnc.length);
  return out;
}

// File input
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => {
  if (e.target.files.length) handleFile(e.target.files[0]);
});
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});

async function handleFile(file) {
  const buf = await file.arrayBuffer();
  const fileBytes = new Uint8Array(buf);
  currentPayload = buildPayload(file.name, fileBytes);

  dropZone.style.display = 'none';
  stage.style.display = 'flex';
  fileInfo.textContent = file.name + ' (' + formatSize(file.size) + ')';
  fileInfo.style.display = 'block';
  startStream();
}

for (const el of [cfgFps, cfgBytes, cfgEcc, cfgSize, cfgMode, cfgGrid]) {
  if (el) el.addEventListener('change', () => { if (currentPayload) startStream(); });
}

function startStream() {
  const gen = ++generation;
  const payload = currentPayload;
  if (!payload) return;

  const mode = cfgMode ? cfgMode.value : 'qr';
  if (mode === 'color') {
    startColorStream(gen, payload);
  } else {
    startQRStream(gen, payload);
  }
}

function startQRStream(gen, payload) {
  const txFps = Number(cfgFps.value);
  const frameBytes = Number(cfgBytes.value);
  const ecc = cfgEcc.value;
  const displayPx = Number(cfgSize.value);

  const sessionId = (Math.floor(Math.random() * 0xffff) + 1) & 0xffff;
  const blockLen = frameBytes - HEADER_LEN;
  const encoder = new LTEncoder(payload, blockLen, sessionId);
  const header = {
    sessionId,
    seq: 0,
    k: encoder.k,
    blockLen,
    totalLen: payload.length,
    payloadFnv: fnv1a(payload),
  };

  let version;
  let modules = 0;
  let scale = 1;
  const staging = document.createElement('canvas');
  const queue = [];
  let nextSeq = 0;

  const sizeCanvas = () => {
    const dpr = window.devicePixelRatio || 1;
    const total = modules + 2 * MARGIN;
    const cssBudget = Math.min(0.9 * Math.min(window.innerWidth, window.innerHeight), displayPx);
    scale = Math.max(1, Math.floor((cssBudget * dpr) / total));
    staging.width = total;
    staging.height = total;
    canvas.width = total * scale;
    canvas.height = total * scale;
    canvas.style.width = (total * scale) / dpr + 'px';
    canvas.style.height = (total * scale) / dpr + 'px';
  };

  const makeFrame = () => {
    const bytes = packFrame({ ...header, seq: nextSeq }, encoder.encode(nextSeq));
    nextSeq++;
    const qr = QRCode.create([{ data: bytes, mode: 'byte' }], {
      errorCorrectionLevel: ecc,
      version,
      maskPattern: 4,
    });
    if (version === undefined) {
      version = qr.version;
      modules = qr.modules.size;
      sizeCanvas();
      specs.textContent =
        txFps + ' FPS | ' + frameBytes + ' B/frame | V' + version +
        ' | ECC ' + ecc + ' | ' + formatSize(payload.length) +
        ' payload | K=' + encoder.k;
    }
    const size = qr.modules.size;
    const data = qr.modules.data;
    const total = size + 2 * MARGIN;
    const img = new ImageData(total, total);
    const px = new Uint32Array(img.data.buffer);
    px.fill(0xffffffff);
    for (let y = 0; y < size; y++) {
      const row = (y + MARGIN) * total + MARGIN;
      const src = y * size;
      for (let x = 0; x < size; x++) {
        if (data[src + x]) px[row + x] = 0xff000000;
      }
    }
    return img;
  };

  const pump = () => {
    if (gen !== generation) return;
    try {
      while (queue.length < LOOKAHEAD) queue.push(makeFrame());
    } catch (err) {
      specs.textContent = 'Error: ' + (err instanceof Error ? err.message : String(err));
      return;
    }
    setTimeout(pump, 0);
  };
  pump();

  const interval = 1000 / txFps;
  let nextAt = performance.now();
  const tick = (now) => {
    if (gen !== generation) return;
    requestAnimationFrame(tick);
    if (now < nextAt) return;
    const img = queue.shift();
    if (!img) { nextAt = now + interval; return; }
    staging.getContext('2d').putImageData(img, 0, 0);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(staging, 0, 0, canvas.width, canvas.height);
    nextAt += interval;
    if (now - nextAt > 3 * interval) nextAt = now + interval;
  };
  requestAnimationFrame(tick);
}

function startColorStream(gen, payload) {
  const txFps = Number(cfgFps.value);
  const displayPx = Number(cfgSize.value);
  const gridSize = cfgGrid ? Number(cfgGrid.value) : COLOR_GRID_SIZE;
  const colorFrameBytes = bytesPerFrame(gridSize);
  const blockLen = colorFrameBytes - HEADER_LEN;

  const sessionId = (Math.floor(Math.random() * 0xffff) + 1) & 0xffff;
  const encoder = new LTEncoder(payload, blockLen, sessionId);
  const header = {
    sessionId,
    seq: 0,
    k: encoder.k,
    blockLen,
    totalLen: payload.length,
    payloadFnv: fnv1a(payload),
  };

  specs.textContent =
    txFps + ' FPS | 4-color ' + gridSize + 'x' + gridSize +
    ' | ' + colorFrameBytes + ' B/frame | ' + formatSize(payload.length) +
    ' payload | K=' + encoder.k;

  const total = gridSize + 2 * MARGIN;
  const staging = document.createElement('canvas');
  staging.width = total;
  staging.height = total;

  const dpr = window.devicePixelRatio || 1;
  const cssBudget = Math.min(0.9 * Math.min(window.innerWidth, window.innerHeight), displayPx);
  const scale = Math.max(1, Math.floor((cssBudget * dpr) / total));
  canvas.width = total * scale;
  canvas.height = total * scale;
  canvas.style.width = (total * scale) / dpr + 'px';
  canvas.style.height = (total * scale) / dpr + 'px';

  const RGBA = [
    0xff000000,
    0xffffffff,
    0xff0000ff,
    0xffffff00,
  ];

  const queue = [];
  let nextSeq = 0;

  const makeFrame = () => {
    const frameData = packFrame({ ...header, seq: nextSeq }, encoder.encode(nextSeq));
    nextSeq++;
    const grid = encodeGrid(gridSize, frameData);
    const img = new ImageData(total, total);
    const px = new Uint32Array(img.data.buffer);
    px.fill(0xff888888);

    for (let y = 0; y < gridSize; y++) {
      for (let x = 0; x < gridSize; x++) {
        px[(y + MARGIN) * total + (x + MARGIN)] = RGBA[grid[y][x]];
      }
    }
    return img;
  };

  const pump = () => {
    if (gen !== generation) return;
    while (queue.length < LOOKAHEAD) queue.push(makeFrame());
    setTimeout(pump, 0);
  };
  pump();

  const interval = 1000 / txFps;
  let nextAt = performance.now();
  const tick = (now) => {
    if (gen !== generation) return;
    requestAnimationFrame(tick);
    if (now < nextAt) return;
    const img = queue.shift();
    if (!img) { nextAt = now + interval; return; }
    staging.getContext('2d').putImageData(img, 0, 0);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(staging, 0, 0, canvas.width, canvas.height);
    nextAt += interval;
    if (now - nextAt > 3 * interval) nextAt = now + interval;
  };
  requestAnimationFrame(tick);
}

try { navigator.wakeLock?.request('screen').catch(() => {}); } catch {}

// Auto-load embedded payload (for automation: set window.__SCREENBEAM__
// to { data: base64string, filename: string } before this script runs)
if (window.__SCREENBEAM__) {
  const { data, filename } = window.__SCREENBEAM__;
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  currentPayload = buildPayload(filename, bytes);
  dropZone.style.display = 'none';
  stage.style.display = 'flex';
  fileInfo.textContent = filename + ' (' + formatSize(bytes.length) + ')';
  fileInfo.style.display = 'block';
  startStream();
}
