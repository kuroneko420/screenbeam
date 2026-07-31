// jsColorGrid: 4-color matrix barcode encoder/decoder in pure JavaScript.
// Author: kuroneko420 (https://github.com/kuroneko420)
// Part of screenbeam (https://github.com/kuroneko420/screenbeam)
//
// Each cell encodes 2 bits using 4 colors:
//   0 = black   (0,0,0)
//   1 = white   (255,255,255)
//   2 = red     (255,0,0)
//   3 = cyan    (0,255,255)
// Red and cyan are complementary hues, so they stay separable under
// camera white-balance shifts.
//
// Grid layout (N x N cells):
//   - 3 QR-style 7x7 finder patterns (top-left, top-right, bottom-left):
//     black border, white ring, black 3x3 center. A scanline through the
//     center reads dark-light-dark-light-dark with 1:1:3:1:1 run lengths,
//     the same signature QR detectors rely on.
//   - 1-cell white quiet ring around each finder, so a dark data cell
//     next to a finder can never merge with the finder's outer dark run.
//   - A 5x5 alignment pattern near the bottom-right corner, centered at
//     (N-3.5, N-3.5) so the 4 anchor centers form a square. The receiver
//     locates it by local search and maps cells with a perspective
//     transform, which stays accurate into the corner affine mapping
//     drifts away from.
//   - Remaining cells carry payload data (2 bits each).
//
// The grid itself has no error correction, so color frames carry a 4-byte
// FNV-1a checksum after the protocol frame (sealFrame/unsealFrame). The
// receiver drops any frame with a misread cell; the fountain layer makes
// dropped frames cheap.

import { HEADER_LEN, fnv1a } from './protocol.js';
import { rsEncode, rsDecode } from './rs.js';

export const COLORS = [
  [0, 0, 0],
  [255, 255, 255],
  [255, 0, 0],
  [0, 255, 255],
];

export const FINDER_SIZE = 7;
export const QUIET = 1;
export const SEAL_LEN = 4;

// 0 = black, 1 = white (indices into COLORS)
export const FINDER_PATTERN = [
  [0, 0, 0, 0, 0, 0, 0],
  [0, 1, 1, 1, 1, 1, 0],
  [0, 1, 0, 0, 0, 1, 0],
  [0, 1, 0, 0, 0, 1, 0],
  [0, 1, 0, 0, 0, 1, 0],
  [0, 1, 1, 1, 1, 1, 0],
  [0, 0, 0, 0, 0, 0, 0],
];

export const ALIGN_SIZE = 5;

// 0 = black, 1 = white: black border, white ring, black center.
export const ALIGN_PATTERN = [
  [0, 0, 0, 0, 0],
  [0, 1, 1, 1, 0],
  [0, 1, 0, 1, 0],
  [0, 1, 1, 1, 0],
  [0, 0, 0, 0, 0],
];

export function getFinderPositions(gridSize) {
  return [
    [0, 0],
    [gridSize - FINDER_SIZE, 0],
    [0, gridSize - FINDER_SIZE],
  ];
}

// Top-left cell of the alignment pattern: centered at (N-3.5, N-3.5),
// mirroring the finder centers so the 4 anchors form a square.
export function getAlignPosition(gridSize) {
  const start = gridSize - (FINDER_SIZE + ALIGN_SIZE) / 2;
  return [start, start];
}

export function isReservedCell(x, y, gridSize) {
  for (const [fx, fy] of getFinderPositions(gridSize)) {
    if (x >= fx - QUIET && x < fx + FINDER_SIZE + QUIET &&
        y >= fy - QUIET && y < fy + FINDER_SIZE + QUIET) {
      return true;
    }
  }
  const [ax, ay] = getAlignPosition(gridSize);
  if (x >= ax - QUIET && x < ax + ALIGN_SIZE + QUIET &&
      y >= ay - QUIET && y < ay + ALIGN_SIZE + QUIET) {
    return true;
  }
  return false;
}

export function getDataCells(gridSize) {
  const cells = [];
  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      if (!isReservedCell(x, y, gridSize)) {
        cells.push([x, y]);
      }
    }
  }
  return cells;
}

export function dataCellCount(gridSize) {
  // Each corner finder plus its quiet ring occupies (7+1)^2 = 64 cells
  // after clipping the two off-grid sides. The alignment pattern sits in
  // the interior, so its quiet ring is unclipped: (5+2)^2 = 49 cells.
  const finderBlock = FINDER_SIZE + QUIET;
  const alignBlock = ALIGN_SIZE + 2 * QUIET;
  return gridSize * gridSize - 3 * finderBlock * finderBlock - alignBlock * alignBlock;
}

