// Finds the bubble of a label on a raw page. Pure: the host reads the pixels.
//
// Raw pages still hold the original lettering, and the label point usually falls
// on it. Bubbles come in both polarities (black text on white, white on black).
// A plain flood or the magic wand fails on real pages: the point lands inside a
// stroke or the counter of a glyph, a white caption leaks through the white halo
// of a sound effect into the page margin, and a tail pulls the centre away.
//
// So only pixels at least CORE_RADIUS away from any other tone count: the "core"
// of each tone. Strokes, counters, outlines, tails and thin leaks have no core,
// while a bubble keeps one around its lettering. The nearest core of each tone
// is flooded and the shapes decide: a bubble holds the point in its box, is not
// small like a stroke, is not a large part of the page, and fills its box. When
// several qualify the smallest wins, because bubble interiors sit inside
// whatever surrounds them. Tails and double bubbles are for bubbleShape.js.

const LIGHT = 200;
const DARK = 55;
const GREY_TOLERANCE = 32;
const CORE_RADIUS = 4;
const MAX_PAGE_SHARE = 0.45;
const MIN_FILL = 0.3;
const MIN_SIDE = 40;
const SEARCH_RADIUS = 120;

// 8-bit interleaved pixels to one luma byte per pixel
function toLuma(bytes, components, width, height) {
  const luma = new Uint8Array(width * height);
  if (components < 3) {
    for (let i = 0; i < luma.length; i++) luma[i] = bytes[i * components];
    return luma;
  }
  for (let i = 0; i < luma.length; i++) {
    const at = i * components;
    luma[i] = (bytes[at] * 77 + bytes[at + 1] * 150 + bytes[at + 2] * 29) >> 8;
  }
  return luma;
}

function createPage(luma, width, height) {
  return { luma, width, height, marks: new Int32Array(width * height), generation: 0, tones: new Map() };
}

// City-block distance of each pixel of a tone to the nearest other pixel; the
// page edge does not count as another tone only for pixels on it (distance 1).
function distanceMap(page, low, high) {
  const { luma, width, height } = page;
  const key = low + ":" + high;
  if (page.tones.has(key)) return page.tones.get(key);
  const distance = new Uint8Array(width * height);
  for (let y = 0, at = 0; y < height; y++) {
    for (let x = 0; x < width; x++, at++) {
      if (luma[at] < low || luma[at] > high) continue;
      const left = x > 0 ? distance[at - 1] : 0;
      const up = y > 0 ? distance[at - width] : 0;
      distance[at] = Math.min(255, Math.min(left, up) + 1);
    }
  }
  for (let y = height - 1, at = width * height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--, at--) {
      if (!distance[at]) continue;
      const right = x < width - 1 ? distance[at + 1] : 0;
      const down = y < height - 1 ? distance[at + width] : 0;
      const next = Math.min(right, down) + 1;
      if (next < distance[at]) distance[at] = next;
    }
  }
  page.tones.set(key, distance);
  return distance;
}

// The closest pixel (growing square rings) passing the test, or null
function nearestPixel(page, x, y, radius, test) {
  const { width, height } = page;
  const cx = Math.round(x);
  const cy = Math.round(y);
  for (let r = 0; r <= radius; r++) {
    let best = null;
    let bestDistance = Infinity;
    const consider = (px, py) => {
      if (px < 0 || py < 0 || px >= width || py >= height) return;
      if (!test(py * width + px)) return;
      const distance = (px - cx) * (px - cx) + (py - cy) * (py - cy);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { x: px, y: py };
      }
    };
    for (let d = -r; d <= r; d++) {
      consider(cx + d, cy - r);
      consider(cx + d, cy + r);
      consider(cx - r, cy + d);
      consider(cx + r, cy + d);
    }
    if (best) return best;
  }
  return null;
}

