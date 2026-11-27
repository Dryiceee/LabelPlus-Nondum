// Ruby (行间注) layout: where each note goes, how big, and what happens when
// it is longer than the characters it belongs to. Everything is in document
// pixels. "Main" is the reading direction (down in vertical text, right in
// horizontal text), "cross" the other one. A note sits to the right of a
// vertical line and above a horizontal one.
//
// A note:
//   { id, start, end,      characters [start, end) of the base text
//     text,                the note
//     align,               "center" | "start" | "spread" (room shared out
//                          between the note's characters)
//     distribute,          how "spread" shares the room: "121" (half a share
//                          at each end, a share between characters) or "010"
//                          (none at the ends: the note runs end to end)
//     overflow,            longer than its characters: "shrink" (smaller
//                          size), "squeeze" (narrower characters),
//                          "overhang" (as it is) or "spread" (the base
//                          characters are spaced out to its length)
//     size,                null (from ratio) or the size in px, set by hand;
//                          a size set by hand never shrinks
//     ratio,               size against the base characters
//     gap }                room between the line and the note, in base ems
//
// Lengths come from a measure(text, size, tracking, scale) callback: the
// editor estimates them, Apply measures the real note layer in Photoshop.

import { chars, isBlank, isLineBreak, isFullWidth, advance } from "./text";
import { lineGeometry } from "./measure";

export const ALIGNS = ["spread", "center", "start"];
export const DISTRIBUTES = ["121", "010"];
export const OVERFLOWS = ["shrink", "squeeze", "overhang", "spread"];
export const DEFAULTS = { align: "spread", distribute: "121", overflow: "shrink", ratio: 0.5, gap: 0 };
export const LIMITS = {
  ratio: [0.1, 2],
  gap: [-1, 4],
  size: [1, 5000],
  squeeze: 0.5, // narrowest "squeeze" (50 %)
  minSizeRatio: 0.15, // smallest "shrink", against the base size
  minSizePx: 3,
};
const EPS = 0.5;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value, fallback) => (typeof value === "number" && isFinite(value) ? value : fallback);

export function normalizeNote(raw, index = 0) {
  const source = raw && typeof raw === "object" ? raw : {};
  const start = Math.max(0, Math.trunc(finite(Number(source.start), 0)));
  const end = Math.max(start, Math.trunc(finite(Number(source.end), start)));
  const size = source.size === null || source.size === undefined || source.size === "" ? null : Number(source.size);
  return {
    id: source.id ? String(source.id) : "n" + index,
    start,
    end,
    text: typeof source.text === "string" ? source.text.replace(/[\r\n\u0003]+/g, "") : "",
    align: ALIGNS.indexOf(source.align) >= 0 ? source.align : DEFAULTS.align,
    distribute: DISTRIBUTES.indexOf(source.distribute) >= 0 ? source.distribute : DEFAULTS.distribute,
    overflow: OVERFLOWS.indexOf(source.overflow) >= 0 ? source.overflow : DEFAULTS.overflow,
    size: size !== null && isFinite(size) && size > 0 ? clamp(size, LIMITS.size[0], LIMITS.size[1]) : null,
    ratio: clamp(finite(Number(source.ratio), DEFAULTS.ratio), LIMITS.ratio[0], LIMITS.ratio[1]),
    gap: clamp(finite(Number(source.gap), DEFAULTS.gap), LIMITS.gap[0], LIMITS.gap[1]),
  };
}

// The base characters of a note, along the line:
//   { line, start, end, length, em, cross, first, last, prev }
// or { error: "empty" | "crossLine" | "outside" }.
// A full-width character takes one em around its glyph's centre (its glyph
// is smaller than that); a narrow one takes its glyph's own length.
export function spanGeometry(glyphs, lines, ems, vertical, start, end) {
  if (!(end > start)) return { error: "empty" };
  if (end > glyphs.length) return { error: "outside" };
  const inSpan = glyphs.slice(start, end);
  const inked = inSpan.filter((glyph) => glyph.box);
  if (!inked.length) return { error: "empty" };
  const line = inked[0].line;
  if (inked.some((glyph) => glyph.line !== line)) return { error: "crossLine" };
  if (inSpan.some((glyph, i) => isLineBreak(glyph.ch) && i < inSpan.length - 1)) return { error: "crossLine" };
  let mainStart = Infinity;
  let mainEnd = -Infinity;
  let em = 0;
  inked.forEach((glyph) => {
    const size = finite(ems[glyph.index], 0) || finite(ems[0], 0) || (vertical ? glyph.box.right - glyph.box.left : glyph.box.bottom - glyph.box.top);
    em = Math.max(em, size);
    const lo = vertical ? glyph.box.top : glyph.box.left;
    const hi = vertical ? glyph.box.bottom : glyph.box.right;
    if (isFullWidth(glyph.ch)) {
      const center = (lo + hi) / 2;
      mainStart = Math.min(mainStart, center - size / 2, lo);
      mainEnd = Math.max(mainEnd, center + size / 2, hi);
    } else {
      mainStart = Math.min(mainStart, lo);
      mainEnd = Math.max(mainEnd, hi);
    }
  });
  const first = inked[0].index;
  const last = inked[inked.length - 1].index;
  const before = first > 0 ? glyphs[first - 1] : null;
  const prev = before && before.line === line && !isLineBreak(before.ch) ? before.index : null;
  const lineEntry = lines[line];
  return { line, start: mainStart, end: mainEnd, length: mainEnd - mainStart, em, cross: lineEntry ? lineEntry.cross : null, first, last, prev };
}

