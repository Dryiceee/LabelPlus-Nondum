// SFX layout: the characters along a straight line, an arc or a hand-drawn
// path, each with its own offset, rotation and size. Everything is in
// document pixels, so the editor's zoom never touches the result.
//
// model.path:
//   { type: "line", p0, p1 }
//   { type: "arc", p0, p1, bend }       bend: signed sagitta, in px
//   { type: "free", pts: [[x, y], ...] } hand-drawn, smoothed
//   { type: "bezier", nodes: [{ p, i, o }] } anchors with in/out control
//       points (null on both sides of a segment = straight). Bending at a
//       selection turns any path into this, so the bend never loses the
//       shape around it
// Characters fill the path from end to end; the spacing is the path length
// against the characters' natural width (tracking, see trackingOf).

import { transformComponents, multiply, bounds as outlineBounds } from "./outline";

export const PATH_TYPES = ["line", "arc", "free", "bezier"];
const SAMPLES = 160;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value, fallback) => (typeof value === "number" && isFinite(value) ? value : fallback);
const pt = (p, fallback) => (Array.isArray(p) && isFinite(p[0]) && isFinite(p[1]) ? [Number(p[0]), Number(p[1])] : fallback);
const lerp = (a, b, t) => a + (b - a) * t;
const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

export function chars(text) {
  // Characters, not UTF-16 units: an extension-plane character is one glyph
  // Photoshop separates lines with \r (and \u0003 in some descriptors)
  return Array.from(String(text || "").replace(/[\r\n\t\u0003]/g, ""));
}

/* ----------------------------- paths ----------------------------- */

export function pathEnds(path) {
  if (path.type === "free") return [path.pts[0], path.pts[path.pts.length - 1]];
  if (path.type === "bezier") return [path.nodes[0].p, path.nodes[path.nodes.length - 1].p];
  return [path.p0, path.p1];
}

// The arc's circle, or null when it is (nearly) straight
export function arcGeometry(p0, p1, bend) {
  const chord = dist(p0, p1);
  if (chord < 1e-6 || Math.abs(bend) < 1e-3) return null;
  const ux = (p1[0] - p0[0]) / chord;
  const uy = (p1[1] - p0[1]) / chord;
  const nx = -uy;
  const ny = ux;
  const half = chord / 2;
  const mid = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
  const h = bend;
  const radius = (half * half + h * h) / (2 * Math.abs(h));
  const top = [mid[0] + nx * h, mid[1] + ny * h];
  const toCenter = h > 0 ? -1 : 1;
  const center = [top[0] + nx * radius * toCenter, top[1] + ny * radius * toCenter];
  const a0 = Math.atan2(p0[1] - center[1], p0[0] - center[0]);
  const sweepSize = 4 * Math.atan(Math.abs(h) / half);
  // The sweep direction that passes through the top of the arc
  const midAngle = (sweep) => a0 + sweep / 2;
  const at = (angle) => [center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)];
  const plus = at(midAngle(sweepSize));
  const minus = at(midAngle(-sweepSize));
  const sweep = dist(plus, top) <= dist(minus, top) ? sweepSize : -sweepSize;
  return { center, radius, a0, sweep, top };
}

// The path as a dense polyline
export function samplePath(path, samples = SAMPLES) {
  if (!path) return [];
  if (path.type === "free") return path.pts.map((p) => [p[0], p[1]]);
  if (path.type === "bezier") return flattenBezier(path).points;
  const p0 = path.p0;
  const p1 = path.p1;
  const arc = path.type === "arc" ? arcGeometry(p0, p1, path.bend || 0) : null;
  const points = [];
  if (!arc) {
    for (let i = 0; i <= 1; i++) points.push([lerp(p0[0], p1[0], i), lerp(p0[1], p1[1], i)]);
    return points;
  }
  for (let i = 0; i <= samples; i++) {
    const angle = arc.a0 + (arc.sweep * i) / samples;
    points.push([arc.center[0] + arc.radius * Math.cos(angle), arc.center[1] + arc.radius * Math.sin(angle)]);
  }
  // Exact ends, whatever the rounding of the circle
  points[0] = [p0[0], p0[1]];
  points[points.length - 1] = [p1[0], p1[1]];
  return points;
}

export function measure(points) {
  const lengths = [0];
  for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1] + dist(points[i - 1], points[i]));
  return { points, lengths, total: lengths[lengths.length - 1] || 0 };
}

// Point and direction at arc length u; past the ends the path goes on straight
export function pointAt(measured, u) {
  const { points, lengths, total } = measured;
  if (points.length === 0) return { x: 0, y: 0, angle: 0 };
  if (points.length === 1 || total <= 0) return { x: points[0][0], y: points[0][1], angle: 0 };
  let i = 1;
  if (u >= total) i = points.length - 1;
  else if (u > 0) {
    let lo = 1;
    let hi = points.length - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (lengths[m] < u) lo = m + 1;
      else hi = m;
    }
    i = lo;
  }
  // Skip zero-length segments for the direction
  let j = i;
  while (j > 1 && lengths[j] - lengths[j - 1] < 1e-9) j--;
  const a = points[j - 1];
  const b = points[j];
  const segment = lengths[j] - lengths[j - 1] || 1;
  const t = (u - lengths[j - 1]) / segment;
  return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, angle: Math.atan2(b[1] - a[1], b[0] - a[0]) };
}