export function bytesPerFrame(gridSize) {
  return Math.floor(dataCellCount(gridSize) * 2 / 8);
}

// Reed-Solomon layout for a grid: the frame capacity is split into
// `blocks` interleaved RS codewords of `total` bytes (max 255), each
// carrying `nsym` parity bytes (~12.5%, correcting ~6% byte errors per
// block). Interleaving spreads camera error bursts, which hit
// neighboring cells and therefore neighboring bytes, across blocks.
// Up to blocks-1 leftover bytes of capacity go unused.
export function rsParams(gridSize) {
  const capacity = bytesPerFrame(gridSize);
  const blocks = Math.ceil(capacity / 255);
  const total = Math.floor(capacity / blocks);
  const nsym = 2 * Math.round(total / 16);
  return { blocks, total, nsym, data: total - nsym };
}

// Usable payload bytes per color frame (sealed frame size the sender packs)
export function colorFrameCapacity(gridSize) {
  const p = rsParams(gridSize);
  return p.blocks * p.data;
}

// Sealed frame -> interleaved RS codewords ready for encodeGrid.
export function protectFrame(sealed, gridSize) {
  const { blocks, total, nsym, data } = rsParams(gridSize);
  const padded = new Uint8Array(blocks * data);
  padded.set(sealed.subarray(0, padded.length));
  const out = new Uint8Array(blocks * total);
  for (let b = 0; b < blocks; b++) {
    const code = rsEncode(padded.subarray(b * data, (b + 1) * data), nsym);
    for (let i = 0; i < total; i++) out[i * blocks + b] = code[i];
  }
  return out;
}

// Raw decoded grid bytes -> corrected sealed frame, or null when any
// block has more errors than its parity can fix.
export function recoverFrame(raw, gridSize) {
  const { blocks, total, nsym, data } = rsParams(gridSize);
  if (raw.length < blocks * total) return null;
  const out = new Uint8Array(blocks * data);
  for (let b = 0; b < blocks; b++) {
    const code = new Uint8Array(total);
    for (let i = 0; i < total; i++) code[i] = raw[i * blocks + b];
    const fixed = rsDecode(code, nsym);
    if (!fixed) return null;
    out.set(fixed.subarray(0, data), b * data);
  }
  return out;
}

// Append a 4-byte FNV-1a checksum to a packed protocol frame.
export function sealFrame(frame) {
  const out = new Uint8Array(frame.length + SEAL_LEN);
  out.set(frame, 0);
  new DataView(out.buffer).setUint32(frame.length, fnv1a(frame), true);
  return out;
}

// Verify and strip the checksum from raw decoded grid bytes (which may be
// longer than the sealed frame; the grid pads with zero cells).
// Returns the protocol frame, or null if the frame is corrupt.
export function unsealFrame(bytes) {
  if (bytes.length < HEADER_LEN + SEAL_LEN + 1) return null;
  // magic bytes, mirrors protocol.js
  if (bytes[0] !== 0xd1 || bytes[1] !== 0x0c) return null;
  const blockLen = bytes[10] | (bytes[11] << 8);
  const end = HEADER_LEN + blockLen;
  if (end + SEAL_LEN > bytes.length) return null;
  const frame = bytes.subarray(0, end);
  const dv = new DataView(bytes.buffer, bytes.byteOffset + end, SEAL_LEN);
  if (dv.getUint32(0, true) !== fnv1a(frame)) return null;
  return frame;
}

