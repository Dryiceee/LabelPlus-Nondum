// What TypeR's Align does with a wand selection, done on the shape the finder
// read from the page: the same opening cuts tails and spikes, and the same
// chamber engine (oneClick/alignPlan.js) splits a double bubble. Pure.

import { planAlignment } from "../oneClick/alignPlan";
import { nearestPixel, seedInBox } from "./bubbleFinder";

// Same values as _getAdaptiveSelectionOpenRadius in the hosts
const OPEN_RATIO = 0.1;
const MIN_OPEN_RADIUS = 4;
const BODY_RATIO = 0.5;
const MIN_OPENED_AREA = 200;
const OUTLINE_TOLERANCE = 1.5;
const SMOOTH_RADIUS = 3;
const SPLIT_STEP = 2;
const MAX_SPLIT_RADIUS = 80;
const MIN_CHAMBER_SHARE = 0.06;
// Whitening, TypeR's Auto clean values: the fill stops short of the outline,
// further on black bubbles, and tiny or page-sized areas are left alone
const CLEAN_INSET_LIGHT = 3;
const CLEAN_INSET_DARK = 5;
const CLEAN_MIN_SIDE = 24;
const CLEAN_MAX_PAGE_SHARE = 0.7;
const CLEAN_EDGE_MARGIN = 2;
// What the fill covers besides the tone must be lettering: strokes, thin
// everywhere. Anything thicker is another bubble or a picture inside the area
// (a panel background or a black panel taken for the bubble), and is kept.
const CLEAN_MAX_STROKE = 12;
const CLEAN_STROKE_PER_FONT = 0.6;
// A plain bubble: most of its tone is near white (or black). Screentone, a
// gradient or a grey bubble would show a flat patch.
const CLEAN_LIGHT_MEDIAN = 235;
const CLEAN_LIGHT_LOW = 215;
const CLEAN_DARK_MEDIAN = 30;
const CLEAN_DARK_HIGH = 45;

// The bubble's silhouette in its box: the tone connected to the seed, plus what
// the outside cannot reach. Filled lettering, as TypeR fills the text's holes.
function silhouette(page, bubble) {
  const w = bubble.right - bubble.left;
  const h = bubble.bottom - bubble.top;
  const state = new Uint8Array(w * h); // 1: bubble, 2: outside
  const flood = (stack, value, passes) => {
    while (stack.length) {
      const at = stack.pop();
      const y = (at / w) | 0;
      const x = at - y * w;
      const visit = (next) => {
        if (state[next] || !passes(next)) return;
        state[next] = value;
        stack.push(next);
      };
      if (x > 0) visit(at - 1);
      if (x < w - 1) visit(at + 1);
      if (y > 0) visit(at - w);
      if (y < h - 1) visit(at + w);
    }
  };
  const isTone = (at) => {
    const value = page.luma[(((at / w) | 0) + bubble.top) * page.width + at % w + bubble.left];
    return value >= bubble.low && value <= bubble.high;
  };
  const seed = (bubble.seedY - bubble.top) * w + bubble.seedX - bubble.left;
  state[seed] = 1;
  flood([seed], 1, isTone);
  const border = [];
  for (let at = 0; at < w * h; at++) {
    const y = (at / w) | 0;
    const x = at - y * w;
    if ((x === 0 || y === 0 || x === w - 1 || y === h - 1) && !state[at]) {
      state[at] = 2;
      border.push(at);
    }
  }
  flood(border, 2, () => true);
  return { w, h, filled: (x, y) => x >= 0 && y >= 0 && x < w && y < h && state[y * w + x] !== 2, state };
}

// City-block distance to the outside of the silhouette
function insideDistance({ w, h, state }) {
  const distance = new Uint16Array(w * h);
  for (let y = 0, at = 0; y < h; y++) {
    for (let x = 0; x < w; x++, at++) {
      if (state[at] === 2) continue;
      distance[at] = Math.min(x > 0 ? distance[at - 1] : 0, y > 0 ? distance[at - w] : 0) + 1;
    }
  }
  for (let y = h - 1, at = w * h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--, at--) {
      if (!distance[at]) continue;
      distance[at] = Math.min(distance[at], Math.min(x < w - 1 ? distance[at + 1] : 0, y < h - 1 ? distance[at + w] : 0) + 1);
    }
  }
  return distance;
}