export function pathLength(path) {
  return measure(samplePath(path)).total;
}

export function pathMidpoint(path) {
  const measured = measure(samplePath(path));
  const p = pointAt(measured, measured.total / 2);
  return [p.x, p.y];
}

// Every point of the path through f
export function mapPath(path, f) {
  if (path.type === "free") return Object.assign({}, path, { pts: path.pts.map((p) => f(p)) });
  if (path.type === "bezier") return { type: "bezier", nodes: path.nodes.map((n) => ({ p: f(n.p), i: n.i ? f(n.i) : null, o: n.o ? f(n.o) : null })) };
  return Object.assign({}, path, { p0: f(path.p0), p1: f(path.p1) });
}

export function translatePath(path, dx, dy) {
  return mapPath(path, (p) => [p[0] + dx, p[1] + dy]);
}

export function scalePath(path, k, center) {
  const c = center || pathMidpoint(path);
  const next = mapPath(path, (p) => [c[0] + (p[0] - c[0]) * k, c[1] + (p[1] - c[1]) * k]);
  if (next.type === "arc") next.bend = (path.bend || 0) * k;
  return next;
}

// Drag one end: the path turns and stretches around the other end
export function moveEnd(path, which, target) {
  const [start, end] = pathEnds(path);
  const fixed = which === 0 ? end : start;
  const moving = which === 0 ? start : end;
  const before = dist(fixed, moving);
  const after = dist(fixed, target);
  if (path.type === "line" || path.type === "arc") {
    const next = Object.assign({}, path);
    if (which === 0) next.p0 = [target[0], target[1]];
    else next.p1 = [target[0], target[1]];
    if (next.type === "arc" && before > 1e-6) next.bend = (path.bend || 0) * (after / before);
    return next;
  }
  if (before < 1e-6) return path;
  const k = after / before;
  const turn = Math.atan2(target[1] - fixed[1], target[0] - fixed[0]) - Math.atan2(moving[1] - fixed[1], moving[0] - fixed[0]);
  const cos = Math.cos(turn) * k;
  const sin = Math.sin(turn) * k;
  return mapPath(path, (p) => {
    const x = p[0] - fixed[0];
    const y = p[1] - fixed[1];
    return [fixed[0] + x * cos - y * sin, fixed[1] + x * sin + y * cos];
  });
}

// The middle handle: bends a line into an arc, or changes the arc's bend
export function bendTo(path, target) {
  if (path.type !== "line" && path.type !== "arc") return path;
  const chord = dist(path.p0, path.p1);
  if (chord < 1e-6) return path;
  const ux = (path.p1[0] - path.p0[0]) / chord;
  const uy = (path.p1[1] - path.p0[1]) / chord;
  const mid = [(path.p0[0] + path.p1[0]) / 2, (path.p0[1] + path.p1[1]) / 2];
  const bend = (target[0] - mid[0]) * -uy + (target[1] - mid[1]) * ux;
  return Object.assign({}, path, { type: "arc", bend });
}

// Where the middle handle sits
export function bendHandle(path) {
  if (path.type !== "line" && path.type !== "arc") return pathMidpoint(path);
  const arc = path.type === "arc" ? arcGeometry(path.p0, path.p1, path.bend || 0) : null;
  if (arc) return arc.top;
  return [(path.p0[0] + path.p1[0]) / 2, (path.p0[1] + path.p1[1]) / 2];
}

// Switch the path type, keeping its ends
export function convertPath(path, type) {
  if (path.type === type) return path;
  const [p0, p1] = pathEnds(path);
  if (type === "line") return { type: "line", p0: [p0[0], p0[1]], p1: [p1[0], p1[1]] };
  if (type === "arc") {
    const chord = dist(p0, p1);
    const bend = path.type === "free" ? 0 : (path.bend || 0);
    return { type: "arc", p0: [p0[0], p0[1]], p1: [p1[0], p1[1]], bend: Math.abs(bend) > 1e-3 ? bend : -chord * 0.2 };
  }
  // A free path starts as the current shape, then gets redrawn by hand
  return { type: "free", pts: samplePath(path, 48) };
}

/* --------------------------- Bézier paths -------------------------- */

const lerpP = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const copyP = (p) => (p ? [p[0], p[1]] : null);
const cloneNode = (n) => ({ p: copyP(n.p), i: copyP(n.i), o: copyP(n.o) });

// The four points of segment k (a missing control point sits a third of
// the way along: a straight segment, evenly paced)
function segmentControls(nodes, k) {
  const a = nodes[k];
  const b = nodes[k + 1];
  return [a.p, a.o || lerpP(a.p, b.p, 1 / 3), b.i || lerpP(a.p, b.p, 2 / 3), b.p];
}
const isStraight = (nodes, k) => !nodes[k].o && !nodes[k + 1].i;