// Encode a byte array into a grid of color indices.
// Returns a 2D array [y][x] of color indices (0-3).
export function encodeGrid(gridSize, data) {
  const grid = Array.from({ length: gridSize }, () => new Uint8Array(gridSize));

  for (const [fx, fy] of getFinderPositions(gridSize)) {
    for (let dy = -QUIET; dy < FINDER_SIZE + QUIET; dy++) {
      for (let dx = -QUIET; dx < FINDER_SIZE + QUIET; dx++) {
        const x = fx + dx;
        const y = fy + dy;
        if (x < 0 || y < 0 || x >= gridSize || y >= gridSize) continue;
        const inPattern = dx >= 0 && dx < FINDER_SIZE && dy >= 0 && dy < FINDER_SIZE;
        grid[y][x] = inPattern ? FINDER_PATTERN[dy][dx] : 1;
      }
    }
  }

  const [ax, ay] = getAlignPosition(gridSize);
  for (let dy = -QUIET; dy < ALIGN_SIZE + QUIET; dy++) {
    for (let dx = -QUIET; dx < ALIGN_SIZE + QUIET; dx++) {
      const x = ax + dx;
      const y = ay + dy;
      if (x < 0 || y < 0 || x >= gridSize || y >= gridSize) continue;
      const inPattern = dx >= 0 && dx < ALIGN_SIZE && dy >= 0 && dy < ALIGN_SIZE;
      grid[y][x] = inPattern ? ALIGN_PATTERN[dy][dx] : 1;
    }
  }

  const cells = getDataCells(gridSize);
  let bitIdx = 0;
  const totalBits = data.length * 8;

  for (let i = 0; i < cells.length; i++) {
    const [x, y] = cells[i];
    if (bitIdx + 1 < totalBits) {
      const bytePos = bitIdx >> 3;
      const bitOff = bitIdx & 7;
      let val;
      if (bitOff <= 6) {
        val = (data[bytePos] >> (6 - bitOff)) & 3;
      } else {
        val = ((data[bytePos] & 1) << 1) | ((data[bytePos + 1] >> 7) & 1);
      }
      grid[y][x] = val;
      bitIdx += 2;
    } else if (bitIdx < totalBits) {
      const bytePos = bitIdx >> 3;
      const bitOff = bitIdx & 7;
      const val = ((data[bytePos] >> (7 - bitOff)) & 1) << 1;
      grid[y][x] = val;
      bitIdx += 2;
    } else {
      grid[y][x] = 0;
    }
  }

  return grid;
}

// Decode a grid of color indices back to bytes.
export function decodeGrid(gridSize, grid) {
  const cells = getDataCells(gridSize);
  const byteCount = bytesPerFrame(gridSize);
  const out = new Uint8Array(byteCount);
  let bitIdx = 0;

  for (let i = 0; i < cells.length && bitIdx < byteCount * 8; i++) {
    const [x, y] = cells[i];
    const val = grid[y][x] & 3;
    const bytePos = bitIdx >> 3;
    const bitOff = bitIdx & 7;

    if (bitOff <= 6) {
      out[bytePos] |= val << (6 - bitOff);
    } else {
      out[bytePos] |= (val >> 1) & 1;
      if (bytePos + 1 < byteCount) {
        out[bytePos + 1] |= (val & 1) << 7;
      }
    }
    bitIdx += 2;
  }

  return out;
}

// --- Finder detection ---------------------------------------------------

// Vertical cross-check at a horizontal candidate: from (cx, cy) the column
// must read dark ~3 units, bounded by light ~1 and dark ~1 on both sides.
// Returns the refined center y, or -1.
function crossCheckVertical(lum, w, h, cx, cy, unit) {
  const dark = (yy) => lum[yy * w + cx] < 128;
  if (!dark(cy)) return -1;

  let top = cy;
  while (top > 0 && dark(top - 1)) top--;
  let bot = cy;
  while (bot < h - 1 && dark(bot + 1)) bot++;
  const center = bot - top + 1;
  if (Math.abs(center / unit - 3) > 1.5) return -1;

  const limit = 3 * unit;
  let yy = top - 1;
  let lightAbove = 0;
  while (yy >= 0 && !dark(yy) && lightAbove < limit) { lightAbove++; yy--; }
  let darkAbove = 0;
  while (yy >= 0 && dark(yy) && darkAbove < limit) { darkAbove++; yy--; }

  yy = bot + 1;
  let lightBelow = 0;
  while (yy < h && !dark(yy) && lightBelow < limit) { lightBelow++; yy++; }
  let darkBelow = 0;
  while (yy < h && dark(yy) && darkBelow < limit) { darkBelow++; yy++; }

  const okOne = (len) => Math.abs(len / unit - 1) <= 0.7;
  if (!okOne(lightAbove) || !okOne(lightBelow)) return -1;
  if (!okOne(darkAbove) || !okOne(darkBelow)) return -1;

  return Math.round((top + bot) / 2);
}