// The editor's measure: advances from the character classes. A glyph's ink
// is a little shorter than its advance, at the line's far end.
export function estimateLength(text, size, tracking = 0, scale = 1) {
  const list = chars(text).filter((ch) => !isLineBreak(ch));
  if (!list.length) return 0;
  const total = list.reduce((sum, ch) => sum + advance(ch), 0);
  const ink = Math.max(0, total - 0.08 * advance(list[list.length - 1]));
  return ink * size * scale + Math.max(0, list.length - 1) * (tracking / 1000) * size;
}

export const noteLength = (text) => chars(text).filter((ch) => !isLineBreak(ch)).length;

// Size, spacing and scale of a note on its span:
//   { size, tracking, scale, length, baseExtra, overhang }
// tracking: Photoshop's, in 1/1000 em of the note; scale: 1 = 100 %;
// baseExtra: px the base characters must grow by ("spread" overflow).
export function planNote(span, note, measure) {
  const count = noteLength(note.text);
  const auto = note.size === null;
  const base = auto ? span.em * note.ratio : note.size;
  const minSize = Math.min(base, Math.max(LIMITS.minSizePx, span.em * LIMITS.minSizeRatio));
  const B = span.length;
  let size = base;
  let tracking = 0;
  let scale = 1;
  let L = measure(note.text, size, 0, 1);
  let baseExtra = 0;
  let overhang = false;
  if (L > B + EPS) {
    if (note.overflow === "shrink" && auto) {
      for (let i = 0; i < 3 && L > B + EPS && size > minSize; i++) {
        size = Math.max(minSize, size * (B / L));
        L = measure(note.text, size, 0, 1);
      }
    } else if (note.overflow === "squeeze") {
      scale = Math.max(LIMITS.squeeze, B / L);
      L = measure(note.text, size, 0, scale);
    } else if (note.overflow === "spread") {
      baseExtra = L - B;
    }
    overhang = baseExtra === 0 && L > B + EPS;
  } else if (note.align === "spread" && count > 1 && L > 0) {
    // Tracking goes between the note's characters; the note is centred, so
    // what is left over sits at its two ends. 1-2-1: B - L shared out as
    // 2 x count halves, one at each end. 0-1-0: all of it between them.
    const between = note.distribute === "010" ? (B - L) / (count - 1) : (B - L) / count;
    tracking = (between / size) * 1000;
    L = measure(note.text, size, tracking, 1);
  }
  return { size, tracking, scale, length: L, baseExtra, overhang };
}

// Where the note's ink goes: { main0, main1, cross, size } plus the box
// ({ left, top, right, bottom }), in document px
export function placeNote(span, plan, note, vertical) {
  const L = plan.length;
  const main0 = note.align === "start" ? span.start : (span.start + span.end) / 2 - L / 2;
  const offset = span.em / 2 + note.gap * span.em + plan.size / 2;
  const cross = vertical ? span.cross + offset : span.cross - offset;
  const half = plan.size / 2;
  const box = vertical
    ? { left: cross - half, right: cross + half, top: main0, bottom: main0 + L }
    : { left: main0, right: main0 + L, top: cross - half, bottom: cross + half };
  return { main0, main1: main0 + L, cross, size: plan.size, box };
}