function cubicBasis(t) {
  const u = 1 - t;
  return [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
}

function cubicPoint(c, t) {
  const b = cubicBasis(t);
  return [b[0] * c[0][0] + b[1] * c[1][0] + b[2] * c[2][0] + b[3] * c[3][0], b[0] * c[0][1] + b[1] * c[1][1] + b[2] * c[2][1] + b[3] * c[3][1]];
}

// de Casteljau: the same curve as two segments
function splitCubic(c, t) {
  const p01 = lerpP(c[0], c[1], t);
  const p12 = lerpP(c[1], c[2], t);
  const p23 = lerpP(c[2], c[3], t);
  const a = lerpP(p01, p12, t);
  const b = lerpP(p12, p23, t);
  const m = lerpP(a, b, t);
  return [[c[0], p01, a, m], [m, b, p23, c[3]]];
}

// The path as a dense polyline, with each point's segment and t, and the
// index of each anchor in it
function flattenBezier(path) {
  const nodes = path.nodes;
  const points = [copyP(nodes[0].p)];
  const seg = [0];
  const ts = [0];
  const nodeAt = [0];
  for (let k = 0; k < nodes.length - 1; k++) {
    const c = segmentControls(nodes, k);
    let n = 1;
    if (!isStraight(nodes, k)) n = clamp(Math.ceil((dist(c[0], c[1]) + dist(c[1], c[2]) + dist(c[2], c[3])) / 2), 8, 200);
    for (let j = 1; j <= n; j++) {
      points.push(j === n ? copyP(c[3]) : cubicPoint(c, j / n));
      seg.push(k);
      ts.push(j / n);
    }
    nodeAt.push(points.length - 1);
  }
  return { points, seg, ts, nodeAt };
}

// Segment and t at arc length u
function locate(flat, measured, u) {
  const lengths = measured.lengths;
  let j = 1;
  while (j < lengths.length - 1 && lengths[j] < u) j++;
  const k = flat.seg[j];
  const t0 = flat.seg[j - 1] === k ? flat.ts[j - 1] : 0;
  const piece = lengths[j] - lengths[j - 1];
  const f = piece > 0 ? clamp((u - lengths[j - 1]) / piece, 0, 1) : 0;
  return { k, t: t0 + (flat.ts[j] - t0) * f };
}

// Any path as Bézier anchors, the same shape
export function toBezier(path) {
  if (path.type === "bezier") return { type: "bezier", nodes: path.nodes.map(cloneNode) };
  if (path.type === "free") return { type: "bezier", nodes: path.pts.map((p) => ({ p: copyP(p), i: null, o: null })) };
  const arc = path.type === "arc" ? arcGeometry(path.p0, path.p1, path.bend || 0) : null;
  if (!arc) return { type: "bezier", nodes: [{ p: copyP(path.p0), i: null, o: null }, { p: copyP(path.p1), i: null, o: null }] };
  // At most a quarter circle per segment
  const pieces = Math.max(1, Math.ceil(Math.abs(arc.sweep) / (Math.PI / 2) - 1e-9));
  const step = arc.sweep / pieces;
  const h = (4 / 3) * Math.tan(step / 4) * arc.radius;
  const nodes = [];
  for (let j = 0; j <= pieces; j++) {
    const a = arc.a0 + step * j;
    const p = [arc.center[0] + arc.radius * Math.cos(a), arc.center[1] + arc.radius * Math.sin(a)];
    const t = [-Math.sin(a) * h, Math.cos(a) * h];
    nodes.push({ p, i: j > 0 ? [p[0] - t[0], p[1] - t[1]] : null, o: j < pieces ? [p[0] + t[0], p[1] + t[1]] : null });
  }
  nodes[0].p = copyP(path.p0);
  nodes[nodes.length - 1].p = copyP(path.p1);
  return { type: "bezier", nodes };
}

// A new anchor at arc length u, the curve unchanged; an anchor already
// there is used as it is. Returns the path and the anchor's index
export function splitBezierAt(path, u) {
  const flat = flattenBezier(path);
  const measured = measure(flat.points);
  const last = path.nodes.length - 1;
  for (let k = 0; k <= last; k++) if (Math.abs(measured.lengths[flat.nodeAt[k]] - u) < 0.05) return { path, index: k };
  if (u <= 0) return { path, index: 0 };
  if (u >= measured.total) return { path, index: last };
  const { k, t } = locate(flat, measured, u);
  const nodes = path.nodes.map(cloneNode);
  const straight = isStraight(nodes, k);
  const [left, right] = splitCubic(segmentControls(nodes, k), t);
  if (!straight) {
    nodes[k].o = left[1];
    nodes[k + 1].i = right[2];
  }
  nodes.splice(k + 1, 0, { p: left[3], i: straight ? null : left[2], o: straight ? null : right[1] });
  return { path: { type: "bezier", nodes }, index: k + 1 };
}

// Part of the path, from arc length `from` to `to`, curved so its middle
// moves by `delta`: anchors are set at both ends and stay; what lies between
// moves most in the middle and not at all at the ends, so any shape it had
// is kept, bent. Returns the path and that part's length before and after
export function bulgePath(path, from, to, delta) {
  const a = splitBezierAt(toBezier(path), from);
  const b = splitBezierAt(a.path, to);
  const bez = b.path;
  const i0 = a.index;
  const i1 = b.index;
  if (i1 <= i0) return { path: bez, before: 0, after: 0 };
  const nodes = bez.nodes;
  // Control points of their own, so they can move
  for (let k = i0; k < i1; k++) {
    const c = segmentControls(nodes, k);
    nodes[k].o = copyP(c[1]);
    nodes[k + 1].i = copyP(c[2]);
  }
  const flat = flattenBezier(bez);
  const measured = measure(flat.points);
  const at = flat.nodeAt.map((j) => measured.lengths[j]);
  const span = at[i1] - at[i0];
  if (!(span > 1e-6)) return { path: bez, before: 0, after: 0 };
  const w = (len) => {
    const t = clamp((len - at[i0]) / span, 0, 1);
    return 4 * t * (1 - t);
  };
  const wP = (k) => (k <= i0 || k >= i1 ? 0 : w(at[k]));
  const wO = (k) => w(at[k] + (at[k + 1] - at[k]) / 3);
  const wI = (k) => w(at[k - 1] + ((at[k] - at[k - 1]) * 2) / 3);
  // Scaled so the curve's middle moves by exactly delta
  const mid = locate(flat, measured, (at[i0] + at[i1]) / 2);
  const basis = cubicBasis(mid.t);
  const c = basis[0] * wP(mid.k) + basis[1] * wO(mid.k) + basis[2] * wI(mid.k + 1) + basis[3] * wP(mid.k + 1);
  const s = c > 0.05 ? 1 / c : 1;
  const move = (p, weight) => [p[0] + delta[0] * s * weight, p[1] + delta[1] * s * weight];
  const moved = nodes.map(cloneNode);
  for (let k = i0; k <= i1; k++) {
    if (k > i0 && k < i1) moved[k].p = move(nodes[k].p, wP(k));
    if (k < i1) moved[k].o = move(nodes[k].o, wO(k));
    if (k > i0) moved[k].i = move(nodes[k].i, wI(k));
  }
  const next = { type: "bezier", nodes: moved };
  const after = flattenBezier(next);
  const afterMeasured = measure(after.points);
  return { path: next, before: span, after: afterMeasured.lengths[after.nodeAt[i1]] - afterMeasured.lengths[after.nodeAt[i0]] };
}

// The middle handle on a Bézier or hand-drawn path: the whole path bends,
// its ends fixed
export function bendWhole(path, delta) {
  return bulgePath(path, 0, pathLength(path), delta).path;
}

// Anchors worth showing: the corners and bends a Bézier path has gained
// (none for a hand-drawn line's hundreds of points)
export function pathAnchors(path, max = 40) {
  if (path.type !== "bezier" || path.nodes.length > max) return [];
  return path.nodes.slice(1, -1).map((n, i) => ({ index: i + 1, p: copyP(n.p) }));
}

/* -------------------------- hand drawing -------------------------- */

// Hand-drawn points -> a smooth path: drop jitter, round the corners
// (Chaikin), and keep it light enough for the layer metadata
export function smoothStroke(points, minStep = 2, iterations = 2, maxPoints = 240) {
  const input = (points || []).filter((p) => Array.isArray(p) && isFinite(p[0]) && isFinite(p[1]));
  if (input.length < 2) return input.map((p) => [p[0], p[1]]);
  let pts = [input[0]];
  for (let i = 1; i < input.length; i++) if (dist(pts[pts.length - 1], input[i]) >= minStep) pts.push(input[i]);
  if (pts.length < 2) pts.push(input[input.length - 1]);
  const first = pts[0];
  const last = input[input.length - 1];
  pts[pts.length - 1] = last;
  for (let n = 0; n < iterations && pts.length > 2; n++) {
    const next = [first];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      next.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]]);
      next.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    next.push(last);
    pts = next;
  }
  if (pts.length > maxPoints) {
    const step = (pts.length - 1) / (maxPoints - 1);
    const reduced = [];
    for (let i = 0; i < maxPoints; i++) reduced.push(pts[Math.round(i * step)]);
    pts = reduced;
  }
  return pts.map((p) => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100]);
}

