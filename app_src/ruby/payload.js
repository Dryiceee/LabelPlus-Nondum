// Ruby (行间注): what a note layer carries in its XMP metadata, so a saved
// PSD opens again in the editor and "re-align" can run later: the note, the
// base characters it belongs to (by position, and their text at the time),
// the base tracking this note added ("spread" overflow) and the leading its
// line had before the note made room, to take back before the next layout.

import { normalizeNote } from "./layout";
import { chars } from "./text";
import { xmpStore } from "../xmpStore";

export const PAYLOAD_VERSION = 1;
export const XMP_NS = "http://ns.dryiceee.com/labelplus-nondum/ruby/1.0/";
export const XMP_PREFIX = "lpruby";
const PROPERTY = "data";

const store = xmpStore(XMP_NS, XMP_PREFIX);
export const readXmpData = (xmp) => store.read(xmp, PROPERTY);
export const writeXmpData = (xmp, value) => store.write(xmp, value, PROPERTY);

const roundDelta = (value) => Math.round(Number(value) * 100) / 100;

export function buildPayload({ note, baseId, baseText, deltas, leading }) {
  const list = chars(baseText);
  return {
    v: PAYLOAD_VERSION,
    kind: "note",
    base: Number(baseId) || 0,
    note: {
      start: note.start, end: note.end, text: note.text, align: note.align, distribute: note.distribute, overflow: note.overflow,
      size: note.size, ratio: note.ratio, gap: note.gap,
    },
    span: list.slice(note.start, note.end).join(""),
    baseText: String(baseText || ""),
    deltas: (deltas || []).map(({ index, delta }) => ({ index, delta: roundDelta(delta) })),
    leading: (leading || []).map((entry) => (typeof entry.leading === "number"
      ? { index: entry.index, autoLeading: entry.autoLeading !== false, leading: entry.leading }
      : { index: entry.index, autoLeading: entry.autoLeading !== false })),
  };
}

export function parsePayload(text) {
  let raw = text;
  if (typeof text === "string") {
    try {
      raw = JSON.parse(text);
    } catch (error) {
      return null;
    }
  }
  if (!raw || typeof raw !== "object" || typeof raw.v !== "number" || raw.v > PAYLOAD_VERSION || raw.kind !== "note") return null;
  if (!raw.note || typeof raw.note !== "object") return null;
  const deltas = Array.isArray(raw.deltas) ? raw.deltas
    .filter((entry) => entry && isFinite(Number(entry.index)) && isFinite(Number(entry.delta)))
    .map((entry) => ({ index: Math.trunc(Number(entry.index)), delta: Number(entry.delta) })) : [];
  const leading = Array.isArray(raw.leading) ? raw.leading
    .filter((entry) => entry && isFinite(Number(entry.index)))
    .map((entry) => (isFinite(Number(entry.leading)) && entry.leading !== null
      ? { index: Math.trunc(Number(entry.index)), autoLeading: entry.autoLeading !== false, leading: Number(entry.leading) }
      : { index: Math.trunc(Number(entry.index)), autoLeading: entry.autoLeading !== false })) : [];
  return {
    v: raw.v,
    kind: "note",
    base: Number(raw.base) || 0,
    note: normalizeNote(raw.note),
    span: typeof raw.span === "string" ? raw.span : "",
    baseText: typeof raw.baseText === "string" ? raw.baseText : "",
    deltas,
    leading,
  };
}

// The note's characters in the base text as it is now:
//   { status: "same" | "moved" | "lost", start, end, shift }
// Same text: where they were. Changed: the stored characters nearest to
// where they were; none left: lost (the editor asks for them again).
export function relocate(payload, currentText) {
  const { start, end } = payload.note;
  if (payload.baseText === currentText) return { status: "same", start, end, shift: 0 };
  const list = chars(currentText);
  const span = chars(payload.span);
  if (!span.length) return { status: "lost", start, end, shift: 0 };
  let best = -1;
  for (let i = 0; i + span.length <= list.length; i++) {
    let match = true;
    for (let j = 0; j < span.length && match; j++) match = list[i + j] === span[j];
    if (match && (best < 0 || Math.abs(i - start) < Math.abs(best - start))) best = i;
  }
  if (best < 0) return { status: "lost", start, end, shift: 0 };
  return { status: best === start ? "same" : "moved", start: best, end: best + span.length, shift: best - start };
}

// The deltas a note added, moved with its characters (dropped when lost or
// when they no longer fall inside the text)
export function relocatedDeltas(payload, located, textLength) {
  return relocatedEntries(payload.deltas, located, textLength);
}

// The leading the note's line had, moved the same way
export function relocatedLeading(payload, located, textLength) {
  return relocatedEntries(payload.leading, located, textLength);
}

function relocatedEntries(list, located, textLength) {
  if (located.status === "lost") return [];
  return (list || [])
    .map((entry) => Object.assign({}, entry, { index: entry.index + located.shift }))
    .filter(({ index }) => index >= 0 && index < textLength);
}
