// 4-color grid encoder/decoder.
// Each cell encodes 2 bits using 4 maximally-separated colors.
// Grid has 3 corner finder patterns for alignment detection.
//
// Color palette chosen for maximum perceptual distance under
// typical screen-to-camera conditions (daylight, fluorescent):
//   0 = black   (0,0,0)
//   1 = white   (255,255,255)
//   2 = red     (255,0,0)
//   3 = cyan    (0,255,255)
//
// Grid layout (N x N cells):
//   - 3 finder patterns at corners (top-left, top-right, bottom-left)
//   - Bottom-right corner left open for orientation detection
//   - First HEADER_CELLS cells after finders carry the frame header
//   - Remaining cells carry payload data (2 bits each)

export const COLORS = [
  [0, 0, 0],
  [255, 255, 255],
  [255, 0, 0],
  [0, 255, 255],
];

export const FINDER_SIZE = 5;

// Finder pattern: 5x5 cells
// Outer ring = white, inner 3x3 = black, center = red
// This gives a unique high-contrast pattern detectable from any angle
export const FINDER_PATTERN = [
  [1, 1, 1, 1, 1],
  [1, 0, 0, 0, 1],
  [1, 0, 2, 0, 1],
  [1, 0, 0, 0, 1],
  [1, 1, 1, 1, 1],
];

export function getFinderPositions(gridSize) {
  return [
    [0, 0],
    [gridSize - FINDER_SIZE, 0],
    [0, gridSize - FINDER_SIZE],
  ];
}

export function isFinderCell(x, y, gridSize) {
  const finders = getFinderPositions(gridSize);
  for (const [fx, fy] of finders) {
    if (x >= fx && x < fx + FINDER_SIZE && y >= fy && y < fy + FINDER_SIZE) {
      return true;
    }
  }
  return false;
}

export function getDataCells(gridSize) {
  const cells = [];
  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      if (!isFinderCell(x, y, gridSize)) {
        cells.push([x, y]);
      }
    }
  }
  return cells;
}

export function dataCellCount(gridSize) {
  return gridSize * gridSize - 3 * FINDER_SIZE * FINDER_SIZE;
}

export function bytesPerFrame(gridSize) {
  return Math.floor(dataCellCount(gridSize) * 2 / 8);
}