// Diagonal cross-check: from the center, both diagonals must leave the
// dark 3x3 center after ~1.5 units and hit the white ring. Prunes random
// data patterns that happen to pass the horizontal + vertical checks.
function crossCheckDiagonal(lum, w, h, cx, cy, unit) {
  const dark = (xx, yy) => lum[yy * w + xx] < 128;
  for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    let steps = 0;
    let x = cx, y = cy;
    const limit = 3 * unit;
    while (x + sx >= 0 && x + sx < w && y + sy >= 0 && y + sy < h &&
           dark(x + sx, y + sy) && steps < limit) {
      x += sx; y += sy; steps++;
    }
    // center is 3 units wide, so the diagonal dark stretch from the center
    // should be ~1.5 units; the next diagonal cell must be the white ring
    if (steps > 2.5 * unit) return false;
    if (x + sx < 0 || x + sx >= w || y + sy < 0 || y + sy >= h) return false;
    if (dark(x + sx, y + sy)) return false;
  }
  return true;
}

function matchFinderRuns(runs, lum, w, h, y) {
  const total = runs[0].len + runs[1].len + runs[2].len + runs[3].len + runs[4].len;
  if (total < FINDER_SIZE) return null;
  const unit = total / FINDER_SIZE;
  const okOne = (len) => Math.abs(len / unit - 1) <= 0.7;
  if (!okOne(runs[0].len) || !okOne(runs[1].len) ||
      Math.abs(runs[2].len / unit - 3) > 1.2 ||
      !okOne(runs[3].len) || !okOne(runs[4].len)) {
    return null;
  }
  const cx = Math.round(runs[2].start + runs[2].len / 2);
  if (cx < 0 || cx >= w) return null;
  const cy = crossCheckVertical(lum, w, h, cx, y, unit);
  if (cy < 0) return null;
  if (!crossCheckDiagonal(lum, w, h, cx, cy, unit)) return null;
  return { x: cx, y: cy, size: total };
}

// Detect the 3 finder patterns in an RGBA image.
// Returns [{x, y, size}, ...] ordered top-left, top-right, bottom-left,
// where size is the finder width in pixels, or null if not found.
export function detectFinders(imageData, w, h) {
  const lum = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const j = i * 4;
    lum[i] = (imageData[j] * 77 + imageData[j + 1] * 150 + imageData[j + 2] * 29) >> 8;
  }

  // Horizontal run-length scan for the 1:1:3:1:1 dark-light signature.
  const candidates = [];
  const STEP = 2;

  for (let y = 0; y < h; y += STEP) {
    const row = y * w;
    const runs = [];
    let runStart = 0;
    let dark = lum[row] < 128;

    for (let x = 1; x <= w; x++) {
      const d = x < w ? lum[row + x] < 128 : !dark;
      if (d === dark) continue;
      runs.push({ start: runStart, len: x - runStart });
      if (runs.length > 5) runs.shift();
      // runs alternate, so if the just-closed run is dark the window
      // reads dark-light-dark-light-dark
      if (runs.length === 5 && dark) {
        const c = matchFinderRuns(runs, lum, w, h, y);
        if (c) candidates.push(c);
      }
      runStart = x;
      dark = d;
    }
  }

  if (candidates.length < 3) return null;

  // Cluster nearby candidates (multiple scanlines hit the same finder)
  const clusters = [];
  for (const c of candidates) {
    let merged = false;
    for (const cl of clusters) {
      const dx = c.x - cl.x;
      const dy = c.y - cl.y;
      const r = cl.size / 2;
      if (dx * dx + dy * dy < r * r) {
        cl.x = (cl.x * cl.count + c.x) / (cl.count + 1);
        cl.y = (cl.y * cl.count + c.y) / (cl.count + 1);
        cl.size = (cl.size * cl.count + c.size) / (cl.count + 1);
        cl.count++;
        merged = true;
        break;
      }
    }
    if (!merged) clusters.push({ ...c, count: 1 });
  }

  // Random data can occasionally imitate a finder, so don't trust the
  // scanline count alone: try every cluster triple and keep the one that
  // best forms a right isoceles corner of three equal-size finders.
  const sorted = clusters.filter(c => c.count >= 2).sort((a, b) => b.count - a.count).slice(0, 10);
  if (sorted.length < 3) return null;

  let best = null;
  let bestScore = Infinity;

  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      for (let k = j + 1; k < sorted.length; k++) {
        const triple = [sorted[i], sorted[j], sorted[k]];

        const sizes = triple.map(c => c.size);
        const sizeSpread = Math.max(...sizes) / Math.min(...sizes);
        if (sizeSpread > 1.5) continue;

        // Try each corner as top-left
        for (let t = 0; t < 3; t++) {
          const tl = triple[t];
          const others = triple.filter((_, m) => m !== t);
          const v1x = others[0].x - tl.x;
          const v1y = others[0].y - tl.y;
          const v2x = others[1].x - tl.x;
          const v2y = others[1].y - tl.y;
          const d1 = Math.sqrt(v1x * v1x + v1y * v1y);
          const d2 = Math.sqrt(v2x * v2x + v2y * v2y);
          if (!d1 || !d2) continue;

          // right angle at TL, equal arm lengths (square grid), and arms
          // must be plausible for the finder size (at least a few cells)
          const cosAngle = Math.abs(v1x * v2x + v1y * v2y) / (d1 * d2);
          const armRatio = Math.max(d1, d2) / Math.min(d1, d2);
          const cellPx = (sizes[0] + sizes[1] + sizes[2]) / 3 / FINDER_SIZE;
          if (cosAngle > 0.3 || armRatio > 1.3) continue;
          if (Math.min(d1, d2) < cellPx * FINDER_SIZE) continue;

          const score = cosAngle + (armRatio - 1) + (sizeSpread - 1);
          if (score < bestScore) {
            bestScore = score;
            best = { tl, o0: others[0], o1: others[1] };
          }
        }
      }
    }
  }

  if (!best) return null;

  const { tl } = best;
  let tr, bl;
  if (best.o0.x > best.o1.x) {
    tr = best.o0; bl = best.o1;
  } else {
    tr = best.o1; bl = best.o0;
  }

  // Cross product check: TL->TR x TL->BL should be positive (clockwise)
  const cross = (tr.x - tl.x) * (bl.y - tl.y) - (tr.y - tl.y) * (bl.x - tl.x);
  if (cross < 0) {
    [tr, bl] = [bl, tr];
  }

  return [
    { x: tl.x, y: tl.y, size: tl.size },
    { x: tr.x, y: tr.y, size: tr.size },
    { x: bl.x, y: bl.y, size: bl.size },
  ];
}

