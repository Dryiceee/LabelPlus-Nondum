// SFX glyph outlines: Photoshop path descriptors <-> a compact form the
// editor draws and the layer XMP stores.
//
// A shape is a list of path components, as in Photoshop's Paths panel:
//   { op, paths: [{ closed, pts: [[ax, ay, bx, by, fx, fy, smooth], ...] }] }
// a = anchor, b = backward (incoming) handle, f = forward (outgoing) handle,
// all in document pixels. `op` is Photoshop's shapeOperation value, kept as
// read ("add", "subtract", "xor", "interfaceIconFrameDimmed"), so the holes of
// 回 or 器 come back exactly as Photoshop drew them.

// How a coordinate travels in Photoshop's descriptor. pathContents gives
// distanceUnit values: points at 72 dpi, so px = value * resolution / 72.
export const UNIT_DISTANCE = "distanceUnit";
export const UNIT_PIXELS = "pixelsUnit";
export const UNIT_RAW = "raw";

export function unitFactor(unit, resolution) {
  if (unit === UNIT_DISTANCE) return (Number(resolution) || 72) / 72;
  return 1;
}

const num = (value) => {
  if (value !== null && typeof value === "object" && "_value" in value) return Number(value._value);
  return Number(value);
};

const unitOf = (value) => (value !== null && typeof value === "object" && "_unit" in value ? String(value._unit) : UNIT_RAW);

function readPoint(point, factor) {
  if (!point) return null;
  const x = num(point.horizontal);
  const y = num(point.vertical);
  if (!isFinite(x) || !isFinite(y)) return null;
  return [x * factor, y * factor];
}

// The unit the descriptor uses, from its first coordinate
export function detectUnit(pathContents) {
  const components = (pathContents && pathContents.pathComponents) || [];
  for (const component of components) {
    for (const subpath of component.subpathListKey || []) {
      for (const point of subpath.points || []) {
        if (point && point.anchor) return unitOf(point.anchor.horizontal);
      }
    }
  }
  return UNIT_RAW;
}

const opValue = (op) => (op && typeof op === "object" ? String(op._value || "add") : String(op || "add"));

// Photoshop's pathContents -> components, in pixels (factor: px per unit)
export function parsePathContents(pathContents, factor = 1) {
  const result = [];
  const components = (pathContents && pathContents.pathComponents) || [];
  components.forEach((component) => {
    const paths = [];
    (component.subpathListKey || []).forEach((subpath) => {
      const pts = [];
      (subpath.points || []).forEach((point) => {
        const anchor = readPoint(point.anchor, factor);
        if (!anchor) return;
        const backward = readPoint(point.backward, factor) || anchor;
        const forward = readPoint(point.forward, factor) || anchor;
        pts.push([anchor[0], anchor[1], backward[0], backward[1], forward[0], forward[1], point.smooth ? 1 : 0]);
      });
      if (pts.length) paths.push({ closed: subpath.closedSubpath !== false, pts });
    });
    if (paths.length) result.push({ op: opValue(component.shapeOperation), paths });
  });
  return result;
}

function writeCoordinate(value, unit, factor) {
  const v = value / factor;
  return unit === UNIT_RAW ? v : { _unit: unit, _value: v };
}

function writePoint(x, y, unit, factor) {
  return { _obj: "paint", horizontal: writeCoordinate(x, unit, factor), vertical: writeCoordinate(y, unit, factor) };
}

// Components -> Photoshop's pathClass, in the unit Photoshop gave us
export function buildPathContents(components, unit = UNIT_DISTANCE, factor = 1) {
  return {
    _obj: "pathClass",
    pathComponents: components.map((component) => ({
      _obj: "pathComponent",
      shapeOperation: { _enum: "shapeOperation", _value: component.op || "add" },
      subpathListKey: component.paths.map((path) => ({
        _obj: "subpathsList",
        closedSubpath: path.closed !== false,
        points: path.pts.map((p) => ({
          _obj: "pathPoint",
          anchor: writePoint(p[0], p[1], unit, factor),
          forward: writePoint(p[4], p[5], unit, factor),
          backward: writePoint(p[2], p[3], unit, factor),
          smooth: !!p[6],
        })),
      })),
    })),
  };
}

// Affine matrix [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f
export const IDENTITY = [1, 0, 0, 1, 0, 0];

export function multiply(m, n) {
  // m after n
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det || !isFinite(det)) return null;
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

export function applyToPoint(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function transformComponents(components, m) {
  return components.map((component) => ({
    op: component.op,
    paths: component.paths.map((path) => ({
      closed: path.closed,
      pts: path.pts.map((p) => {
        const a = applyToPoint(m, p[0], p[1]);
        const b = applyToPoint(m, p[2], p[3]);
        const f = applyToPoint(m, p[4], p[5]);
        return [a[0], a[1], b[0], b[1], f[0], f[1], p[6]];
      }),
    })),
  }));
}

// Box of the anchors and handles (handles bound a Bézier curve)
export function bounds(components, anchorsOnly = false) {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  const add = (x, y) => {
    if (x < left) left = x;
    if (x > right) right = x;
    if (y < top) top = y;
    if (y > bottom) bottom = y;
  };
  (components || []).forEach((component) => component.paths.forEach((path) => path.pts.forEach((p) => {
    add(p[0], p[1]);
    if (!anchorsOnly) {
      add(p[2], p[3]);
      add(p[4], p[5]);
    }
  })));
  if (left === Infinity) return null;
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

export function countPoints(components) {
  let count = 0;
  (components || []).forEach((component) => component.paths.forEach((path) => { count += path.pts.length; }));
  return count;
}

const round = (value, digits) => {
  const k = Math.pow(10, digits);
  return Math.round(value * k) / k;
};

export function roundComponents(components, digits = 2) {
  return components.map((component) => ({
    op: component.op,
    paths: component.paths.map((path) => ({
      closed: path.closed,
      pts: path.pts.map((p) => [round(p[0], digits), round(p[1], digits), round(p[2], digits), round(p[3], digits), round(p[4], digits), round(p[5], digits), p[6] ? 1 : 0]),
    })),
  }));
}

const fmt = (value) => String(Math.round(value * 100) / 100);

// SVG path data: each subpath, in Photoshop's point order
export function toSvgPath(components) {
  const parts = [];
  (components || []).forEach((component) => component.paths.forEach((path) => {
    const pts = path.pts;
    if (!pts.length) return;
    parts.push("M" + fmt(pts[0][0]) + " " + fmt(pts[0][1]));
    const count = path.closed ? pts.length : pts.length - 1;
    for (let i = 0; i < count; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      parts.push("C" + fmt(p[4]) + " " + fmt(p[5]) + " " + fmt(q[2]) + " " + fmt(q[3]) + " " + fmt(q[0]) + " " + fmt(q[1]));
    }
    if (path.closed) parts.push("Z");
  }));
  return parts.join("");
}