// The box to centre on: the bubble opened, which removes tails and spikes. Falls back on the bubble's own box, like TypeR.
function openedBox(page, bubble, point) {
  const shape = silhouette(page, bubble);
  const { w, h } = shape;
  const shortest = Math.min(w, h);
  const own = { left: bubble.left, top: bubble.top, right: bubble.right, bottom: bubble.bottom };
  const distance = insideDistance(shape);
  // A tenth of the box is what TypeR uses, but a white strip beside a flash bubble
  // widens the box without being part of the body: half of the body's own
  // half-width removes it, and leaves a plain bubble's box as it is.
  let peak = 0;
  for (let at = 0; at < w * h; at++) if (distance[at] > peak) peak = distance[at];
  const radius = Math.min(Math.max(MIN_OPEN_RADIUS, Math.round(shortest * OPEN_RATIO), Math.round(peak * BODY_RATIO)), Math.floor(shortest / 2 - 1));
  if (radius <= 0) return own;
  // The core part nearest to the label: a spike cut off stays out
  const px = Math.round(point.x) - bubble.left;
  const py = Math.round(point.y) - bubble.top;
  let start = -1;
  let best = Infinity;
  for (let y = 0, at = 0; y < h; y++) {
    for (let x = 0; x < w; x++, at++) {
      if (distance[at] < radius) continue;
      const gap = (x - px) * (x - px) + (y - py) * (y - py);
      if (gap < best) {
        best = gap;
        start = at;
      }
    }
  }
  if (start < 0) return own;
  const seen = new Uint8Array(w * h);
  const stack = [start];
  seen[start] = 1;
  let left = w;
  let top = h;
  let right = 0;
  let bottom = 0;
  while (stack.length) {
    const at = stack.pop();
    const y = (at / w) | 0;
    const x = at - y * w;
    if (x < left) left = x;
    if (y < top) top = y;
    if (x >= right) right = x + 1;
    if (y >= bottom) bottom = y + 1;
    const visit = (next) => {
      if (seen[next] || distance[next] < radius) return;
      seen[next] = 1;
      stack.push(next);
    };
    if (x > 0) visit(at - 1);
    if (x < w - 1) visit(at + 1);
    if (y > 0) visit(at - w);
    if (y < h - 1) visit(at + w);
  }
  const grow = radius - 1;
  const box = {
    left: Math.max(bubble.left, bubble.left + left - grow),
    top: Math.max(bubble.top, bubble.top + top - grow),
    right: Math.min(bubble.right, bubble.left + right + grow),
    bottom: Math.min(bubble.bottom, bubble.top + bottom + grow),
  };
  const area = (box.right - box.left) * (box.bottom - box.top);
  const holdsPoint = point.x >= box.left - 1 && point.x <= box.right + 1 && point.y >= box.top - 1 && point.y <= box.bottom + 1;
  return area >= MIN_OPENED_AREA && holdsPoint ? box : own;
}

// Walks the silhouette's edge, clockwise, along the pixel cracks
function traceOutline({ w, h, filled }) {
  let startX = -1;
  let startY = -1;
  for (let y = 0; y < h && startX < 0; y++) {
    for (let x = 0; x < w; x++) {
      if (filled(x, y)) {
        startX = x;
        startY = y;
        break;
      }
    }
  }
  if (startX < 0) return [];
  const STEP = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  const points = [];
  let x = startX;
  let y = startY;
  let dir = 0;
  const limit = (w + 1) * (h + 1) * 4;
  for (let i = 0; i < limit; i++) {
    const frontLeft = [filled(x, y - 1), filled(x, y), filled(x - 1, y), filled(x - 1, y - 1)][dir];
    const frontRight = [filled(x, y), filled(x - 1, y), filled(x - 1, y - 1), filled(x, y - 1)][dir];
    const before = dir;
    if (frontLeft) dir = (dir + 3) % 4;
    else if (!frontRight) dir = (dir + 1) % 4;
    if (i > 0 && x === startX && y === startY && dir === 0) break;
    if (dir !== before) points.push([x, y]);
    x += STEP[dir][0];
    y += STEP[dir][1];
  }
  return points;
}