// Pick the grid size implied by the detected finders: the run unit gives
// the cell size in pixels, the center spacing gives the cell count.
// Under camera tilt the apparent cell size varies across the grid; for a
// projective foreshortening, cell count = edge length / geometric mean of
// the cell sizes at the edge's two ends.
// Returns 0 if nothing in allowedSizes is close.
export function estimateGridSize(finders, allowedSizes) {
  const [tl, tr, bl] = finders;
  const cellTL = tl.size / FINDER_SIZE;
  const cellTR = tr.size / FINDER_SIZE;
  const cellBL = bl.size / FINDER_SIZE;
  if (!(cellTL > 0) || !(cellTR > 0) || !(cellBL > 0)) return 0;
  const spanX = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const spanY = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  const estX = spanX / Math.sqrt(cellTL * cellTR);
  const estY = spanY / Math.sqrt(cellTL * cellBL);
  const est = (estX + estY) / 2 + FINDER_SIZE;

  let best = 0;
  let bestDiff = Infinity;
  for (const s of allowedSizes) {
    const d = Math.abs(s - est);
    if (d < bestDiff) { bestDiff = d; best = s; }
  }
  return bestDiff <= 6 ? best : 0;
}

// --- Cell sampling ------------------------------------------------------

const SAMPLE_OFFSETS = [
  [0, 0],
  [-0.25, -0.25], [0.25, -0.25],
  [-0.25, 0.25], [0.25, 0.25],
];

// Known-color cells inside a finder used to calibrate black/white
// references per frame (offsets from the finder origin).
const CAL_BLACK = [[3, 3], [0, 3], [3, 0], [6, 3], [3, 6]];
const CAL_WHITE = [[1, 3], [3, 1], [5, 3], [3, 5]];

// Expected luminance signature around an anchor center, as [du, dv, sign]
// offsets in cell units: sign +1 where the pattern is white, -1 where dark.
const FINDER_ANCHOR_POINTS = [
  [0, 0, -1],
  [1, 0, -1], [-1, 0, -1], [0, 1, -1], [0, -1, -1],
  [1, 1, -1], [1, -1, -1], [-1, 1, -1], [-1, -1, -1],
  [2, 0, 1], [-2, 0, 1], [0, 2, 1], [0, -2, 1],
  [2, 2, 1], [2, -2, 1], [-2, 2, 1], [-2, -2, 1],
  [3, 0, -1], [-3, 0, -1], [0, 3, -1], [0, -3, -1],
];
const ALIGN_ANCHOR_POINTS = [
  [0, 0, -1],
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, 1], [1, -1, 1], [-1, 1, 1], [-1, -1, 1],
  [2, 0, -1], [-2, 0, -1], [0, 2, -1], [0, -2, -1],
];

