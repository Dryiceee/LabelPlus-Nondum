import { effectsFromLayer } from "./layerEffects";

// A new style from a text layer. A style holds one look, so a layer whose text
// mixes fonts or looks cannot become one. Pure.

// What makes the look of a run. Ranges also split for reasons that are not a
// look of their own, such as upright "!?" in vertical text: those keys are left out.
const LOOK_KEYS = [
  "fontPostScriptName", "fontName", "fontStyleName", "size", "color", "horizontalScale", "verticalScale",
  "tracking", "autoLeading", "leading", "syntheticBold", "syntheticItalic", "fontCaps", "underline",
  "strikethrough", "baselineShift",
];

const lookOf = (textStyle) => JSON.stringify(LOOK_KEYS.map((key) => (textStyle && key in textStyle ? textStyle[key] : null)));

// The runs of the layer with a look different from the first
function mixedLooks(textProps) {
  const ranges = (textProps && textProps.layerText && textProps.layerText.textStyleRange) || [];
  if (ranges.length < 2) return false;
  const first = lookOf(ranges[0].textStyle);
  return ranges.some((range) => lookOf(range.textStyle) !== first);
}

// Photoshop stores size, leading and baseline shift before the layer transform:
// a text scaled with free transform keeps its old size, and the Character panel
// shows that size times the scale. A style has no transform, so the values the
// panel shows go into the runs. Changes layerText in place.
function transformScale(transform) {
  if (!transform) return 1;
  const xx = Number(transform.xx) || 0, xy = Number(transform.xy) || 0, yx = Number(transform.yx) || 0, yy = Number(transform.yy) || 0;
  const scale = Math.sqrt(yx * yx + yy * yy) || Math.sqrt(xx * xx + xy * xy);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

const displayed = (style, key, impliedKey, scale) => {
  const implied = Number(style[impliedKey]);
  if (style[impliedKey] != null && Number.isFinite(implied)) return implied;
  return Number(style[key]) * scale;
};

const round = (value) => Math.round(value * 10000) / 10000;

function bakeLayerTransform(layerText) {
  if (!layerText) return layerText;
  const scale = transformScale(layerText.transform);
  (layerText.textStyleRange || []).forEach((range) => {
    const style = range && range.textStyle;
    if (!style) return;
    if (typeof style.size === "number" || style.impliedFontSize != null) style.size = round(displayed(style, "size", "impliedFontSize", scale));
    if (typeof style.leading === "number" || style.impliedLeading != null) style.leading = round(displayed(style, "leading", "impliedLeading", scale));
    if (typeof style.baselineShift === "number" || style.impliedBaselineShift != null) style.baselineShift = round(displayed(style, "baselineShift", "impliedBaselineShift", scale));
    delete style.impliedFontSize;
    delete style.impliedLeading;
    delete style.impliedBaselineShift;
  });
  delete layerText.transform;
  return layerText;
}

// What the style editor gets: the first run and paragraph, nothing of the
// layer's own text, shape or place
function styleFromLayer(data) {
  const textProps = JSON.parse(JSON.stringify(data.textProps));
  const layerText = textProps.layerText;
  layerText.textStyleRange = layerText.textStyleRange.slice(0, 1);
  bakeLayerTransform(layerText);
  layerText.paragraphStyleRange = (layerText.paragraphStyleRange || []).slice(0, 1);
  ["textKey", "textShape", "textClickPoint", "transform", "boundingBox", "bounds", "warp", "orientation"].forEach((key) => delete layerText[key]);
  const textStyle = layerText.textStyleRange[0].textStyle || {};
  const size = typeof textStyle.size === "number" ? Math.round(textStyle.size * 10) / 10 : null;
  const name = [textStyle.fontName || textStyle.fontPostScriptName || "", size !== null ? String(size) : ""].filter(Boolean).join(" ");
  return { textProps, stroke: data.stroke || null, effects: effectsFromLayer(data.layerEffects), name };
}

export { bakeLayerTransform, mixedLooks, styleFromLayer };