// Ramer-Douglas-Peucker on a closed contour
function simplify(points, tolerance) {
  if (points.length < 8) return points;
  let far = 0;
  let farGap = -1;
  points.forEach((point, index) => {
    const gap = (point[0] - points[0][0]) ** 2 + (point[1] - points[0][1]) ** 2;
    if (gap > farGap) {
      farGap = gap;
      far = index;
    }
  });
  const section = (from, to) => {
    const keep = [];
    const stack = [[from, to]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const [ax, ay] = points[a];
      const [bx, by] = points[b];
      const length = Math.hypot(bx - ax, by - ay) || 1;
      let worst = -1;
      let worstGap = tolerance;
      for (let i = a + 1; i < b; i++) {
        const gap = Math.abs((bx - ax) * (ay - points[i][1]) - (ax - points[i][0]) * (by - ay)) / length;
        if (gap > worstGap) {
          worstGap = gap;
          worst = i;
        }
      }
      if (worst >= 0) {
        keep.push(worst);
        stack.push([a, worst], [worst, b]);
      }
    }
    return keep;
  };
  const closed = points.concat([points[0]]);
  const original = points;
  points = closed;
  const kept = [0, far].concat(section(0, far), section(far, closed.length - 1)).sort((a, b) => a - b);
  points = original;
  return kept.map((index) => closed[index]);
}

// The silhouette without the dither that touches it: white specks of a screen
// tone would otherwise fray the outline into thousands of points. Photoshop's
// own path (tolerance 2) smooths the same way.
function smoothShape(shape, bubble) {
  const { w, h } = shape;
  const distance = insideDistance(shape);
  const near = new Uint8Array(w * h);
  for (let y = 0, at = 0; y < h; y++) {
    for (let x = 0; x < w; x++, at++) {
      if (distance[at] < SMOOTH_RADIUS) continue;
      for (let dy = -(SMOOTH_RADIUS - 1); dy < SMOOTH_RADIUS; dy++) {
        const span = SMOOTH_RADIUS - 1 - Math.abs(dy);
        for (let dx = -span; dx <= span; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h) near[ny * w + nx] = 1;
        }
      }
    }
  }
  const state = new Uint8Array(w * h);
  const seed = (bubble.seedY - bubble.top) * w + bubble.seedX - bubble.left;
  const stack = near[seed] ? [seed] : [];
  if (near[seed]) state[seed] = 1;
  while (stack.length) {
    const at = stack.pop();
    const y = (at / w) | 0;
    const x = at - y * w;
    const visit = (next) => {
      if (state[next] || !near[next]) return;
      state[next] = 1;
      stack.push(next);
    };
    if (x > 0) visit(at - 1);
    if (x < w - 1) visit(at + 1);
    if (y > 0) visit(at - w);
    if (y < h - 1) visit(at + w);
  }
  return { w, h, filled: (x, y) => x >= 0 && y >= 0 && x < w && y < h && state[y * w + x] === 1 };
}

// The outline in the form Photoshop's work path has, in page pixels
function outlinePath(page, bubble) {
  const contour = simplify(traceOutline(smoothShape(silhouette(page, bubble), bubble)), OUTLINE_TOLERANCE);
  const coordinate = (point) => ({
    horizontal: { _unit: "pixelsUnit", _value: point[0] + bubble.left },
    vertical: { _unit: "pixelsUnit", _value: point[1] + bubble.top },
  });
  return {
    pathContents: {
      pathComponents: [{
        subpathListKey: [{
          closedSubpath: true,
          points: contour.map((point) => ({ anchor: coordinate(point), forward: coordinate(point), backward: coordinate(point) })),
        }],
      }],
    },
  };
}