/* ----------------------------- model ------------------------------ */

export const LIMITS = {
  scale: [0.05, 20],
  endScale: [0.1, 5],
  glyphScale: [0.05, 20],
  glyphSpace: [0.02, 50],
  rotation: [-360, 360],
  tracking: [-90, 500],
};

// dx, dy: offset from its spot on the path; rot, scale: its own turn and
// size; space: how much room it takes on the path (bending the path at a
// selection stretches the selected characters' room)
export function defaultGlyph() {
  return { dx: 0, dy: 0, rot: 0, scale: 1, space: 1 };
}

function normalizePath(raw, fallback) {
  if (!raw || typeof raw !== "object") return fallback;
  if (raw.type === "free") {
    const pts = Array.isArray(raw.pts) ? raw.pts.map((p) => pt(p, null)).filter(Boolean) : [];
    return pts.length >= 2 ? { type: "free", pts } : fallback;
  }
  if (raw.type === "bezier") {
    const nodes = Array.isArray(raw.nodes) ? raw.nodes.map((n) => {
      const p = n && typeof n === "object" ? pt(n.p, null) : null;
      return p ? { p, i: pt(n.i, null), o: pt(n.o, null) } : null;
    }).filter(Boolean) : [];
    if (nodes.length < 2) return fallback;
    nodes[0].i = null;
    nodes[nodes.length - 1].o = null;
    return { type: "bezier", nodes };
  }
  const p0 = pt(raw.p0, null);
  const p1 = pt(raw.p1, null);
  if (!p0 || !p1) return fallback;
  if (raw.type === "arc") return { type: "arc", p0, p1, bend: finite(raw.bend, 0) };
  return { type: "line", p0, p1 };
}

