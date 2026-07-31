import jsQR from 'jsqr';
import { LTDecoder } from '../shared/fountain.js';
import { fnv1a, parseFrame } from '../shared/protocol.js';
import { detectFinders, estimateGridSize, sampleGrid, decodeGrid, recoverFrame, unsealFrame } from '../shared/colorgrid.js';

const OVERHEAD_EST = 1.18;

const startBtn = document.getElementById('start');
const video = document.getElementById('video');
const preview = document.getElementById('preview');
const stats = document.getElementById('stats');
const progressEl = document.getElementById('progress');
const bar = document.getElementById('bar');
const result = document.getElementById('result');
const settings = document.getElementById('settings');
const metricsEl = document.getElementById('metrics');
const metric = (id) => document.getElementById(id);

let stream = null;
let decodeMode = 'qr';
let decoder = null;
let sessionId = 0;
let startTs = 0;
let captureGen = 0;
let done = false;
let decoding = false;

const captureTimes = [];
const decodeTimes = [];
let skippedFrames = 0;

// Shakycam: detect and discard frames captured mid-screen-refresh.
// Samples a sparse luminance grid and compares to the previous frame.
// Stable frames (low diff) get decoded. Transitional frames get skipped.
let prevLum = null;
const SC_GRID = 20;
const SC_THRESH = 12;

function isFrameStable(data, w, h) {
  const stepX = Math.max(1, (w / SC_GRID) | 0);
  const stepY = Math.max(1, (h / SC_GRID) | 0);
  const len = Math.ceil(h / stepY) * Math.ceil(w / stepX);
  const lum = new Uint8Array(len);
  let idx = 0;

  for (let y = 0; y < h; y += stepY) {
    const row = y * w;
    for (let x = 0; x < w; x += stepX) {
      const i = (row + x) * 4;
      lum[idx++] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
    }
  }

  if (!prevLum || prevLum.length !== idx) {
    prevLum = lum.slice(0, idx);
    return true;
  }

  let diff = 0;
  for (let i = 0; i < idx; i++) diff += Math.abs(lum[i] - prevLum[i]);
  diff /= idx;

  for (let i = 0; i < idx; i++) prevLum[i] = lum[i];
  return diff < SC_THRESH;
}

startBtn.onclick = () => start();

async function start() {
  if (!navigator.mediaDevices?.getUserMedia) {
    stats.textContent = 'Camera needs a secure context (HTTPS or file://).';
    return;
  }

  const captureWidth = Number(document.getElementById('cfg-width').value);
  const captureFps = Number(document.getElementById('cfg-capfps').value);
  decodeMode = document.getElementById('cfg-decmode').value;

  settings.style.display = 'none';
  startBtn.style.display = 'none';
  preview.style.display = 'block';
  metricsEl.style.display = 'grid';

  const base = {
    facingMode: 'environment',
    width: { ideal: captureWidth },
    height: { ideal: Math.round((captureWidth * 3) / 4) },
  };

  try {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { ...base, frameRate: { exact: captureFps } },
      });
    } catch {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { ...base, frameRate: { ideal: captureFps } },
      });
    }
  } catch (err) {
    stats.textContent = 'Camera error: ' + (err instanceof Error ? err.message : String(err));
    return;
  }

  video.srcObject = stream;
  await video.play().catch(() => {});

  const track = stream.getVideoTracks()[0];
  const s = track?.getSettings();
  stats.textContent =
    'camera ' + s?.width + 'x' + s?.height + '@' + s?.frameRate +
    ' -- searching for stream...';

  captureGen++;
  scheduleFrame(captureGen);
  setInterval(updateStats, 500);

  try { navigator.wakeLock?.request('screen').catch(() => {}); } catch {}
}

function scheduleFrame(gen) {
  if (done || gen !== captureGen) return;
  const next = () => {
    if (done || gen !== captureGen) return;
    captureFrame();
    scheduleFrame(gen);
  };
  if (video.requestVideoFrameCallback) {
    video.requestVideoFrameCallback(next);
  } else {
    requestAnimationFrame(next);
  }
}

const grab = document.createElement('canvas');

// Must match the sender's grid size options
const COLOR_GRID_SIZES = [48, 64, 80, 96];

// Cumulative counts of how far color frames get through the pipeline:
// finders detected, grid size resolved, sampling validated, checksum ok
const colorStages = { find: 0, size: 0, valid: 0, ok: 0 };

function tryColorDecode(imageData, w, h) {
  const finders = detectFinders(imageData, w, h);
  if (!finders) return null;
  colorStages.find++;

  const gridSize = estimateGridSize(finders, COLOR_GRID_SIZES);
  if (!gridSize) return null;
  colorStages.size++;

  const grid = sampleGrid(imageData, w, h, finders, gridSize);
  if (!grid) return null;
  colorStages.valid++;

  // recoverFrame fixes up to ~6% corrupted bytes via Reed-Solomon;
  // unsealFrame then verifies the checksum so nothing corrupt survives
  const sealed = recoverFrame(decodeGrid(gridSize, grid), gridSize);
  if (!sealed) return null;
  const frame = unsealFrame(sealed);
  if (frame) colorStages.ok++;
  return frame;
}