// Base tracking that spaces the span's characters out by `extra` px: half a
// share before the first character (on the one before it), a share between
// characters, half a share after the last. [{ index, delta }], delta in
// 1/1000 em of that character.
export function spreadDeltas(span, extra, ems) {
  if (!(extra > 0)) return [];
  const n = span.last - span.first + 1;
  const share = extra / (2 * n);
  const em = (index) => finite(ems[index], 0) || span.em;
  const out = [];
  const push = (index, px) => out.push({ index, delta: (px / em(index)) * 1000 });
  if (span.prev !== null) push(span.prev, share);
  for (let i = span.first; i < span.last; i++) push(i, 2 * share);
  push(span.last, span.prev !== null ? share : 2 * share);
  return out;
}

// The room spreadDeltas puts around the characters, outside their own
// glyphs: half a share before (none at the start of a line, where it all
// goes after) and the rest after. The note centres on the characters with
// that room, so it lines up with what the tracking did.
export function spreadRoom(span, extra) {
  if (!(extra > 0)) return { lead: 0, trail: 0 };
  const share = extra / (2 * (span.last - span.first + 1));
  return span.prev !== null ? { lead: share, trail: share } : { lead: 0, trail: 2 * share };
}

export function widenSpan(span, room) {
  if (!room || (!room.lead && !room.trail)) return span;
  const start = span.start - room.lead;
  const end = span.end + room.trail;
  return Object.assign({}, span, { start, end, length: end - start });
}

export function mergeDeltas(lists) {
  const sums = {};
  lists.forEach((list) => (list || []).forEach(({ index, delta }) => {
    sums[index] = (sums[index] || 0) + delta;
  }));
  return Object.keys(sums).map(Number).sort((a, b) => a - b)
    .map((index) => ({ index, delta: sums[index] })).filter((entry) => Math.abs(entry.delta) > 1e-9);
}

// Notes of one line whose boxes run into each other: their ids
export function collisions(items) {
  const hit = new Set();
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      if (!a.rect || !b.rect || a.span.line !== b.span.line) continue;
      if (a.rect.main0 < b.rect.main1 - EPS && b.rect.main0 < a.rect.main1 - EPS) {
        hit.add(a.id);
        hit.add(b.id);
      }
    }
  }
  return hit;
}

// Notes whose characters overlap an earlier note's: their ids
export function overlaps(notes) {
  const taken = [];
  const hit = new Set();
  notes.forEach((note) => {
    if (taken.some((other) => note.start < other.end && other.start < note.end)) hit.add(note.id);
    else taken.push(note);
  });
  return hit;
}

// Room between lines. A note sits between its line and the line before it
// (right of a vertical line: the column before is to the right; above a
// horizontal line: the line before is above), so that line pair must be far
// enough apart for the note and a little air. The lines that must move away
// from the line before them:
//   [{ line, pitch, required, indices, before }]
// pitch: distance between the two lines' centres now, required: what the
// notes need; before: the characters of the line before. Which of the two
// lines holds that distance as its leading depends on the paragraph's
// leading type (see leadingTarget).
export const LINE_AIR = 0.15; // air beside a note, in note sizes

export function lineRoom(glyphs, ems, vertical, items) {
  const lines = lineGeometry(glyphs, vertical);
  const lineEm = lines.map((entry) => entry.indices.reduce((max, index) => (glyphs[index] && glyphs[index].box ? Math.max(max, finite(ems[index], 0)) : max), 0));
  const need = {};
  items.forEach((item) => {
    if (item.error || !item.span || !item.plan) return;
    const line = item.span.line;
    const before = lines[line - 1];
    if (!before || before.cross === null || lines[line].cross === null) return;
    const required = item.span.em / 2 + item.note.gap * item.span.em + item.plan.size * (1 + LINE_AIR) + lineEm[line - 1] / 2;
    need[line] = Math.max(need[line] || 0, required);
  });
  return Object.keys(need).map(Number).sort((a, b) => a - b).map((line) => {
    const pitch = Math.abs(lines[line].cross - lines[line - 1].cross);
    return pitch < need[line] - EPS ? { line, pitch, required: need[line], indices: lines[line].indices.slice(), before: lines[line - 1].indices.slice() } : null;
  }).filter(Boolean);
}

// The characters whose leading sets the distance between a line and the
// line before it. Photoshop 28, point text, probed 2026-11-27: a line's
// leading is its distance to the NEXT line, so it is the line before that
// changes, in vertical text with either leading type and in horizontal text
// with the default "leadingAbove". Only horizontal "leadingBelow" (Roman)
// counts it from the line before: there it is the line itself. The host
// measures again and flips every line if a Photoshop version differs.
export function leadingTarget(entry, leadingType, vertical) {
  return !vertical && leadingType === "leadingBelow" ? entry.indices : entry.before;
}

