// Ruby (行间注): the base layer's text styles, in jamText's simplified form
// ({ layerText: { textKey, textStyleRange: [{ from, to, textStyle }], ... },
// typeUnit }). Ranges count UTF-16 units; the ruby editor counts characters.

import { chars, utf16Offsets } from "./text";

const clone = (value) => JSON.parse(JSON.stringify(value === undefined ? null : value));

// The text style that covers UTF-16 offset `at`
export function styleAt(layerText, at) {
  const ranges = (layerText && layerText.textStyleRange) || [];
  for (const range of ranges) {
    if (range && at >= range.from && at < range.to) return range.textStyle || {};
  }
  const last = ranges[ranges.length - 1];
  return (last && last.textStyle) || {};
}

// Scale of the layer's transform (free transform keeps the stored size)
export function transformScale(transform) {
  if (!transform) return 1;
  const xx = Number(transform.xx) || 0, xy = Number(transform.xy) || 0, yx = Number(transform.yx) || 0, yy = Number(transform.yy) || 0;
  const scale = Math.sqrt(yx * yx + yy * yy) || Math.sqrt(xx * xx + xy * xy);
  return isFinite(scale) && scale > 0 ? scale : 1;
}

// Only scaling: rotation, skew and flips are not supported
export function isPlainScale(transform) {
  if (!transform) return true;
  const xx = Number(transform.xx) || 0, xy = Number(transform.xy) || 0, yx = Number(transform.yx) || 0, yy = Number(transform.yy) || 0;
  const scale = Math.max(Math.abs(xx), Math.abs(yy), 1e-9);
  return xx > 0 && yy > 0 && Math.abs(xy) / scale < 1e-3 && Math.abs(yx) / scale < 1e-3;
}

export function typeUnitToPixels(value, unit, resolution) {
  const res = Number(resolution) || 72;
  if (unit === "pixelsUnit") return value;
  if (unit === "millimetersUnit") return (value * res) / 25.4;
  return (value * res) / 72;
}

export function pixelsToTypeUnit(px, unit, resolution) {
  const res = Number(resolution) || 72;
  if (unit === "pixelsUnit") return px;
  if (unit === "millimetersUnit") return (px * 25.4) / res;
  return (px * 72) / res;
}

// The size each character shows at, in document px (the size the Character
// panel shows: the stored size times the layer's scale)
export function emsOf(text, resolution) {
  const layerText = text && text.layerText;
  const list = chars(layerText && layerText.textKey);
  const offsets = utf16Offsets(list);
  const scale = transformScale(layerText && layerText.transform);
  return list.map((ch, i) => {
    const style = styleAt(layerText, offsets[i]);
    const implied = Number(style.impliedFontSize);
    const value = isFinite(implied) && implied > 0 ? implied : Number(style.size) * scale;
    return isFinite(value) && value > 0 ? typeUnitToPixels(value, text.typeUnit, resolution) : 0;
  });
}

// Changes the style of single characters: edits maps a character index to
// a function from its style to the new style. Splits ranges as needed and
// returns a new layerText.
export function editCharStyles(layerText, edits) {
  const result = clone(layerText);
  const list = chars(result.textKey);
  const offsets = utf16Offsets(list);
  const byOffset = {};
  Object.keys(edits || {}).forEach((key) => {
    const index = Number(key);
    if (index >= 0 && index < list.length) byOffset[offsets[index]] = { fn: edits[key], length: list[index].length };
  });
  const cuts = Object.keys(byOffset).map(Number).sort((a, b) => a - b);
  if (!cuts.length) return result;
  const ranges = [];
  (result.textStyleRange || []).forEach((range) => {
    let from = range.from;
    const pieces = [];
    cuts.forEach((at) => {
      if (at < range.from || at >= range.to) return;
      if (at > from) pieces.push({ from, to: at, fn: null });
      pieces.push({ from: at, to: Math.min(range.to, at + byOffset[at].length), fn: byOffset[at].fn });
      from = Math.min(range.to, at + byOffset[at].length);
    });
    if (from < range.to) pieces.push({ from, to: range.to, fn: null });
    pieces.forEach((piece) => {
      const textStyle = clone(range.textStyle || {});
      ranges.push(Object.assign({}, range, { from: piece.from, to: piece.to, textStyle: piece.fn ? piece.fn(textStyle) : textStyle }));
    });
  });
  result.textStyleRange = ranges;
  return result;
}

// Adds `sign` × delta to the tracking of the characters in `deltas`
// ([{ index, delta }], index: character)
export function addTracking(layerText, deltas, sign = 1) {
  const sums = {};
  (deltas || []).forEach(({ index, delta }) => { sums[index] = (sums[index] || 0) + sign * delta; });
  const edits = {};
  Object.keys(sums).forEach((index) => {
    if (!sums[index]) return;
    edits[index] = (style) => Object.assign(style, { tracking: Math.round((Number(style.tracking) || 0) + sums[index]) });
  });
  return editCharStyles(layerText, edits);
}