// Refine an anchor to sub-pixel: search a window around the predicted
// center for offsets matching the pattern signature.
//
// If searchPx exceeds the fine window (the BR alignment anchor under
// camera tilt, where the affine prediction can be several cells off),
// a coarse half-cell-step argmax pass narrows the area first.
//
// The fine pass cannot use a plain argmax: the score is flat across a
// plateau of offsets that keep every sample point inside the right
// cells, and argmax would land on the plateau edge. The plateau is
// symmetric around the true center, so use its centroid.
function refineAnchor(lumAt, predict, axX, axY, ayX, ayY, points, searchPx) {
  const cellPx = (Math.hypot(axX, axY) + Math.hypot(ayX, ayY)) / 2;
  const score = (px, py) => {
    let s = 0;
    for (const [du, dv, sign] of points) {
      s += sign * lumAt(px + axX * du + ayX * dv, py + axY * du + ayY * dv);
    }
    return s;
  };

  let seed = predict;
  const reach = Math.max(2, Math.round(1.5 * cellPx));
  if (searchPx > reach) {
    const step = Math.max(1, cellPx / 2);
    let bestScore = -Infinity;
    for (let oy = -searchPx; oy <= searchPx; oy += step) {
      for (let ox = -searchPx; ox <= searchPx; ox += step) {
        const s = score(predict.x + ox, predict.y + oy);
        if (s > bestScore) {
          bestScore = s;
          seed = { x: predict.x + ox, y: predict.y + oy };
        }
      }
    }
  }

  const scores = [];
  let bestScore = -Infinity;
  for (let oy = -reach; oy <= reach; oy++) {
    for (let ox = -reach; ox <= reach; ox++) {
      const s = score(seed.x + ox, seed.y + oy);
      scores.push(seed.x + ox, seed.y + oy, s);
      if (s > bestScore) bestScore = s;
    }
  }

  const cutoff = bestScore - Math.max(40, Math.abs(bestScore) * 0.05);
  let cx = 0, cy = 0, n = 0;
  for (let i = 0; i < scores.length; i += 3) {
    if (scores[i + 2] >= cutoff) {
      cx += scores[i];
      cy += scores[i + 1];
      n++;
    }
  }
  if (!n) return seed;
  return { x: cx / n, y: cy / n };
}