// A model read from a file or the editor: every value checked
export function normalizeModel(raw, fallback = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const em = finite(source.em, finite(fallback.em, 100));
  const text = typeof source.text === "string" ? source.text : String(fallback.text || "");
  const list = chars(text);
  const color = source.color && typeof source.color === "object" ? source.color : fallback.color || { r: 0, g: 0, b: 0 };
  const glyphsIn = Array.isArray(source.glyphs) ? source.glyphs : [];
  const glyphs = list.map((ch, i) => {
    const g = glyphsIn[i] && typeof glyphsIn[i] === "object" ? glyphsIn[i] : {};
    return {
      dx: finite(g.dx, 0),
      dy: finite(g.dy, 0),
      rot: clamp(finite(g.rot, 0), LIMITS.rotation[0], LIMITS.rotation[1]),
      scale: clamp(finite(g.scale, 1), LIMITS.glyphScale[0], LIMITS.glyphScale[1]),
      space: clamp(finite(g.space, 1), LIMITS.glyphSpace[0], LIMITS.glyphSpace[1]),
    };
  });
  const fallbackPath = { type: "line", p0: [0, 0], p1: [em * Math.max(1, list.length), 0] };
  return {
    text,
    em,
    color: {
      r: clamp(Math.round(finite(Number(color.r), 0)), 0, 255),
      g: clamp(Math.round(finite(Number(color.g), 0)), 0, 255),
      b: clamp(Math.round(finite(Number(color.b), 0)), 0, 255),
    },
    path: normalizePath(source.path, normalizePath(fallback.path, fallbackPath)),
    scale: clamp(finite(source.scale, 1), LIMITS.scale[0], LIMITS.scale[1]),
    startScale: clamp(finite(source.startScale, 1), LIMITS.endScale[0], LIMITS.endScale[1]),
    endScale: clamp(finite(source.endScale, 1), LIMITS.endScale[0], LIMITS.endScale[1]),
    rotation: clamp(finite(source.rotation, 0), LIMITS.rotation[0], LIMITS.rotation[1]),
    upright: !!source.upright,
    glyphs,
  };
}

// The first model of a text layer: a straight path through the layer's
// centre, along the text's direction, as long as the text itself
export function initialModel({ text, em, color, box, vertical }) {
  const list = chars(text);
  const length = em * Math.max(1, list.length);
  const cx = box ? (box.left + box.right) / 2 : length / 2;
  const cy = box ? (box.top + box.bottom) / 2 : em / 2;
  const half = length / 2;
  const path = vertical
    ? { type: "line", p0: [cx, cy - half], p1: [cx, cy + half] }
    : { type: "line", p0: [cx - half, cy], p1: [cx + half, cy] };
  return normalizeModel({ text, em, color, path, upright: !!vertical });
}

// Text changed: keep the settings of the characters still in place
export function withText(model, text) {
  const before = chars(model.text);
  const after = chars(text);
  const glyphs = after.map((ch, i) => (before[i] === ch && model.glyphs[i] ? model.glyphs[i] : defaultGlyph()));
  return Object.assign({}, model, { text, glyphs });
}

/* ----------------------------- layout ----------------------------- */

// Each character's room on the path, in px. A character's own size (its
// glyph.scale) is left out: resizing one character never pushes the others
// along, as with Photoshop's Direct Selection
function glyphSizes(model, withSpace = true) {
  const list = chars(model.text);
  const n = list.length;
  return list.map((ch, i) => {
    const t = n > 1 ? i / (n - 1) : 0.5;
    const glyph = model.glyphs[i];
    const space = withSpace && glyph && isFinite(glyph.space) ? glyph.space : 1;
    return model.em * model.scale * lerp(model.startScale, model.endScale, t) * space;
  });
}

export function naturalLength(model) {
  return glyphSizes(model).reduce((sum, size) => sum + size, 0);
}

// Spacing, in % of the natural width: 0 = characters side by side
export function trackingOf(model) {
  const natural = naturalLength(model);
  if (natural <= 0) return 0;
  return (pathLength(model.path) / natural - 1) * 100;
}

// New spacing: the path grows or shrinks around its middle
export function withTracking(model, tracking) {
  const natural = naturalLength(model);
  const current = pathLength(model.path);
  const value = clamp(tracking, LIMITS.tracking[0], LIMITS.tracking[1]);
  if (natural <= 0 || current <= 1e-6) return model;
  const k = (natural * (1 + value / 100)) / current;
  return Object.assign({}, model, { path: scalePath(model.path, k) });
}

// Where each character goes: centre, direction (radians) and size
export function layoutGlyphs(model) {
  const list = chars(model.text);
  const sizes = glyphSizes(model);
  const measured = measure(samplePath(model.path));
  const total = sizes.reduce((sum, size) => sum + size, 0);
  const k = total > 0 ? measured.total / total : 0;
  let run = 0;
  return list.map((ch, i) => {
    const glyph = model.glyphs[i] || defaultGlyph();
    const room = sizes[i];
    const size = model.em * model.scale * lerp(model.startScale, model.endScale, list.length > 1 ? i / (list.length - 1) : 0.5) * glyph.scale;
    const u = list.length === 1 ? measured.total / 2 : (run + room / 2) * k;
    run += room;
    const at = pointAt(measured, u);
    const along = model.upright ? 0 : at.angle;
    const angle = along + ((model.rotation + glyph.rot) * Math.PI) / 180;
    return { index: i, ch, x: at.x + glyph.dx, y: at.y + glyph.dy, angle, size, pathX: at.x, pathY: at.y, pathAngle: along };
  });
}