// The paragraph's leading type at a UTF-16 offset ("leadingAbove" |
// "leadingBelow"), or null
export function leadingTypeAt(layerText, at) {
  const ranges = (layerText && layerText.paragraphStyleRange) || [];
  const range = ranges.find((r) => r && at >= r.from && at < r.to) || ranges[ranges.length - 1];
  const value = range && range.paragraphStyle && range.paragraphStyle.leadingType;
  const type = value && typeof value === "object" ? value._value : value;
  return typeof type === "string" ? type : null;
}

// The leading of characters as it is: [{ index, autoLeading, leading }]
export function leadingOf(layerText, indices) {
  const offsets = utf16Offsets(chars(layerText && layerText.textKey));
  return indices.map((index) => {
    const style = styleAt(layerText, offsets[index]);
    const entry = { index, autoLeading: style.autoLeading !== false };
    if (typeof style.leading === "number") entry.leading = style.leading;
    return entry;
  });
}

// Fixed leading (in the layer's type unit, before its transform) on characters
export function setLeading(layerText, indices, leading) {
  const edits = {};
  indices.forEach((index) => {
    edits[index] = (style) => {
      delete style.impliedLeading;
      return Object.assign(style, { autoLeading: false, leading });
    };
  });
  return editCharStyles(layerText, edits);
}

// Puts back leading read by leadingOf
export function restoreLeading(layerText, saved) {
  const edits = {};
  (saved || []).forEach((entry) => {
    edits[entry.index] = (style) => {
      delete style.impliedLeading;
      style.autoLeading = entry.autoLeading !== false;
      if (typeof entry.leading === "number") style.leading = entry.leading;
      else delete style.leading;
      return style;
    };
  });
  return editCharStyles(layerText, edits);
}

// What earlier notes did to the base, taken back: { tracking, leading }
export function takeBackStyles(layerText, takeBack) {
  if (!takeBack) return layerText;
  let result = layerText;
  if (takeBack.tracking && takeBack.tracking.length) result = addTracking(result, takeBack.tracking, -1);
  if (takeBack.leading && takeBack.leading.length) result = restoreLeading(result, takeBack.leading);
  return result;
}

export const hasTakeBack = (takeBack) => !!takeBack && ((takeBack.tracking && takeBack.tracking.length > 0) || (takeBack.leading && takeBack.leading.length > 0));

// What a layerText must say to be written back. Photoshop reads `size`,
// `leading` and `baselineShift` before the layer transform, but takes a
// written value as the displayed one (uxp-src/host/photoshop.js,
// _displayedStyleValue): a free-transformed layer written back as read
// would shrink or grow by its scale. Every value here is as read (before the
// transform); the implied value is the displayed one where Photoshop gave
// it and nothing changed it since (the edits above drop it when they change
// a value), else the value times the scale.
export function displayedLayerText(layerText) {
  const result = clone(layerText);
  const scale = transformScale(result && result.transform);
  const shown = (style, key, impliedKey) => {
    const implied = Number(style[impliedKey]);
    if (style[impliedKey] !== undefined && style[impliedKey] !== null && isFinite(implied)) return implied;
    const value = Number(style[key]);
    return isFinite(value) ? value * scale : undefined;
  };
  ((result && result.textStyleRange) || []).forEach((range) => {
    const style = range.textStyle || {};
    if (style.size !== undefined) {
      const size = shown(style, "size", "impliedFontSize");
      if (size !== undefined) style.size = size;
    }
    if (typeof style.leading === "number") {
      const leading = shown(style, "leading", "impliedLeading");
      if (leading !== undefined) style.leading = leading;
    }
    if (typeof style.baselineShift === "number") {
      const shift = shown(style, "baselineShift", "impliedBaselineShift");
      if (shift !== undefined) style.baselineShift = shift;
    }
    delete style.impliedFontSize;
    delete style.impliedLeading;
    delete style.impliedBaselineShift;
    range.textStyle = style;
  });
  return result;
}

// Sets keys on every range's style (e.g. faux bold off for measuring)
export function overrideStyles(layerText, override) {
  const result = clone(layerText);
  (result.textStyleRange || []).forEach((range) => {
    range.textStyle = Object.assign({}, range.textStyle || {}, override);
  });
  return result;
}

// A note layer's text, in the style of the base at the note's first
// character: the note's own size, tracking and scale, no baseline shift
export function noteLayerText(baseLayerText, at, note) {
  const result = clone(baseLayerText);
  const textStyle = clone(styleAt(baseLayerText, at));
  delete textStyle.impliedFontSize;
  delete textStyle.impliedLeading;
  delete textStyle.impliedBaselineShift;
  textStyle.size = note.size;
  textStyle.tracking = Math.round(note.tracking || 0);
  textStyle.baselineShift = 0;
  textStyle.horizontalScale = 100;
  textStyle.verticalScale = 100;
  if (note.scaleKey) textStyle[note.scaleKey] = Math.round((note.scale || 1) * 10000) / 100;
  textStyle.autoLeading = true;
  const length = String(note.text).length;
  result.textKey = note.text;
  result.textStyleRange = [{ from: 0, to: length, textStyle }];
  const paragraph = baseLayerText.paragraphStyleRange && baseLayerText.paragraphStyleRange[0];
  if (paragraph) result.paragraphStyleRange = [Object.assign({}, clone(paragraph), { from: 0, to: length })];
  return result;
}
