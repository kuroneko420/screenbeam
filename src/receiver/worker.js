// Decode worker: runs jsQR / jsColorGrid decoding off the main thread so
// frame capture never blocks on a slow decode.
//
// Workers are stateless so the main thread can run a pool of them: the
// image may already be a crop of the camera frame (the main thread tracks
// the code's position and grabs only that region), with offX/offY giving
// the crop's position so the returned ROI is in camera coordinates.
import jsQR from 'jsqr';
import {
  detectFinders, estimateGridSize, sampleGrid, decodeGrid,
  recoverFrame, unsealFrame,
} from '../shared/colorgrid.js';

// Must match the sender's grid size options
const COLOR_GRID_SIZES = [48, 64, 80, 96];

// Bounding box of the detected finder centers, padded enough to cover the
// whole grid (the bottom-right corner extends beyond the centers) plus
// room for hand jitter. offX/offY translate crop to camera coordinates.
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

export function decodeColorJob(data, w, h, offX, offY) {
  const st = { find: false, size: false, valid: false, ok: false };

  const finders = detectFinders(data, w, h);
  if (!finders) return { frame: null, roi: null, st };
  st.find = true;
  const roi = roiFromFinders(finders, offX, offY);

  const gridSize = estimateGridSize(finders, COLOR_GRID_SIZES);
  if (!gridSize) return { frame: null, roi, st };
  st.size = true;

  const grid = sampleGrid(data, w, h, finders, gridSize);
  if (!grid) return { frame: null, roi, st };
  st.valid = true;

  const sealed = recoverFrame(decodeGrid(gridSize, grid), gridSize);
  const frame = sealed ? unsealFrame(sealed) : null;
  if (frame) st.ok = true;
  return { frame, roi, st };
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
    const { mode, buf, w, h, offX, offY } = e.data;
    const data = new Uint8ClampedArray(buf);
    if (mode === 'color') {
      const res = decodeColorJob(data, w, h, offX || 0, offY || 0);
      self.postMessage(
        { frame: res.frame, roi: res.roi, st: res.st },
        res.frame ? [res.frame.buffer] : []
      );
    } else {
      const frame = decodeQR(data, w, h);
      self.postMessage({ frame, roi: null, st: null }, frame ? [frame.buffer] : []);
    }
  };
}
