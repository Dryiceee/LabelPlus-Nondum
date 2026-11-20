// Photoshop's own glyph outlines -> em-sized outlines centred on 0,0.
//
// The host types each character alone into a copy of the source text layer
// and has Photoshop make a work path of it (Type > Create Work Path), so the
// outlines are the font's, with Photoshop's hinting of nothing and its holes.
// Every character sits in the same slot of the same layer, so a reference
// character (国, which fills its em square evenly) gives the centre of that
// slot for all of them, and the layer's transform is undone around it.

import { detectUnit, parsePathContents, bounds, transformComponents, invert, multiply, roundComponents, UNIT_DISTANCE, UNIT_PIXELS, unitFactor } from "./outline";

export const REFERENCE_CHAR = "国";

// px per descriptor unit: the candidate whose box matches the layer bounds
export function pickFactor(samples, unit, resolution) {
  const res = Number(resolution) || 72;
  const fallback = unitFactor(unit, res);
  const candidates = [fallback, res / 72, 1, 72 / res].filter((value, index, list) => list.indexOf(value) === index);
  let best = fallback;
  let bestScore = Infinity;
  candidates.forEach((factor) => {
    let score = 0;
    let used = 0;
    samples.forEach((sample) => {
      if (!sample.layerBounds || !sample.rawComponents || !sample.rawComponents.length) return;
      const box = bounds(sample.rawComponents, true);
      if (!box) return;
      const b = sample.layerBounds;
      score += Math.abs(box.left * factor - b.left) + Math.abs(box.top * factor - b.top) +
        Math.abs(box.right * factor - b.right) + Math.abs(box.bottom * factor - b.bottom);
      used++;
    });
    if (used && score < bestScore) {
      bestScore = score;
      best = factor;
    }
  });
  return best;
}

// The text layer's transform (textKey.transform), without its translation
export function linearTransform(transform) {
  if (!transform || typeof transform !== "object") return null;
  const value = (key, fallback) => {
    const v = Number(transform[key] && typeof transform[key] === "object" ? transform[key]._value : transform[key]);
    return isFinite(v) ? v : fallback;
  };
  const m = [value("xx", 1), value("xy", 0), value("yx", 0), value("yy", 1), 0, 0];
  const isIdentity = Math.abs(m[0] - 1) < 1e-9 && Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9 && Math.abs(m[3] - 1) < 1e-9;
  return isIdentity ? null : m;
}

function unionBox(list) {
  let box = null;
  list.forEach((components) => {
    const b = components && components.length ? bounds(components, true) : null;
    if (!b) return;
    box = box ? {
      left: Math.min(box.left, b.left), top: Math.min(box.top, b.top), right: Math.max(box.right, b.right), bottom: Math.max(box.bottom, b.bottom),
    } : Object.assign({}, b);
  });
  if (box) {
    box.width = box.right - box.left;
    box.height = box.bottom - box.top;
  }
  return box;
}

// samples: [{ ch, pathContents, layerBounds }], the reference among them
// (ch === REFERENCE_CHAR, flagged `reference`). sizePx: the text size in px.
export function normalizeGlyphs({ samples, resolution, transform, sizePx }) {
  const list = (samples || []).map((sample) => Object.assign({}, sample, { rawComponents: parsePathContents(sample.pathContents, 1) }));
  const firstWithPath = list.find((sample) => sample.pathContents);
  const unit = firstWithPath ? detectUnit(firstWithPath.pathContents) : UNIT_DISTANCE;
  const factor = pickFactor(list, unit, resolution);
  list.forEach((sample) => { sample.components = parsePathContents(sample.pathContents, factor); });

  const linear = linearTransform(transform);
  const det = linear ? linear[0] * linear[3] - linear[1] * linear[2] : 1;
  const s = Math.sqrt(Math.abs(det)) || 1;
  const undo = linear ? invert(linear) : null;

  // Centre of the slot: the reference's box, or all characters together
  const reference = list.find((sample) => sample.reference && sample.components.length);
  const centreBox = reference ? bounds(reference.components, true) : unionBox(list.map((sample) => sample.components));
  const cx = centreBox ? (centreBox.left + centreBox.right) / 2 : 0;
  const cy = centreBox ? (centreBox.top + centreBox.bottom) / 2 : 0;
  let m = [1, 0, 0, 1, -cx, -cy];
  if (undo) m = multiply([s, 0, 0, s, 0, 0], multiply(undo, m));

  const local = {};
  list.forEach((sample) => {
    if (!sample.reference || sample.alsoText) local[sample.ch] = roundComponents(transformComponents(sample.components, m), 3);
  });
  const referenceLocal = reference ? transformComponents(reference.components, m) : null;
  const referenceBox = referenceLocal ? bounds(referenceLocal, true) : null;

  // The em square: the text size; checked against the reference, as a
  // transformed or scaled layer may report its size either way
  let em = Number(sizePx) * s;
  const width = referenceBox ? referenceBox.width : 0;
  if (width > 0 && (!(em > 0) || width / em < 0.55 || width / em > 1.15)) em = width / 0.9;
  if (!(em > 0)) {
    const all = unionBox(Object.keys(local).map((ch) => local[ch]));
    em = all ? Math.max(all.width, all.height) / 0.9 : 100;
  }
  return {
    outlines: local,
    em,
    unit,
    factor,
    referenceWidth: width || null,
    unitCheck: list.filter((sample) => sample.layerBounds && sample.components.length).map((sample) => {
      const box = bounds(sample.components, true);
      return { ch: sample.ch, path: [box.left, box.top, box.right, box.bottom].map((v) => Math.round(v)), layer: [sample.layerBounds.left, sample.layerBounds.top, sample.layerBounds.right, sample.layerBounds.bottom] };
    }),
  };
}

// Outlines from another typing of the same font (a later edit): scaled so
// that their reference character matches the stored one
export function matchScale(outlines, referenceWidth, storedReferenceWidth) {
  if (!(referenceWidth > 0) || !(storedReferenceWidth > 0)) return outlines;
  const k = storedReferenceWidth / referenceWidth;
  if (Math.abs(k - 1) < 1e-4) return outlines;
  const result = {};
  Object.keys(outlines).forEach((ch) => { result[ch] = roundComponents(transformComponents(outlines[ch], [k, 0, 0, k, 0, 0]), 3); });
  return result;
}

export { UNIT_PIXELS };
