// Decode worker: runs jsQR / jsColorGrid decoding off the main thread so
// frame capture never blocks on a slow decode.
//
// For color mode it also tracks the code's position between frames (ROI):
// after a successful detection, the next frames only search a padded crop
// around the last known position instead of the full camera image. A few
// consecutive misses fall back to a full-frame search.
import jsQR from 'jsqr';
import {
  detectFinders, estimateGridSize, sampleGrid, decodeGrid,
  recoverFrame, unsealFrame,
} from '../shared/colorgrid.js';

// Must match the sender's grid size options
const COLOR_GRID_SIZES = [48, 64, 80, 96];

const stages = { find: 0, size: 0, valid: 0, ok: 0 };

let roi = null;
let roiMisses = 0;
const ROI_MAX_MISSES = 4;

function clampRect(r, w, h) {
  const x0 = Math.max(0, Math.floor(r.x0));
  const y0 = Math.max(0, Math.floor(r.y0));
  const x1 = Math.min(w, Math.ceil(r.x1));
  const y1 = Math.min(h, Math.ceil(r.y1));
  if (x1 - x0 < 32 || y1 - y0 < 32) return null;
  return { x0, y0, x1, y1 };
}

function cropImage(data, w, r) {
  const cw = r.x1 - r.x0;
  const ch = r.y1 - r.y0;
  const out = new Uint8ClampedArray(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    const src = ((y + r.y0) * w + r.x0) * 4;
    out.set(data.subarray(src, src + cw * 4), y * cw * 4);
  }
  return { data: out, w: cw, h: ch };
}

// Bounding box of the detected finder centers, padded enough to cover the
// whole grid (the bottom-right corner extends ~span beyond the centers)
// plus room for hand jitter.
function roiFromFinders(finders, offX, offY) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const f of finders) {
    x0 = Math.min(x0, f.x); y0 = Math.min(y0, f.y);
    x1 = Math.max(x1, f.x); y1 = Math.max(y1, f.y);
  }
  const pad = 0.3 * Math.max(x1 - x0, y1 - y0) + 16;
  return {
    x0: offX + x0 - pad,
    y0: offY + y0 - pad,
    x1: offX + x1 + pad,
    y1: offY + y1 + pad,
  };
}

function tryRegion(data, w, h, rect) {
  let img = data, iw = w, ih = h, offX = 0, offY = 0;
  if (rect) {
    const c = cropImage(data, w, rect);
    img = c.data; iw = c.w; ih = c.h;
    offX = rect.x0; offY = rect.y0;
  }

  const finders = detectFinders(img, iw, ih);
  if (!finders) return { frame: null, found: false };
  stages.find++;
  roi = roiFromFinders(finders, offX, offY);
  roiMisses = 0;

  const gridSize = estimateGridSize(finders, COLOR_GRID_SIZES);
  if (!gridSize) return { frame: null, found: true };
  stages.size++;

  const grid = sampleGrid(img, iw, ih, finders, gridSize);
  if (!grid) return { frame: null, found: true };
  stages.valid++;

  const sealed = recoverFrame(decodeGrid(gridSize, grid), gridSize);
  if (!sealed) return { frame: null, found: true };
  const frame = unsealFrame(sealed);
  if (frame) stages.ok++;
  return { frame, found: true };
}

export function decodeColor(data, w, h) {
  if (roi) {
    const r = clampRect(roi, w, h);
    if (r) {
      const res = tryRegion(data, w, h, r);
      if (res.found) return res.frame;
      roiMisses++;
      if (roiMisses <= ROI_MAX_MISSES) return null;
      roi = null;
    } else {
      roi = null;
    }
  }
  return tryRegion(data, w, h, null).frame;
}

export function decodeQR(data, w, h) {
  const qr = jsQR(data, w, h, { inversionAttempts: 'dontInvert' });
  if (qr && qr.binaryData && qr.binaryData.length > 0) {
    return new Uint8Array(qr.binaryData);
  }
  return null;
}

if (typeof self !== 'undefined' && typeof window === 'undefined') {
  self.onmessage = (e) => {
    const { mode, buf, w, h } = e.data;
    const data = new Uint8ClampedArray(buf);
    const frame = mode === 'color' ? decodeColor(data, w, h) : decodeQR(data, w, h);
    self.postMessage({ frame, stages }, frame ? [frame.buffer] : []);
  };
}