// Sample cell colors from a camera image using detected finder positions.
// Uses a perspective transform anchored at the 3 finder centers plus the
// refined alignment pattern center, and classifies against black/white
// references measured from the finders themselves, so camera exposure
// and white balance cancel out.
// Returns a 2D grid of color indices, or null on failure.
export function sampleGrid(imageData, w, h, finders, gridSize) {
  const lumAt = (x, y) => {
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix < 0 || ix >= w || iy < 0 || iy >= h) return 128;
    const i = (iy * w + ix) * 4;
    return (imageData[i] * 77 + imageData[i + 1] * 150 + imageData[i + 2] * 29) >> 8;
  };

  // Anchor centers in grid coordinates form a square:
  // (3.5, 3.5) .. (gridSize - 3.5, gridSize - 3.5)
  const gC = FINDER_SIZE / 2;
  const span = gridSize - FINDER_SIZE;

  // Affine estimate from the detected finders, used to seed refinement
  let axX = (finders[1].x - finders[0].x) / span;
  let axY = (finders[1].y - finders[0].y) / span;
  let ayX = (finders[2].x - finders[0].x) / span;
  let ayY = (finders[2].y - finders[0].y) / span;

  // Detected centers come from quantized run midpoints; refine each to
  // sub-pixel, since the perspective transform pins the anchors exactly
  // and any anchor bias becomes sampling error near that corner.
  const tl = refineAnchor(lumAt, finders[0], axX, axY, ayX, ayY, FINDER_ANCHOR_POINTS, 0);
  const tr = refineAnchor(lumAt, finders[1], axX, axY, ayX, ayY, FINDER_ANCHOR_POINTS, 0);
  const bl = refineAnchor(lumAt, finders[2], axX, axY, ayX, ayY, FINDER_ANCHOR_POINTS, 0);

  axX = (tr.x - tl.x) / span;
  axY = (tr.y - tl.y) / span;
  ayX = (bl.x - tl.x) / span;
  ayY = (bl.y - tl.y) / span;

  const brPredict = {
    x: tl.x + (axX + ayX) * span,
    y: tl.y + (axY + ayY) * span,
  };
  // Under camera tilt the affine prediction drifts by roughly the
  // perspective foreshortening across the grid: give the alignment
  // search a window proportional to the grid's pixel span.
  const spanPx = (Math.hypot(tr.x - tl.x, tr.y - tl.y) + Math.hypot(bl.x - tl.x, bl.y - tl.y)) / 2;
  const br = refineAnchor(lumAt, brPredict, axX, axY, ayX, ayY, ALIGN_ANCHOR_POINTS, 0.1 * spanPx);

  // Perspective map from the unit square (anchor centers) to the image
  // (Heckbert's square-to-quad formulation)
  const sx = tl.x - tr.x + br.x - bl.x;
  const sy = tl.y - tr.y + br.y - bl.y;
  const dx1 = tr.x - br.x;
  const dy1 = tr.y - br.y;
  const dx2 = bl.x - br.x;
  const dy2 = bl.y - br.y;
  const den = dx1 * dy2 - dx2 * dy1;
  let g = 0, hh = 0;
  if (den !== 0) {
    g = (sx * dy2 - sy * dx2) / den;
    hh = (dx1 * sy - dy1 * sx) / den;
  }
  const pa = tr.x - tl.x + g * tr.x;
  const pb = bl.x - tl.x + hh * bl.x;
  const pc = tl.x;
  const pd = tr.y - tl.y + g * tr.y;
  const pe = bl.y - tl.y + hh * bl.y;
  const pf = tl.y;

  const pt = [0, 0];
  const mapPoint = (cx, cy) => {
    const u = (cx - gC) / span;
    const v = (cy - gC) / span;
    const z = g * u + hh * v + 1;
    pt[0] = (pa * u + pb * v + pc) / z;
    pt[1] = (pd * u + pe * v + pf) / z;
  };

  const rgb = [0, 0, 0];
  const sampleCell = (gx, gy) => {
    let r = 0, gg = 0, b = 0, n = 0;
    for (const [dx, dy] of SAMPLE_OFFSETS) {
      mapPoint(gx + 0.5 + dx, gy + 0.5 + dy);
      const ix = Math.round(pt[0]);
      const iy = Math.round(pt[1]);
      if (ix < 0 || ix >= w || iy < 0 || iy >= h) continue;
      const idx = (iy * w + ix) * 4;
      r += imageData[idx];
      gg += imageData[idx + 1];
      b += imageData[idx + 2];
      n++;
    }
    if (!n) return false;
    rgb[0] = r / n;
    rgb[1] = gg / n;
    rgb[2] = b / n;
    return true;
  };

  // Calibrate black/white from the finders
  const black = [0, 0, 0];
  const white = [0, 0, 0];
  let nb = 0, nw = 0;
  for (const [fx, fy] of getFinderPositions(gridSize)) {
    for (const [dx, dy] of CAL_BLACK) {
      if (sampleCell(fx + dx, fy + dy)) {
        black[0] += rgb[0]; black[1] += rgb[1]; black[2] += rgb[2];
        nb++;
      }
    }
    for (const [dx, dy] of CAL_WHITE) {
      if (sampleCell(fx + dx, fy + dy)) {
        white[0] += rgb[0]; white[1] += rgb[1]; white[2] += rgb[2];
        nw++;
      }
    }
  }
  if (!nb || !nw) return null;
  for (let i = 0; i < 3; i++) {
    black[i] /= nb;
    white[i] /= nw;
  }
  // Sanity: measured white must be clearly brighter than measured black
  if ((white[0] + white[1] + white[2]) - (black[0] + black[1] + black[2]) < 90) {
    return null;
  }

  // Structural validation: the finder and alignment cells are known, so
  // sample them through the final mapping and require them to match. This
  // rejects frames where detection locked onto a false finder triple or
  // picked the wrong grid size, without wasting a full decode.
  const midLum = (
    (black[0] + white[0]) * 77 +
    (black[1] + white[1]) * 150 +
    (black[2] + white[2]) * 29
  ) / 512;
  let patBad = 0;
  let patTotal = 0;
  const checkCell = (gx, gy, expect) => {
    if (!sampleCell(gx, gy)) return;
    patTotal++;
    const cellLum = (rgb[0] * 77 + rgb[1] * 150 + rgb[2] * 29) / 256;
    if ((cellLum > midLum) !== (expect === 1)) patBad++;
  };
  for (const [fx, fy] of getFinderPositions(gridSize)) {
    for (let dy = 0; dy < FINDER_SIZE; dy++) {
      for (let dx = 0; dx < FINDER_SIZE; dx++) {
        checkCell(fx + dx, fy + dy, FINDER_PATTERN[dy][dx]);
      }
    }
  }
  const [alx, aly] = getAlignPosition(gridSize);
  for (let dy = 0; dy < ALIGN_SIZE; dy++) {
    for (let dx = 0; dx < ALIGN_SIZE; dx++) {
      checkCell(alx + dx, aly + dy, ALIGN_PATTERN[dy][dx]);
    }
  }
  if (!patTotal || patBad * 10 > patTotal) return null;

  // Classify in two passes. Camera crosstalk and chroma subsampling
  // desaturate red toward black and cyan toward white, so fixed reference
  // colors misread hundreds of cells. Instead: pass 1 seeds classes from
  // the red-vs-cyan opponent axis (which keeps its sign under those
  // distortions), then the measured per-class averages become the
  // references and pass 2 assigns every cell to its nearest average.
  // Everything is re-measured from scratch on each frame.
  const cellCount = gridSize * gridSize;
  const samples = new Float32Array(cellCount * 3);
  const okMask = new Uint8Array(cellCount);
  for (let gy = 0; gy < gridSize; gy++) {
    for (let gx = 0; gx < gridSize; gx++) {
      if (!sampleCell(gx, gy)) continue;
      const i = gy * gridSize + gx;
      samples[i * 3] = rgb[0];
      samples[i * 3 + 1] = rgb[1];
      samples[i * 3 + 2] = rgb[2];
      okMask[i] = 1;
    }
  }

  const lumOf = (r, g, b) => (r * 77 + g * 150 + b * 29) / 256;
  const chromaOf = (r, g, b) => r - (g + b) / 2;
  const blackLum = lumOf(black[0], black[1], black[2]);
  const whiteLum = lumOf(white[0], white[1], white[2]);
  const lumSpan = Math.max(30, whiteLum - blackLum);
  const midL = (blackLum + whiteLum) / 2;
  const blackC = chromaOf(black[0], black[1], black[2]);
  const whiteC = chromaOf(white[0], white[1], white[2]);
  const chromaFloor = 0.1 * lumSpan;

  const sums = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  for (let i = 0; i < cellCount; i++) {
    if (!okMask[i]) continue;
    const r = samples[i * 3], g = samples[i * 3 + 1], b = samples[i * 3 + 2];
    const L = lumOf(r, g, b);
    // the frame may have an overall tint, so compare each cell's chroma
    // to the neutral baseline at its luminance
    const t = Math.min(1, Math.max(0, (L - blackLum) / lumSpan));
    const dC = chromaOf(r, g, b) - (blackC + (whiteC - blackC) * t);
    let cls;
    if (dC > chromaFloor) cls = 2;
    else if (dC < -chromaFloor) cls = 3;
    else cls = L > midL ? 1 : 0;
    const s = sums[cls];
    s[0] += r; s[1] += g; s[2] += b; s[3]++;
  }

  const fallback = [
    black,
    white,
    [white[0], black[1], black[2]],
    [black[0], white[1], white[2]],
  ];
  const means = [];
  for (let c = 0; c < 4; c++) {
    const s = sums[c];
    means.push(s[3] >= 8 ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : fallback[c]);
  }

  const grid = Array.from({ length: gridSize }, () => new Uint8Array(gridSize));
  for (let gy = 0; gy < gridSize; gy++) {
    for (let gx = 0; gx < gridSize; gx++) {
      const i = gy * gridSize + gx;
      if (!okMask[i]) {
        grid[gy][gx] = 0;
        continue;
      }
      const r = samples[i * 3], g = samples[i * 3 + 1], b = samples[i * 3 + 2];
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < 4; c++) {
        const dr = r - means[c][0];
        const dg = g - means[c][1];
        const db = b - means[c][2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bestDist) {
          bestDist = d;
          best = c;
        }
      }
      grid[gy][gx] = best;
    }
  }

  return grid;
}
