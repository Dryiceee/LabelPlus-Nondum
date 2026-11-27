// Ruby (行间注): where each character of a text layer sits.
//
// Type > Create Work Path on a text layer gives one path component per
// glyph, in the order of the characters (holes are subpaths of the same
// component). Characters that draw nothing (spaces, line breaks) and the
// characters a box cuts off give none. So the Nth character that draws
// something is the Nth component. Checked on Photoshop 28 with horizontal,
// vertical, multi-line, rotated and mixed-size text (2026-11-27).
// Ligatures break the count (Calibri "ffi" is one component): the count is
// checked, and the host measures again with ligatures off.

import { parsePathContents, bounds, unitFactor, toSvgPath } from "../sfx/outline";
import { chars, isBlank, isLineBreak, utf16Offsets } from "./text";

// The box of each component, in document px
export function componentBoxes(pathContents, factor = 1) {
  return parsePathContents(pathContents, factor).map((component) => bounds([component], true));
}

// The outline of each component as SVG path data, in document px (the
// editor draws the base text from these, moved where Apply will put it)
export function componentPaths(pathContents, factor = 1) {
  return parsePathContents(pathContents, factor).map((component) => toSvgPath([component]));
}

function unionOf(boxes) {
  let box = null;
  boxes.forEach((b) => {
    if (!b) return;
    box = box ? { left: Math.min(box.left, b.left), top: Math.min(box.top, b.top), right: Math.max(box.right, b.right), bottom: Math.max(box.bottom, b.bottom) } : Object.assign({}, b);
  });
  return box;
}

// px per path unit: the candidate whose union of boxes best matches the
// layer's bounds (Photoshop versions differ in the unit they report)
export function pickFactor(rawBoxes, layerBounds, unit, resolution) {
  const res = Number(resolution) || 72;
  const fallback = unitFactor(unit, res);
  const union = unionOf(rawBoxes);
  if (!union || !layerBounds) return fallback;
  const candidates = [fallback, res / 72, 1, 72 / res].filter((value, index, list) => list.indexOf(value) === index);
  let best = fallback;
  let bestScore = Infinity;
  candidates.forEach((k) => {
    const score = Math.abs(union.left * k - layerBounds.left) + Math.abs(union.top * k - layerBounds.top) +
      Math.abs(union.right * k - layerBounds.right) + Math.abs(union.bottom * k - layerBounds.bottom);
    if (score < bestScore) {
      bestScore = score;
      best = k;
    }
  });
  return best;
}

// The characters of `text` with their line and their glyph box (null for
// characters that draw nothing). `boxes`: the work path's component boxes.
//   { ok: true, glyphs: [{ index, offset, ch, line, box }] }
//   { ok: false, code: "mismatch", inked, found }
export function mapGlyphs(text, boxes, paths) {
  const list = chars(text);
  const offsets = utf16Offsets(list);
  const glyphs = [];
  let line = 0;
  let next = 0;
  list.forEach((ch, index) => {
    const blank = isBlank(ch);
    const glyph = { index, offset: offsets[index], ch, line, box: blank ? null : (boxes[next] || null) };
    if (paths && !blank && paths[next]) glyph.path = paths[next];
    glyphs.push(glyph);
    if (!blank) next++;
    if (isLineBreak(ch)) line++;
  });
  const inked = next;
  // Fewer components than characters: a box cut the end off (those
  // characters have no box). More: a font split a glyph. A ligature merges
  // glyphs, which shows as too few as well: told apart by the caller.
  if (boxes.length > inked) return { ok: false, code: "mismatch", inked, found: boxes.length, glyphs };
  return { ok: boxes.length === inked, code: boxes.length === inked ? "" : "short", inked, found: boxes.length, glyphs };
}

// Lines of the text: the characters on each, and the line's centre across
// the reading direction (median of the glyph centres, so punctuation set
// off the centre line does not pull it)
export function lineGeometry(glyphs, vertical) {
  const lines = [];
  glyphs.forEach((glyph) => {
    if (!lines[glyph.line]) lines[glyph.line] = { line: glyph.line, indices: [], centers: [] };
    const entry = lines[glyph.line];
    entry.indices.push(glyph.index);
    if (glyph.box) entry.centers.push(vertical ? (glyph.box.left + glyph.box.right) / 2 : (glyph.box.top + glyph.box.bottom) / 2);
  });
  return lines.map((entry, line) => {
    if (!entry) return { line, indices: [], cross: null };
    const sorted = entry.centers.slice().sort((a, b) => a - b);
    const n = sorted.length;
    const cross = n ? (n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2) : null;
    return { line, indices: entry.indices, cross };
  });
}
