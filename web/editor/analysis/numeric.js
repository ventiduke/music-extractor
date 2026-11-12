// Small numeric helpers that behave like the Python / numpy calls the analysis
// was written with, so the port gives the same numbers as `sketch/*.py`.

/** Round half to even, to an integer (numpy's `np.round(x)` / `np.rint`). */
export function rint(x) {
  const r = Math.round(x); // JS rounds halves up
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** Python's `round(x, digits)`: correctly rounded on the exact value of the double, exact halves go to even. */
export function pyRound(x, digits = 0) {
  if (!Number.isFinite(x)) return x;
  if (digits === 0) return rint(x);
  // x is an exact half at `digits` decimals only when x * 2^(digits+1) is an odd integer.
  const scaled = x * 2 ** (digits + 1);
  if (Number.isInteger(scaled) && Math.abs(scaled) % 2 === 1) {
    const twice = scaled * 5 ** digits; // 2 * x * 10^digits, an odd integer
    const lower = (twice - 1) / 2;
    return (lower % 2 === 0 ? lower : lower + 1) / 10 ** digits;
  }
  return Number(x.toFixed(digits)); // toFixed works on the exact decimal expansion
}

/** Python's `a // b` for floats (floor division, computed the way CPython and numpy do). */
export function floorDiv(a, b) {
  let mod = a % b;
  let div = (a - mod) / b;
  if (mod !== 0 && (b < 0) !== (mod < 0)) div -= 1;
  if (div === 0) return 0;
  const floor = Math.floor(div);
  return div - floor > 0.5 ? floor + 1 : floor;
}

/** Python's `a % b`: the result takes the sign of `b`. */
export function pyMod(a, b) {
  const mod = a % b;
  return mod !== 0 && (b < 0) !== (mod < 0) ? mod + b : mod;
}

/** `np.interp(x, xp, fp)` for one x: linear between points, clamped to the end values outside them. */
export function interp(x, xp, fp) {
  const n = xp.length;
  if (x < xp[0]) return fp[0];
  if (x > xp[n - 1]) return fp[n - 1];
  let lo = 0, hi = n - 1; // largest j with xp[j] <= x
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (xp[mid] <= x) lo = mid; else hi = mid - 1;
  }
  if (lo === n - 1 || xp[lo] === x) return fp[lo];
  const slope = (fp[lo + 1] - fp[lo]) / (xp[lo + 1] - xp[lo]);
  return slope * (x - xp[lo]) + fp[lo];
}

/** `np.arange(n)`. */
export const arange = (n) => Array.from({ length: n }, (_, i) => i);

/** `np.diff(a)`. */
export function diff(a) {
  const out = new Array(Math.max(a.length - 1, 0));
  for (let i = 0; i + 1 < a.length; i++) out[i] = a[i + 1] - a[i];
  return out;
}

/** `np.median(a)`: the middle value, or the mean of the two middle values. */
export function median(a) {
  const s = Float64Array.from(a).sort();
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** `np.gradient(a)` with unit spacing: one-sided differences at the ends, central ones inside. */
export function gradient(a) {
  const n = a.length, out = new Array(n);
  out[0] = a[1] - a[0];
  out[n - 1] = a[n - 1] - a[n - 2];
  for (let i = 1; i < n - 1; i++) out[i] = (a[i + 1] - a[i - 1]) / 2;
  return out;
}

/** `np.searchsorted(a, v)` (side "left"): first index whose value is >= v. */
export function searchsorted(a, v) {
  let lo = 0, hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < v) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** `a.sum()` the way numpy adds floats (pairwise, eight running sums per block), so rounding matches. */
export function npSum(a, start = 0, n = a.length - start) {
  if (n < 8) {
    let res = 0;
    for (let i = 0; i < n; i++) res += a[start + i];
    return res;
  }
  if (n <= 128) {
    const r = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => a[start + k]);
    let i = 8;
    for (; i < n - (n % 8); i += 8) for (let k = 0; k < 8; k++) r[k] += a[start + i + k];
    let res = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
    for (; i < n; i++) res += a[start + i];
    return res;
  }
  let half = n >> 1;
  half -= half % 8;
  return npSum(a, start, half) + npSum(a, start + half, n - half);
}

/** `a.mean()`. */
export const npMean = (a) => npSum(a) / a.length;