// Glyph outline (em-sized, centred on 0,0) -> document
export function glyphMatrix(placement, em) {
  const k = em > 0 ? placement.size / em : 1;
  const cos = Math.cos(placement.angle) * k;
  const sin = Math.sin(placement.angle) * k;
  return [cos, sin, -sin, cos, placement.x, placement.y];
}

// The whole SFX, as one shape in document pixels
export function composeShape(model, outlines, base = null) {
  const components = [];
  layoutGlyphs(model).forEach((placement) => {
    const outline = outlines && outlines[placement.ch];
    if (!outline || !outline.length) return;
    let m = glyphMatrix(placement, model.em);
    if (base) m = multiply(base, m);
    transformComponents(outline, m).forEach((component) => components.push(component));
  });
  return components;
}

// Box of one placed character (its em square), for hit tests and handles
export function glyphBox(placement, outline, em) {
  const box = outline && outline.length ? outlineBounds(outline, true) : null;
  const half = em / 2;
  const local = box || { left: -half, top: -half, right: half, bottom: half };
  return local;
}

/* --------------------------- selections --------------------------- */

const wrapDegrees = (deg) => {
  const d = ((deg + 180) % 360 + 360) % 360 - 180;
  return d === -180 ? 180 : d;
};

// Centre of some characters: the middle of their centres' box
export function selectionCenter(model, indices) {
  const placed = layoutGlyphs(model);
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  indices.forEach((i) => {
    const p = placed[i];
    if (!p) return;
    left = Math.min(left, p.x); right = Math.max(right, p.x);
    top = Math.min(top, p.y); bottom = Math.max(bottom, p.y);
  });
  return left === Infinity ? null : [(left + right) / 2, (top + bottom) / 2];
}

// Move, turn (degrees) and resize some characters together, around `center`
// (their common centre by default): each keeps its place in the group.
// keepSize: the characters spread or close up (k) without changing size
export function transformSelection(model, indices, { dx = 0, dy = 0, angle = 0, k = 1, center = null, keepSize = false } = {}) {
  const list = indices.filter((i) => i >= 0 && i < model.glyphs.length);
  if (!list.length) return model;
  const placed = layoutGlyphs(model);
  const c = center || selectionCenter(model, list);
  const cos = Math.cos((angle * Math.PI) / 180);
  const sin = Math.sin((angle * Math.PI) / 180);
  const glyphs = model.glyphs.slice();
  list.forEach((i) => {
    const p = placed[i];
    const g = glyphs[i] || defaultGlyph();
    const rx = p.x - c[0];
    const ry = p.y - c[1];
    const nx = c[0] + k * (rx * cos - ry * sin) + dx;
    const ny = c[1] + k * (rx * sin + ry * cos) + dy;
    glyphs[i] = Object.assign({}, g, {
      dx: g.dx + nx - p.x,
      dy: g.dy + ny - p.y,
      rot: wrapDegrees(g.rot + angle),
      scale: keepSize ? g.scale : clamp(g.scale * k, LIMITS.glyphScale[0], LIMITS.glyphScale[1]),
    });
  });
  return Object.assign({}, model, { glyphs });
}

// Some characters' settings, the others left alone
export function updateGlyphs(model, indices, fn) {
  const glyphs = model.glyphs.slice();
  indices.forEach((i) => {
    if (i >= 0 && i < glyphs.length) glyphs[i] = Object.assign({}, glyphs[i], fn(glyphs[i], i));
  });
  return Object.assign({}, model, { glyphs });
}

export function removeGlyphs(model, indices) {
  const drop = {};
  indices.forEach((i) => { drop[i] = true; });
  const list = chars(model.text);
  return Object.assign({}, model, {
    text: list.filter((ch, i) => !drop[i]).join(""),
    glyphs: model.glyphs.filter((g, i) => !drop[i]),
  });
}

// Every adjustment undone: the text in a straight line around `center`,
// characters side by side (vertical: top to bottom, upright)
export function resetLayout(model, { center = null, vertical = false } = {}) {
  const c = center || pathMidpoint(model.path);
  const half = (model.em * Math.max(1, chars(model.text).length)) / 2;
  const path = vertical
    ? { type: "line", p0: [c[0], c[1] - half], p1: [c[0], c[1] + half] }
    : { type: "line", p0: [c[0] - half, c[1]], p1: [c[0] + half, c[1]] };
  return normalizeModel({ text: model.text, em: model.em, color: model.color, path, upright: !!vertical });
}

// Each of some characters turned in place by `angle` degrees
export function turnEach(model, indices, angle) {
  return updateGlyphs(model, indices, (g) => ({ rot: wrapDegrees(g.rot + angle) }));
}

// Some characters growing (factor > 1) or shrinking toward one end of the
// selection: the far character keeps its size, the near one gets `factor`
export function rampSize(model, indices, factor, towardEnd) {
  const list = indices.slice().sort((a, b) => a - b);
  const n = list.length;
  return updateGlyphs(model, list, (g, i) => {
    const rank = list.indexOf(i);
    const t = n > 1 ? (towardEnd ? rank / (n - 1) : 1 - rank / (n - 1)) : 1;
    return { scale: clamp(g.scale * lerp(1, factor, t), LIMITS.glyphScale[0], LIMITS.glyphScale[1]) };
  });
}