// Several labels in one outline: TypeR's chambers, one box per point in order,
// or null when the outline is a single bubble. Manga reads right to left.
function chamberBoxes(page, bubble, points, resolution) {
  const texts = points.map((point, index) => ({
    id: index + 1,
    index,
    box: { left: point.x - 1, top: point.y - 1, right: point.x + 1, bottom: point.y + 1 },
  }));
  const plan = planAlignment({
    documentId: 1,
    width: page.width,
    height: page.height,
    resolution: resolution || 72,
    texts,
    bubbles: [{
      selectionBounds: { left: bubble.left, top: bubble.top, right: bubble.right, bottom: bubble.bottom },
      rawPath: outlinePath(page, bubble),
      textIds: texts.map((text) => text.id),
    }],
  }, "rtl");
  if (plan.length !== points.length) return null;
  return points.map((point, index) => plan.find((entry) => entry.id === index + 1).rect);
}

// For outlines TypeR's engine does not read as a double bubble, typically two
// bubbles touching through a gap: shrinks the silhouette until the labels fall
// into parts of a real size, then treats each part as a bubble of its own. Null
// when the labels stay together: they share one chamber.
function splitBubble(page, bubble, points) {
  const shape = silhouette(page, bubble);
  const { w, h } = shape;
  const distance = insideDistance(shape);
  let area = 0;
  for (let at = 0; at < w * h; at++) if (distance[at]) area++;
  const local = { width: w, height: h };
  const marks = new Int32Array(w * h);
  for (let radius = SPLIT_STEP; radius <= MAX_SPLIT_RADIUS; radius += SPLIT_STEP) {
    const seeds = points.map((point) => nearestPixel(local, point.x - bubble.left, point.y - bubble.top, Math.max(w, h), (at) => distance[at] >= radius));
    if (seeds.some((seed) => !seed)) return null;
    marks.fill(0);
    const parts = [];
    for (let i = 0; i < seeds.length; i++) {
      const start = seeds[i].y * w + seeds[i].x;
      if (marks[start]) break;
      const stack = [start];
      marks[start] = i + 1;
      const part = { pixels: 0, left: w, top: h, right: 0, bottom: 0 };
      while (stack.length) {
        const at = stack.pop();
        const y = (at / w) | 0;
        const x = at - y * w;
        part.pixels++;
        part.left = Math.min(part.left, x);
        part.top = Math.min(part.top, y);
        part.right = Math.max(part.right, x + 1);
        part.bottom = Math.max(part.bottom, y + 1);
        const visit = (next) => {
          if (marks[next] || distance[next] < radius) return;
          marks[next] = i + 1;
          stack.push(next);
        };
        if (x > 0) visit(at - 1);
        if (x < w - 1) visit(at + 1);
        if (y > 0) visit(at - w);
        if (y < h - 1) visit(at + w);
      }
      parts.push(part);
    }
    if (parts.length === seeds.length && parts.every((part) => part.pixels >= area * MIN_CHAMBER_SHARE)) {
      return parts.map((part, index) => {
        const box = {
          left: Math.max(bubble.left, bubble.left + part.left - radius + 1),
          top: Math.max(bubble.top, bubble.top + part.top - radius + 1),
          right: Math.min(bubble.right, bubble.left + part.right + radius - 1),
          bottom: Math.min(bubble.bottom, bubble.top + part.bottom + radius - 1),
        };
        const seed = seedInBox(page, bubble, box, points[index]);
        if (!seed) return box;
        return openedBox(page, Object.assign({}, bubble, box, { seedX: seed.x, seedY: seed.y }), points[index]);
      });
    }
  }
  return null;
}

// Where each label of one outline goes, or null when they share one chamber
function placeShared(page, bubble, points, resolution) {
  let boxes = null;
  try {
    boxes = chamberBoxes(page, bubble, points, resolution);
  } catch (unreadable) {
    boxes = null;
  }
  return boxes || splitBubble(page, bubble, points);
}

// The value under which a share of the counted values lies
const percentile = (histogram, count, share) => {
  let seen = 0;
  for (let value = 0; value < histogram.length; value++) {
    seen += histogram[value];
    if (seen > count * share) return value;
  }
  return histogram.length - 1;
};