// Encode a byte array into a grid of color indices.
// Returns a 2D array [y][x] of color indices (0-3).
export function encodeGrid(gridSize, data) {
  const grid = Array.from({ length: gridSize }, () => new Uint8Array(gridSize));

  const finders = getFinderPositions(gridSize);
  for (const [fx, fy] of finders) {
    for (let dy = 0; dy < FINDER_SIZE; dy++) {
      for (let dx = 0; dx < FINDER_SIZE; dx++) {
        grid[fy + dy][fx + dx] = FINDER_PATTERN[dy][dx];
      }
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
      val = ((data[bytePos] >> (7 - bitOff)) & 1) << 1;
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

// Classify an RGB pixel to the nearest palette color.
// Uses squared Euclidean distance for speed.
export function classifyColor(r, g, b) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < 4; i++) {
    const dr = r - COLORS[i][0];
    const dg = g - COLORS[i][1];
    const db = b - COLORS[i][2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

// Detect finder patterns in an image.
// Returns 3 corner positions [{x, y}, ...] or null if not found.
// imageData: Uint8ClampedArray (RGBA), w/h: image dimensions
export function detectFinders(imageData, w, h) {
  const lum = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const j = i * 4;
    lum[i] = (imageData[j] * 77 + imageData[j + 1] * 150 + imageData[j + 2] * 29) >> 8;
  }

  // Scan for horizontal run patterns: white-black-white (1:3:1 ratio)
  // that match the finder's luminance signature
  const candidates = [];
  const SCAN_STEP = Math.max(1, (Math.min(w, h) / 200) | 0);

  for (let y = 0; y < h; y += SCAN_STEP) {
    let runStart = 0;
    let runs = [];
    let lastVal = lum[y * w] > 128 ? 1 : 0;

    for (let x = 1; x < w; x++) {
      const val = lum[y * w + x] > 128 ? 1 : 0;
      if (val !== lastVal) {
        runs.push({ start: runStart, len: x - runStart, val: lastVal });
        runStart = x;
        lastVal = val;
        if (runs.length > 5) runs.shift();

        if (runs.length === 5 &&
            runs[0].val === 1 && runs[1].val === 0 && runs[2].val === 1 &&
            runs[3].val === 0 && runs[4].val === 1) {
          const totalLen = runs[0].len + runs[1].len + runs[2].len + runs[3].len + runs[4].len;
          const unit = totalLen / 5;
          const r0 = runs[0].len / unit;
          const r1 = runs[1].len / unit;
          const r2 = runs[2].len / unit;
          const r3 = runs[3].len / unit;
          const r4 = runs[4].len / unit;
          if (r0 > 0.5 && r0 < 1.5 &&
              r1 > 2.0 && r1 < 4.5 &&
              r2 > 0.5 && r2 < 1.5 &&
              r3 > 2.0 && r3 < 4.5 &&
              r4 > 0.5 && r4 < 1.5) {
            const cx = runs[0].start + totalLen / 2;
            candidates.push({ x: cx, y: y, size: totalLen });
          }
        }
      }
    }
  }

  if (candidates.length < 3) return null;

  // Cluster nearby candidates
  const clusters = [];
  for (const c of candidates) {
    let merged = false;
    for (const cl of clusters) {
      const dx = c.x - cl.x;
      const dy = c.y - cl.y;
      if (dx * dx + dy * dy < c.size * c.size) {
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

  // Need at least 3 clusters
  const sorted = clusters.filter(c => c.count >= 2).sort((a, b) => b.count - a.count);
  if (sorted.length < 3) return null;

  // Take the 3 best clusters
  const top3 = sorted.slice(0, 3);

  // Identify which is top-left, top-right, bottom-left by geometry:
  // top-left to top-right and top-left to bottom-left should be roughly perpendicular
  let bestTL = null;
  let bestScore = Infinity;

  for (let i = 0; i < 3; i++) {
    const tl = top3[i];
    const others = top3.filter((_, j) => j !== i);
    const v1x = others[0].x - tl.x;
    const v1y = others[0].y - tl.y;
    const v2x = others[1].x - tl.x;
    const v2y = others[1].y - tl.y;
    const dot = Math.abs(v1x * v2x + v1y * v2y);
    const mag = Math.sqrt(v1x * v1x + v1y * v1y) * Math.sqrt(v2x * v2x + v2y * v2y);
    const cosAngle = mag > 0 ? dot / mag : 1;
    if (cosAngle < bestScore) {
      bestScore = cosAngle;
      bestTL = i;
    }
  }

  if (bestTL === null || bestScore > 0.4) return null;

  const tl = top3[bestTL];
  const others = top3.filter((_, j) => j !== bestTL);

  // top-right has larger x, bottom-left has larger y
  let tr, bl;
  if (others[0].x > others[1].x) {
    tr = others[0]; bl = others[1];
  } else {
    tr = others[1]; bl = others[0];
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

// Sample cell colors from camera image using detected finder positions.
// Returns a 2D grid of color indices, or null on failure.
export function sampleGrid(imageData, w, h, finders, gridSize) {
  const [tl, tr, bl] = finders;

  // Finder centers correspond to the center of each 5x5 finder block.
  // TL center is at grid position (2.5, 2.5)
  // TR center is at grid position (gridSize - 2.5, 2.5)
  // BL center is at grid position (2.5, gridSize - 2.5)
  const gTL = FINDER_SIZE / 2;
  const gTR = gridSize - FINDER_SIZE / 2;
  const gBL = FINDER_SIZE / 2;
  const gBR = gridSize - FINDER_SIZE / 2;

  // Compute affine transform from grid coords to image coords
  // Using 3 points: TL, TR, BL
  // grid(gTL, gTL) -> image(tl.x, tl.y)
  // grid(gTR, gTL) -> image(tr.x, tr.y)
  // grid(gTL, gBR) -> image(bl.x, bl.y)
  const dgx = gTR - gTL;

  const axX = (tr.x - tl.x) / dgx;
  const axY = (tr.y - tl.y) / dgx;
  const ayX = (bl.x - tl.x) / (gBR - gTL);
  const ayY = (bl.y - tl.y) / (gBR - gTL);
  const ox = tl.x - axX * gTL - ayX * gTL;
  const oy = tl.y - axY * gTL - ayY * gTL;

  const grid = Array.from({ length: gridSize }, () => new Uint8Array(gridSize));

  for (let gy = 0; gy < gridSize; gy++) {
    for (let gx = 0; gx < gridSize; gx++) {
      const cx = gx + 0.5;
      const cy = gy + 0.5;
      const ix = (ox + axX * cx + ayX * cy) | 0;
      const iy = (oy + axY * cx + ayY * cy) | 0;

      if (ix < 0 || ix >= w || iy < 0 || iy >= h) {
        grid[gy][gx] = 0;
        continue;
      }

      const idx = (iy * w + ix) * 4;
      grid[gy][gx] = classifyColor(imageData[idx], imageData[idx + 1], imageData[idx + 2]);
    }
  }

  return grid;
}