// Where some characters sit on the path: from the start of the first
// selected one to the end of the last (arc lengths), and their range
export function selectionStretch(model, indices) {
  const list = chars(model.text);
  const sorted = indices.filter((i) => i >= 0 && i < list.length).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const rooms = glyphSizes(model);
  const total = rooms.reduce((sum, r) => sum + r, 0);
  const length = pathLength(model.path);
  if (!(total > 0) || !(length > 0)) return null;
  const sumTo = (n) => rooms.slice(0, n).reduce((sum, r) => sum + r, 0);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  return { first, last, from: (sumTo(first) * length) / total, to: (sumTo(last + 1) * length) / total, length, total };
}

// Some characters' room scaled by k (clamped)
function scaleRoom(model, first, last, k) {
  const glyphs = model.glyphs.map((g, i) => (i >= first && i <= last ? Object.assign({}, g, { space: clamp((g.space || 1) * k, LIMITS.glyphSpace[0], LIMITS.glyphSpace[1]) }) : g));
  return Object.assign({}, model, { glyphs });
}

// An end square dragged while characters are selected: an anchor goes in
// where the selection starts, and the stretch from there to that end turns
// and stretches as one piece around it, so its far end follows `target`
// (whatever shape it had is kept). The characters before the anchor stay
// exactly where they were; the selected ones (and any between them and that
// end) ride along, their room scaled with the stretch.
// end 1 drags the last end, end 0 the first.
export function bendAtSelection(model, indices, end, target) {
  const s = selectionStretch(model, indices);
  if (!s) return model;
  const cutAt = end === 1 ? s.from : s.to;
  const split = splitBezierAt(toBezier(model.path), cutAt);
  const index = split.index;
  let nodes = split.path.nodes.map(cloneNode);
  const pivot = copyP(nodes[index].p);
  const far = end === 1 ? nodes[nodes.length - 1].p : nodes[0].p;
  const before = dist(pivot, far);
  const after = dist(pivot, target);
  let k;
  if (before > 1e-6) {
    k = clamp(after / before, LIMITS.glyphSpace[0], LIMITS.glyphSpace[1]);
    const turn = Math.atan2(target[1] - pivot[1], target[0] - pivot[0]) - Math.atan2(far[1] - pivot[1], far[0] - pivot[0]);
    const cos = Math.cos(turn) * k;
    const sin = Math.sin(turn) * k;
    const f = (p) => {
      if (!p) return null;
      const x = p[0] - pivot[0];
      const y = p[1] - pivot[1];
      return [pivot[0] + x * cos - y * sin, pivot[1] + x * sin + y * cos];
    };
    nodes.forEach((n, j) => {
      if (end === 1 ? j > index : j < index) {
        n.p = f(n.p);
        n.i = f(n.i);
        n.o = f(n.o);
      } else if (j === index) {
        if (end === 1) n.o = f(n.o);
        else n.i = f(n.i);
      }
    });
  } else {
    // That stretch had no length: a straight run to the pointer
    const moving = end === 1 ? s.length - s.from : s.to;
    k = clamp(after / Math.max(1e-6, moving), LIMITS.glyphSpace[0], LIMITS.glyphSpace[1]);
    const tip = { p: [target[0], target[1]], i: null, o: null };
    if (end === 1) {
      nodes = nodes.slice(0, index + 1).concat([tip]);
      nodes[index].o = null;
    } else {
      nodes = [tip].concat(nodes.slice(index));
      nodes[1].i = null;
    }
  }
  // The stretch is k times as long, so its characters take k times the room:
  // the same px per room unit as before, and the rest does not move
  const first = end === 1 ? s.first : 0;
  const last = end === 1 ? chars(model.text).length - 1 : s.last;
  return Object.assign(scaleRoom(model, first, last, k), { path: { type: "bezier", nodes } });
}

// The handle that bends just the selected characters' stretch: its middle
export function stretchHandle(model, indices) {
  const s = selectionStretch(model, indices);
  if (!s || s.last <= s.first) return null;
  const p = pointAt(measure(samplePath(model.path)), (s.from + s.to) / 2);
  return [p.x, p.y];
}

// Just the selected characters' stretch bends, its middle moved by `delta`;
// the characters outside it stay exactly where they were, the ones in it
// take the stretch's new length
export function bendStretch(model, indices, delta) {
  const s = selectionStretch(model, indices);
  if (!s || s.to - s.from < 1e-6) return model;
  const bent = bulgePath(model.path, s.from, s.to, delta);
  const k = bent.before > 1e-6 ? bent.after / bent.before : 1;
  return Object.assign(scaleRoom(model, s.first, s.last, k), { path: bent.path });
}

/* ------------------------ anchors and handles ------------------------ */

// Arc length of each anchor
function anchorLengths(path) {
  const flat = flattenBezier(path);
  const measured = measure(flat.points);
  return flat.nodeAt.map((j) => measured.lengths[j]);
}