function captureFrame() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;
  captureTimes.push(performance.now());
  if (decoding) return;

  if (grab.width !== vw || grab.height !== vh) {
    grab.width = vw;
    grab.height = vh;
  }
  const ctx = grab.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0);
  const img = ctx.getImageData(0, 0, vw, vh);

  if (!isFrameStable(img.data, vw, vh)) {
    skippedFrames++;
    return;
  }

  decoding = true;

  // The two decoders are never stacked on one frame: color detection is
  // expensive and a QR code's own corner markers match its signature, so
  // running both would starve jsQR on phones
  if (decodeMode === 'color') {
    const colorResult = tryColorDecode(img.data, vw, vh);
    decoding = false;
    if (colorResult) onDecoded(colorResult);
    return;
  }

  const qr = jsQR(img.data, vw, vh, { inversionAttempts: 'dontInvert' });
  decoding = false;

  if (qr && qr.binaryData && qr.binaryData.length > 0) {
    onDecoded(new Uint8Array(qr.binaryData));
  }
}

function onDecoded(bytes) {
  decodeTimes.push(performance.now());
  const parsed = parseFrame(bytes);
  if (!parsed || done) return;
  const { header, block } = parsed;

  if (!decoder || sessionId !== header.sessionId) {
    decoder = new LTDecoder(header.k, header.blockLen, header.sessionId, header.totalLen);
    sessionId = header.sessionId;
    startTs = performance.now();
    progressEl.style.display = 'block';
  }

  decoder.addFrame(header.seq, block);
  const progress = Math.min(0.99, decoder.framesNew / (decoder.k * OVERHEAD_EST));
  bar.style.width = (progress * 100).toFixed(1) + '%';

  if (decoder.isComplete) {
    const payload = decoder.assemble();
    const seconds = (performance.now() - startTs) / 1000;
    const ok = fnv1a(payload) === header.payloadFnv;
    finish(payload, ok, seconds);
  }
}

function finish(payload, hashOk, seconds) {
  done = true;
  captureGen++;
  stream?.getTracks().forEach(t => t.stop());
  preview.style.display = 'none';
  bar.style.width = '100%';

  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const nameLen = dv.getUint16(0, true);
  const nameBytes = payload.subarray(2, 2 + nameLen);
  const filename = new TextDecoder().decode(nameBytes);
  const fileData = payload.subarray(2 + nameLen);

  const kb = (fileData.length / 1024).toFixed(1);
  const rate = (fileData.length / 1024 / seconds).toFixed(1);
  stats.textContent =
    kb + ' KB in ' + seconds.toFixed(1) + 's | ' + rate + ' KB/s | hash ' +
    (hashOk ? 'verified' : 'MISMATCH');

  const heading = document.createElement('div');
  heading.className = 'done';
  heading.textContent = 'Transfer Complete!';

  const info = document.createElement('div');
  info.className = 'file-info';
  info.textContent = filename;

  const blob = new Blob([fileData]);
  const url = URL.createObjectURL(blob);

  const dl = document.createElement('a');
  dl.href = url;
  dl.download = filename;
  dl.className = 'download-btn';
  dl.textContent = 'Download ' + filename;

  if (/\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(filename)) {
    const img = document.createElement('img');
    img.className = 'received';
    img.src = url;
    result.append(heading, info, img, dl);
  } else {
    result.append(heading, info, dl);
  }
}

function formatSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function updateStats() {
  if (done) return;
  const now = performance.now();
  const prune = (a) => { while (a.length && a[0] < now - 2000) a.shift(); };
  prune(captureTimes);
  prune(decodeTimes);
  metric('m-cap').textContent = (captureTimes.length / 2).toFixed(0);
  metric('m-dec').textContent = (decodeTimes.length / 2).toFixed(1);
  metric('m-stages').textContent = decodeMode === 'color'
    ? colorStages.find + '/' + colorStages.size + '/' + colorStages.valid + '/' + colorStages.ok
    : 'qr';
  if (!decoder) return;
  const elapsed = (now - startTs) / 1000;
  const kbs = (decoder.framesNew * decoder.blockLen) / OVERHEAD_EST / 1024 / Math.max(0.1, elapsed);
  metric('m-rate').textContent = kbs.toFixed(1) + ' KB/s';
  metric('m-time').textContent = elapsed.toFixed(0) + 's';
  metric('m-frames').textContent = decoder.framesNew + '/' + decoder.framesDup + '/' + skippedFrames;
  metric('m-k').textContent = decoder.k + ' x ' + decoder.blockLen + 'B';
  metric('m-payload').textContent = formatSize(decoder.totalLen);
}
