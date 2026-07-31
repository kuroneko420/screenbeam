// Reed-Solomon over GF(256), polynomial 0x11d (same field as QR codes).
// Part of jsColorGrid / screenbeam by kuroneko420
// (https://github.com/kuroneko420)
// Encoder appends nsym parity bytes; decoder corrects up to nsym/2
// corrupted bytes anywhere in the codeword, or returns null when the
// damage exceeds that.
//
// Ported from the classic Berlekamp-Massey / Chien / Forney formulation
// (polynomials stored most-significant coefficient first).

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function gfDiv(a, b) {
  if (a === 0) return 0;
  return EXP[(LOG[a] + 255 - LOG[b]) % 255];
}

function gfInv(a) {
  return EXP[255 - LOG[a]];
}

function polyScale(p, x) {
  const r = new Uint8Array(p.length);
  for (let i = 0; i < p.length; i++) r[i] = gfMul(p[i], x);
  return r;
}

function polyAdd(p, q) {
  const r = new Uint8Array(Math.max(p.length, q.length));
  for (let i = 0; i < p.length; i++) r[i + r.length - p.length] ^= p[i];
  for (let i = 0; i < q.length; i++) r[i + r.length - q.length] ^= q[i];
  return r;
}

function polyMul(p, q) {
  const r = new Uint8Array(p.length + q.length - 1);
  for (let j = 0; j < q.length; j++) {
    for (let i = 0; i < p.length; i++) {
      r[i + j] ^= gfMul(p[i], q[j]);
    }
  }
  return r;
}

function polyEval(p, x) {
  let y = p[0];
  for (let i = 1; i < p.length; i++) y = gfMul(y, x) ^ p[i];
  return y;
}

const genCache = new Map();
function generator(nsym) {
  let g = genCache.get(nsym);
  if (g) return g;
  g = new Uint8Array([1]);
  for (let i = 0; i < nsym; i++) {
    g = polyMul(g, new Uint8Array([1, EXP[i]]));
  }
  genCache.set(nsym, g);
  return g;
}

// Encode: returns data with nsym parity bytes appended.
export function rsEncode(data, nsym) {
  const gen = generator(nsym);
  const out = new Uint8Array(data.length + nsym);
  out.set(data);
  for (let i = 0; i < data.length; i++) {
    const coef = out[i];
    if (coef !== 0) {
      for (let j = 1; j < gen.length; j++) {
        out[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }
  out.set(data);
  return out;
}

// Decode a codeword of (data + nsym parity) bytes in place.
// Returns the corrected full codeword, or null if uncorrectable.
export function rsDecode(msg, nsym) {
  const synd = new Uint8Array(nsym);
  let hasErr = 0;
  for (let i = 0; i < nsym; i++) {
    const s = polyEval(msg, EXP[i]);
    synd[i] = s;
    hasErr |= s;
  }
  if (!hasErr) return msg;

  // Berlekamp-Massey: find the error locator polynomial
  let errLoc = new Uint8Array([1]);
  let oldLoc = new Uint8Array([1]);
  for (let i = 0; i < nsym; i++) {
    let delta = synd[i];
    for (let j = 1; j < errLoc.length; j++) {
      delta ^= gfMul(errLoc[errLoc.length - 1 - j], synd[i - j]);
    }
    const grown = new Uint8Array(oldLoc.length + 1);
    grown.set(oldLoc);
    oldLoc = grown;
    if (delta !== 0) {
      if (oldLoc.length > errLoc.length) {
        const newLoc = polyScale(oldLoc, delta);
        oldLoc = polyScale(errLoc, gfInv(delta));
        errLoc = newLoc;
      }
      errLoc = polyAdd(errLoc, polyScale(oldLoc, delta));
    }
  }

  // strip leading zeros
  let lead = 0;
  while (lead < errLoc.length - 1 && errLoc[lead] === 0) lead++;
  errLoc = errLoc.subarray(lead);

  const errCount = errLoc.length - 1;
  if (errCount === 0 || 2 * errCount > nsym) return null;

  // Chien search: find error positions
  const errPos = [];
  for (let i = 0; i < msg.length; i++) {
    if (polyEval(errLoc, EXP[(255 - i) % 255]) === 0) {
      errPos.push(msg.length - 1 - i);
    }
  }
  if (errPos.length !== errCount) return null;

  // Forney: compute error magnitudes
  // error evaluator omega = synd_rev * errLoc mod x^nsym
  const syndRev = new Uint8Array(nsym);
  for (let i = 0; i < nsym; i++) syndRev[i] = synd[nsym - 1 - i];
  const full = polyMul(syndRev, errLoc);
  const omega = full.subarray(full.length - nsym);

  for (const pos of errPos) {
    const xi = EXP[(255 - (msg.length - 1 - pos)) % 255]; // Xi^-1
    // formal derivative of errLoc evaluated at Xi^-1
    let derivative = 0;
    // errLoc'(x): sum over odd powers; with MSB-first storage,
    // coefficient errLoc[i] has degree (len-1-i)
    const deg = errLoc.length - 1;
    for (let i = 0; i < errLoc.length; i++) {
      const d = deg - i;
      if (d & 1) {
        // derivative term: d * c * x^(d-1); in GF(2^8) d*c = c if d odd
        derivative ^= gfMul(errLoc[i], EXP[(LOG[xi] * (d - 1)) % 255] || 1);
      }
    }
    if (derivative === 0) return null;
    const y = polyEval(omega, xi);
    const xiPow = EXP[(msg.length - 1 - pos) % 255];
    const magnitude = gfMul(xiPow, gfDiv(y, derivative));
    msg[pos] ^= magnitude;
  }

  // verify: recompute syndromes on the corrected message
  for (let i = 0; i < nsym; i++) {
    if (polyEval(msg, EXP[i]) !== 0) return null;
  }
  return msg;
}