// Every note at once:
//   { items: [{ id, note, error, span, plan, rect }], baseDeltas, collisions, room }
export function layoutNotes({ glyphs, ems, vertical, notes, measure = estimateLength }) {
  const lines = lineGeometry(glyphs, vertical);
  const normalized = notes.map((note, i) => normalizeNote(note, i));
  const overlapping = overlaps(normalized);
  const items = normalized.map((note) => {
    if (overlapping.has(note.id)) return { id: note.id, note, error: "overlap" };
    if (!note.text.trim()) return { id: note.id, note, error: "noText" };
    const span = spanGeometry(glyphs, lines, ems, vertical, note.start, note.end);
    if (span.error) return { id: note.id, note, error: span.error };
    const plan = planNote(span, note, measure);
    return { id: note.id, note, error: null, span, plan, rect: placeNote(span, plan, note, vertical) };
  });
  const baseDeltas = mergeDeltas(items.filter((item) => !item.error && item.plan.baseExtra > 0)
    .map((item) => spreadDeltas(item.span, item.plan.baseExtra, ems)));
  return { items, baseDeltas, collisions: collisions(items.filter((item) => !item.error)), room: lineRoom(glyphs, ems, vertical, items) };
}

// The characters of a base text a note may cover, for the editor's picking:
// a run on one line, without the line break
export function clampSpan(glyphs, from, to) {
  let start = Math.min(from, to);
  let end = Math.max(from, to) + 1;
  start = Math.max(0, start);
  end = Math.min(glyphs.length, end);
  const line = glyphs[start] ? glyphs[start].line : 0;
  while (end > start + 1 && (glyphs[end - 1].line !== line || isLineBreak(glyphs[end - 1].ch))) end--;
  while (end > start + 1 && isBlank(glyphs[end - 1].ch)) end--;
  while (start < end - 1 && isBlank(glyphs[start].ch)) start++;
  return { start, end };
}

// Where the base characters will be after Apply, for the editor's preview:
// lines that make room move away from line 0 (left in vertical text, down
// in horizontal text), and spread tracking pushes the characters after it
// along their line. Each glyph gets its shifted box and its shift { dx, dy }.
export function predictBase(glyphs, ems, vertical, room, baseDeltas) {
  const extraAt = {};
  (room || []).forEach((entry) => { extraAt[entry.line] = (extraAt[entry.line] || 0) + Math.max(0, entry.required - entry.pitch); });
  const pushAt = {};
  (baseDeltas || []).forEach(({ index, delta }) => { pushAt[index] = (pushAt[index] || 0) + (delta / 1000) * (finite(ems[index], 0)); });
  let line = -1;
  let cross = 0;
  let main = 0;
  return glyphs.map((glyph) => {
    while (line < glyph.line) {
      line++;
      cross += extraAt[line] || 0;
      main = 0;
    }
    const dCross = vertical ? -cross : cross;
    const dx = vertical ? dCross : main;
    const dy = vertical ? main : dCross;
    main += pushAt[glyph.index] || 0;
    const box = glyph.box ? { left: glyph.box.left + dx, right: glyph.box.right + dx, top: glyph.box.top + dy, bottom: glyph.box.bottom + dy } : null;
    return Object.assign({}, glyph, { box, shift: { dx, dy } });
  });
}

// layoutNotes, then the notes placed on the base as Apply will leave it
// (the way the host does it: sizes from the base as it is, places from the
// base after the room and the spreading)
//   { items, baseDeltas, room, collisions, glyphs }  glyphs: predicted
export function predictLayout(args) {
  const first = layoutNotes(args);
  const { ems, vertical } = args;
  if (!first.room.length && !first.baseDeltas.length) return Object.assign({}, first, { glyphs: args.glyphs.map((glyph) => Object.assign({}, glyph, { shift: { dx: 0, dy: 0 } })) });
  const glyphs = predictBase(args.glyphs, ems, vertical, first.room, first.baseDeltas);
  const lines = lineGeometry(glyphs, vertical);
  const items = first.items.map((item) => {
    if (item.error) return item;
    const span = spanGeometry(glyphs, lines, ems, vertical, item.note.start, item.note.end);
    if (span.error) return item;
    const wide = widenSpan(span, spreadRoom(item.span, item.plan.baseExtra));
    return Object.assign({}, item, { rect: placeNote(wide, item.plan, item.note, vertical) });
  });
  return Object.assign({}, first, { items, glyphs, collisions: collisions(items.filter((item) => !item.error)) });
}