// The bubble's own colour (each channel's median over its tone, lettering
// left out) and whether the bubble is plain enough to be filled flat.
// page.rgb (bytes, page.components per pixel) gives the colour; without it the
// grey of the luma is used.
function bubbleTone(page, bubble, shape) {
  const { w, h, state } = shape;
  const channels = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  const luma = new Uint32Array(256);
  const components = page.components || 3;
  let count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (state[y * w + x] !== 1) continue;
      const at = (y + bubble.top) * page.width + x + bubble.left;
      luma[page.luma[at]]++;
      for (let c = 0; c < 3; c++) channels[c][page.rgb ? page.rgb[at * components + c] : page.luma[at]]++;
      count++;
    }
  }
  if (!count) return null;
  const median = percentile(luma, count, 0.5);
  const light = bubble.low >= 200;
  const dark = bubble.high <= 55;
  const plain = light
    ? median >= CLEAN_LIGHT_MEDIAN && percentile(luma, count, 0.1) >= CLEAN_LIGHT_LOW
    : dark && median <= CLEAN_DARK_MEDIAN && percentile(luma, count, 0.9) <= CLEAN_DARK_HIGH;
  return {
    plain,
    dark,
    color: { red: percentile(channels[0], count, 0.5), green: percentile(channels[1], count, 0.5), blue: percentile(channels[2], count, 0.5) },
  };
}

// How far the thickest of the filled holes reaches from the tone around it
function thickestHole({ w, h, state }) {
  const distance = new Uint16Array(w * h);
  let thickest = 0;
  for (let y = 0, at = 0; y < h; y++) {
    for (let x = 0; x < w; x++, at++) {
      if (state[at] !== 0) continue;
      distance[at] = Math.min(x > 0 ? distance[at - 1] : 0, y > 0 ? distance[at - w] : 0) + 1;
    }
  }
  for (let y = h - 1, at = w * h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--, at--) {
      if (!distance[at]) continue;
      distance[at] = Math.min(distance[at], Math.min(x < w - 1 ? distance[at + 1] : 0, y < h - 1 ? distance[at + w] : 0) + 1);
      if (distance[at] > thickest) thickest = distance[at];
    }
  }
  return thickest;
}

// Whitening (涂白) of a bubble: the polygon to fill, in page pixels, with the
// lettering it holds, the inset to contract it by and the colour; or
// { skip: code } when the bubble is better left alone.
function cleanOutline(page, bubble, options = {}) {
  const shape = silhouette(page, bubble);
  const tone = bubbleTone(page, bubble, shape);
  if (!tone || !tone.plain) return { skip: "cleanTone" };
  const stroke = Math.max(CLEAN_MAX_STROKE, Math.round((options.fontPixels > 0 ? options.fontPixels : 0) * CLEAN_STROKE_PER_FONT));
  if (thickestHole(shape) > stroke) return { skip: "cleanNested" };
  const contour = simplify(traceOutline(smoothShape(shape, bubble)), OUTLINE_TOLERANCE);
  if (contour.length < 3) return { skip: "cleanSmall" };
  const polygon = contour.map((point) => [point[0] + bubble.left, point[1] + bubble.top]);
  const xs = polygon.map((point) => point[0]);
  const ys = polygon.map((point) => point[1]);
  const box = { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
  if (box.right - box.left < CLEAN_MIN_SIDE || box.bottom - box.top < CLEAN_MIN_SIDE) return { skip: "cleanSmall" };
  const edges = (box.left <= CLEAN_EDGE_MARGIN ? 1 : 0) + (box.top <= CLEAN_EDGE_MARGIN ? 1 : 0) +
    (box.right >= page.width - CLEAN_EDGE_MARGIN ? 1 : 0) + (box.bottom >= page.height - CLEAN_EDGE_MARGIN ? 1 : 0);
  let filled = 0;
  for (let at = 0; at < shape.state.length; at++) if (shape.state[at] !== 2) filled++;
  if (edges >= 3 || filled >= page.width * page.height * CLEAN_MAX_PAGE_SHARE) return { skip: "cleanLarge" };
  return { polygon, inset: tone.dark ? CLEAN_INSET_DARK : CLEAN_INSET_LIGHT, color: tone.color, box };
}

export { openedBox, outlinePath, chamberBoxes, splitBubble, placeShared, cleanOutline };