// A Bézier path reshaped by hand (same anchors, some moved): the characters
// beyond each changed segment stay where they were, the ones on it take its
// new length. A segment with no character centred on it hands its change to
// the character whose room covers its middle.
export function reshapePath(model, path) {
  const before = toBezier(model.path);
  if (path.type !== "bezier" || path.nodes.length !== before.nodes.length) return Object.assign({}, model, { path });
  const atOld = anchorLengths(before);
  const atNew = anchorLengths(path);
  const rooms = glyphSizes(model);
  const total = rooms.reduce((sum, r) => sum + r, 0);
  const length = atOld[atOld.length - 1];
  if (!(total > 0) || !(length > 0)) return Object.assign({}, model, { path });
  const perRoom = length / total;
  const starts = [];
  let run = 0;
  rooms.forEach((r) => { starts.push(run * perRoom); run += r; });
  const factor = rooms.map(() => 1);
  for (let s = 0; s < atOld.length - 1; s++) {
    const change = (atNew[s + 1] - atNew[s]) - (atOld[s + 1] - atOld[s]);
    if (Math.abs(change) < 1e-9) continue;
    let set = rooms.map((r, i) => i).filter((i) => {
      const centre = starts[i] + (rooms[i] * perRoom) / 2;
      return centre >= atOld[s] && centre < atOld[s + 1];
    });
    if (!set.length) {
      const middle = (atOld[s] + atOld[s + 1]) / 2;
      set = rooms.map((r, i) => i).filter((i) => middle >= starts[i] && middle <= starts[i] + rooms[i] * perRoom).slice(0, 1);
    }
    const room = set.reduce((sum, i) => sum + rooms[i] * perRoom, 0);
    if (!(room > 0)) continue;
    const f = Math.max(0.01, 1 + change / room);
    set.forEach((i) => { factor[i] *= f; });
  }
  const glyphs = model.glyphs.map((g, i) => (factor[i] === 1 ? g : Object.assign({}, g, { space: clamp((g.space || 1) * factor[i], LIMITS.glyphSpace[0], LIMITS.glyphSpace[1]) })));
  return Object.assign({}, model, { path, glyphs });
}

// A control point where it would be drawn: its own, or a third of the way
// along a straight segment
export function handlePoint(path, index, side) {
  const nodes = path.nodes;
  if (side === "o") return index < nodes.length - 1 ? segmentControls(nodes, index)[1] : null;
  return index > 0 ? segmentControls(nodes, index - 1)[2] : null;
}

// Both handles of an anchor in one line: a smooth anchor
function isSmooth(node) {
  if (!node.i || !node.o) return false;
  const a = Math.atan2(node.p[1] - node.i[1], node.p[0] - node.i[0]);
  const b = Math.atan2(node.o[1] - node.p[1], node.o[0] - node.p[0]);
  const d = Math.abs(((b - a + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
  return d < 0.06;
}

// Drag one control point (side "i" or "o" of anchor `index`) to `target`.
// A smooth anchor's other handle turns with it, keeping its length, unless
// `independent` (Alt, as in Photoshop)
export function moveHandle(model, index, side, target, independent = false) {
  const path = toBezier(model.path);
  const nodes = path.nodes;
  const node = nodes[index];
  if (!node || (side === "o" && index >= nodes.length - 1) || (side === "i" && index <= 0)) return model;
  const smooth = !independent && isSmooth(node);
  // A straight segment's other control point gets a place of its own too,
  // so only this one moves
  if (side === "o" && !nodes[index + 1].i) nodes[index + 1].i = handlePoint(path, index + 1, "i");
  if (side === "i" && !nodes[index - 1].o) nodes[index - 1].o = handlePoint(path, index - 1, "o");
  node[side] = [target[0], target[1]];
  if (smooth) {
    const other = side === "o" ? "i" : "o";
    const keep = dist(node.p, node[other]);
    const away = dist(node.p, target);
    if (away > 1e-6) node[other] = [node.p[0] - ((target[0] - node.p[0]) / away) * keep, node.p[1] - ((target[1] - node.p[1]) / away) * keep];
  }
  return reshapePath(model, path);
}

// Drag an anchor: its handles go with it
export function moveAnchor(model, index, target) {
  const path = toBezier(model.path);
  const node = path.nodes[index];
  if (!node) return model;
  const dx = target[0] - node.p[0];
  const dy = target[1] - node.p[1];
  const shift = (p) => (p ? [p[0] + dx, p[1] + dy] : null);
  // A missing handle stays missing: that segment stays straight
  path.nodes[index] = { p: [target[0], target[1]], i: shift(node.i), o: shift(node.o) };
  return reshapePath(model, path);
}

// The segments whose handles to show: those touching the picked anchor, and
// those of the selected characters' stretch when anchors bound it
export function handleSegments(model, anchor, indices) {
  if (model.path.type !== "bezier" || model.path.nodes.length > 40) return [];
  const count = model.path.nodes.length - 1;
  const out = {};
  if (anchor !== null && anchor !== undefined && anchor >= 0 && anchor <= count) {
    if (anchor > 0) out[anchor - 1] = true;
    if (anchor < count) out[anchor] = true;
  }
  const s = indices && indices.length ? selectionStretch(model, indices) : null;
  if (s) {
    const at = anchorLengths(model.path);
    const near = (u) => at.findIndex((a) => Math.abs(a - u) < 0.5);
    const i0 = near(s.from);
    const i1 = near(s.to);
    if (i0 >= 0 && i1 > i0 && i1 - i0 <= 4) for (let k = i0; k < i1; k++) out[k] = true;
  }
  return Object.keys(out).map(Number).sort((a, b) => a - b);
}
