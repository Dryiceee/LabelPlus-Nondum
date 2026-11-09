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

// What the style editor gets: the first run and paragraph, nothing of the
// layer's own text, shape or place
function styleFromLayer(data) {
  const textProps = JSON.parse(JSON.stringify(data.textProps));
  const layerText = textProps.layerText;
  layerText.textStyleRange = layerText.textStyleRange.slice(0, 1);
  layerText.paragraphStyleRange = (layerText.paragraphStyleRange || []).slice(0, 1);
  ["textKey", "textShape", "textClickPoint", "transform", "boundingBox", "bounds", "warp", "orientation"].forEach((key) => delete layerText[key]);
  const textStyle = layerText.textStyleRange[0].textStyle || {};
  const size = typeof textStyle.size === "number" ? Math.round(textStyle.size * 10) / 10 : null;
  const name = [textStyle.fontName || textStyle.fontPostScriptName || "", size !== null ? String(size) : ""].filter(Boolean).join(" ");
  return { textProps, stroke: data.stroke || null, effects: effectsFromLayer(data.layerEffects), name };
}

export { mixedLooks, styleFromLayer };