// The core region around a seed, its box grown back by the radius
function floodCore(page, distance, seed, radius) {
  const { width, height, marks } = page;
  const generation = ++page.generation;
  const start = seed.y * width + seed.x;
  const stack = [start];
  marks[start] = generation;
  let pixels = 0;
  let left = seed.x;
  let right = seed.x;
  let top = seed.y;
  let bottom = seed.y;
  const visit = (next) => {
    if (marks[next] === generation || distance[next] < radius) return;
    marks[next] = generation;
    stack.push(next);
  };
  while (stack.length) {
    const at = stack.pop();
    pixels++;
    const py = (at / width) | 0;
    const px = at - py * width;
    if (px < left) left = px;
    if (px > right) right = px;
    if (py < top) top = py;
    if (py > bottom) bottom = py;
    if (px > 0) visit(at - 1);
    if (px < width - 1) visit(at + 1);
    if (py > 0) visit(at - width);
    if (py < height - 1) visit(at + width);
  }
  const grow = radius - 1;
  return {
    left: Math.max(0, left - grow),
    top: Math.max(0, top - grow),
    right: Math.min(width, right + 1 + grow),
    bottom: Math.min(height, bottom + 1 + grow),
    pixels,
    generation,
  };
}

function regionQualifies(region, point, page, minSide) {
  if (point.x < region.left - 1 || point.x > region.right + 1 || point.y < region.top - 1 || point.y > region.bottom + 1) return false;
  const w = region.right - region.left;
  const h = region.bottom - region.top;
  const area = w * h;
  if (Math.min(w, h) < minSide) return false;
  if (area > page.width * page.height * MAX_PAGE_SHARE) return false;
  return region.pixels / area >= MIN_FILL;
}

function regionOfTone(page, point, low, high, radius, minSide) {
  const distance = distanceMap(page, low, high);
  const seed = nearestPixel(page, point.x, point.y, radius, (at) => distance[at] >= CORE_RADIUS);
  if (!seed) return null;
  const region = floodCore(page, distance, seed, CORE_RADIUS);
  if (!regionQualifies(region, point, page, minSide)) return null;
  return Object.assign(region, {
    low,
    high,
    seedX: seed.x,
    seedY: seed.y,
    value: page.luma[seed.y * page.width + seed.x],
    area: (region.right - region.left) * (region.bottom - region.top),
    key: [low, region.left, region.top, region.right, region.bottom].join(","),
  });
}

// The bubble around `point`, or null. `fontPixels`, the size of the text, sets
// how small a region can be and still not be a stroke.
function findBubble(page, point, options = {}) {
  const radius = options.radius || SEARCH_RADIUS;
  const minSide = Math.max(MIN_SIDE, (options.fontPixels > 0 ? options.fontPixels : 0) * 2);
  const found = [
    regionOfTone(page, point, LIGHT, 255, radius, minSide),
    regionOfTone(page, point, 0, DARK, radius, minSide),
  ].filter(Boolean);
  if (!found.length) {
    // A grey bubble: the tone under the point, when it is neither light nor dark
    const px = Math.max(0, Math.min(page.width - 1, Math.round(point.x)));
    const py = Math.max(0, Math.min(page.height - 1, Math.round(point.y)));
    const value = page.luma[py * page.width + px];
    if (value > DARK && value < LIGHT) {
      const grey = regionOfTone(page, point, Math.max(0, value - GREY_TOLERANCE), Math.min(255, value + GREY_TOLERANCE), radius, minSide);
      if (grey) found.push(grey);
    }
  }
  return found.reduce((best, region) => (!best || region.area < best.area ? region : best), null);
}

// The tone pixel nearest to the point inside a box: a seed for a part of a bubble
function seedInBox(page, bubble, box, point) {
  const distance = distanceMap(page, bubble.low, bubble.high);
  const reach = Math.max(box.right - box.left, box.bottom - box.top);
  return nearestPixel(page, point.x, point.y, reach, (at) => {
    if (distance[at] < CORE_RADIUS) return false;
    const y = (at / page.width) | 0;
    const x = at - y * page.width;
    return x >= box.left && x < box.right && y >= box.top && y < box.bottom;
  });
}

export { toLuma, createPage, nearestPixel, findBubble, seedInBox };
