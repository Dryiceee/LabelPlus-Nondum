// Layer styles kept by a TypeR style, beside its stroke: drop shadow, inner
// shadow, glows, bevel, satin, overlays. They are kept as Photoshop gives them
// (actionJSON of the layer's layerEffects), so every option of every effect
// survives, and the editor only touches the common fields. Pure.
//
// The stroke keeps its own field and editor (style.stroke): frameFX is never
// part of style.effects.

// In the order of Photoshop's Layer Style dialog
const EFFECT_KEYS = [
  "bevelEmboss", "chromeFX", "innerShadow", "innerGlow", "solidFill", "gradientFill", "patternFill",
  "outerGlow", "dropShadow",
];
// Newer Photoshop versions keep repeatable effects in lists
const MULTI_KEYS = { innerShadow: "innerShadowMulti", solidFill: "solidFillMulti", gradientFill: "gradientFillMulti", dropShadow: "dropShadowMulti" };

const clone = (value) => JSON.parse(JSON.stringify(value));
const unit = (name, value) => ({ _unit: name, _value: value });
const enumValue = (type, value) => ({ _enum: type, _value: value });
const BLACK = { _obj: "RGBColor", red: 0, grain: 0, blue: 0 };
const WHITE = { _obj: "RGBColor", red: 255, grain: 255, blue: 255 };
const LINEAR = { _obj: "shapeCurveType", name: "Linear" };

// New effects get Photoshop's own defaults
const DEFAULTS = {
  dropShadow: () => ({
    _obj: "dropShadow", enabled: true, present: true, showInDialog: true, mode: enumValue("blendMode", "multiply"),
    color: clone(BLACK), opacity: unit("percentUnit", 75), useGlobalAngle: false, localLightingAngle: unit("angleUnit", 120),
    distance: unit("pixelsUnit", 5), chokeMatte: unit("pixelsUnit", 0), blur: unit("pixelsUnit", 5),
    noise: unit("percentUnit", 0), antiAlias: false, transferSpec: clone(LINEAR), layerConceals: true,
  }),
  innerShadow: () => ({
    _obj: "innerShadow", enabled: true, present: true, showInDialog: true, mode: enumValue("blendMode", "multiply"),
    color: clone(BLACK), opacity: unit("percentUnit", 75), useGlobalAngle: false, localLightingAngle: unit("angleUnit", 120),
    distance: unit("pixelsUnit", 5), chokeMatte: unit("pixelsUnit", 0), blur: unit("pixelsUnit", 5),
    noise: unit("percentUnit", 0), antiAlias: false, transferSpec: clone(LINEAR),
  }),
  outerGlow: () => ({
    _obj: "outerGlow", enabled: true, present: true, showInDialog: true, mode: enumValue("blendMode", "screen"),
    color: clone(WHITE), opacity: unit("percentUnit", 75), glowTechnique: enumValue("matteTechnique", "softMatte"),
    chokeMatte: unit("pixelsUnit", 0), blur: unit("pixelsUnit", 5), noise: unit("percentUnit", 0),
    shadingNoise: unit("percentUnit", 0), antiAlias: false, transferSpec: clone(LINEAR), inputRange: unit("percentUnit", 50),
  }),
  innerGlow: () => ({
    _obj: "innerGlow", enabled: true, present: true, showInDialog: true, mode: enumValue("blendMode", "screen"),
    color: clone(WHITE), opacity: unit("percentUnit", 75), glowTechnique: enumValue("matteTechnique", "softMatte"),
    chokeMatte: unit("pixelsUnit", 0), blur: unit("pixelsUnit", 5), noise: unit("percentUnit", 0),
    shadingNoise: unit("percentUnit", 0), antiAlias: false, transferSpec: clone(LINEAR), inputRange: unit("percentUnit", 50),
    innerGlowSource: enumValue("innerGlowSourceType", "edgeGlow"),
  }),
  solidFill: () => ({
    _obj: "solidFill", enabled: true, present: true, showInDialog: true, mode: enumValue("blendMode", "normal"),
    opacity: unit("percentUnit", 100), color: clone(BLACK),
  }),
};
const ADDABLE = ["dropShadow", "innerShadow", "outerGlow", "innerGlow", "solidFill"];

// The effects of a layer's layerEffects, without the stroke. Each entry is one
// effect: { key, desc }; repeatable effects listed by Photoshop give one entry each.
function effectsFromLayer(layerEffects) {
  const effects = [];
  if (!layerEffects || typeof layerEffects !== "object") return effects;
  EFFECT_KEYS.forEach((key) => {
    const list = MULTI_KEYS[key] && Array.isArray(layerEffects[MULTI_KEYS[key]]) ? layerEffects[MULTI_KEYS[key]] : null;
    const descs = list || (layerEffects[key] ? [layerEffects[key]] : []);
    descs.forEach((desc) => {
      if (desc && desc.present !== false) effects.push({ key, desc: clone(desc) });
    });
  });
  return effects;
}

const strokeFrame = (stroke) => ({
  _obj: "frameFX",
  enabled: true,
  present: true,
  showInDialog: true,
  style: enumValue("frameStyle", "outsetFrame"),
  paintType: enumValue("frameFill", "solidColor"),
  mode: enumValue("blendMode", "normal"),
  size: unit("pixelsUnit", stroke.size || 3),
  opacity: unit("percentUnit", stroke.opacity || 100),
  color: { _obj: "RGBColor", red: stroke.color.r, grain: stroke.color.g, blue: stroke.color.b },
});

const strokeOn = (stroke) => !!(stroke && stroke.enabled !== false && stroke.color && (stroke.size > 0 || stroke.enabled === true));

// The whole layerEffects to set for a style, or null when it has none on: the
// layer's own style is then cleared, so nothing of a previous style stays.
function buildLayerEffects(effects, stroke) {
  const on = (effects || []).filter((effect) => effect && effect.desc && effect.desc.enabled !== false);
  if (!on.length && !strokeOn(stroke)) return null;
  const result = { _obj: "layerEffects", scale: unit("percentUnit", 100) };
  EFFECT_KEYS.forEach((key) => {
    const descs = on.filter((effect) => effect.key === key).map((effect) => clone(effect.desc));
    if (!descs.length) return;
    if (descs.length > 1 && MULTI_KEYS[key]) result[MULTI_KEYS[key]] = descs;
    else result[key] = descs[0];
  });
  if (strokeOn(stroke)) result.frameFX = strokeFrame(stroke);
  return result;
}

// Fields the editor shows when the effect has them. Sizes are pixels,
// opacity and angle plain numbers.
const FIELDS = [
  { key: "opacity", kind: "percent" },
  { key: "blur", kind: "pixels" },
  { key: "distance", kind: "pixels" },
  { key: "localLightingAngle", kind: "angle" },
];

const fieldValue = (desc, key) => {
  const value = desc && desc[key];
  if (value === undefined || value === null) return null;
  return typeof value === "object" && "_value" in value ? value._value : value;
};

function withField(desc, key, number) {
  const next = clone(desc);
  if (next[key] && typeof next[key] === "object" && "_value" in next[key]) next[key]._value = number;
  else next[key] = number;
  if (key === "localLightingAngle") next.useGlobalAngle = false;
  return next;
}

const toHex = (part) => ("0" + Math.max(0, Math.min(255, Math.round(Number(part) || 0))).toString(16)).slice(-2);

// "#rrggbb" of an effect's solid colour, or null when it has none (gradient,
// pattern, or a grey or CMYK colour Photoshop keeps as such)
function colorHex(desc) {
  const color = desc && desc.color;
  if (!color || !("red" in color)) return null;
  const green = "grain" in color ? color.grain : color.green;
  return "#" + toHex(color.red) + toHex(green) + toHex(color.blue);
}

function withColor(desc, hex) {
  const value = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
  if (!value) return desc;
  const next = clone(desc);
  const number = parseInt(value[1], 16);
  next.color = { _obj: "RGBColor", red: (number >> 16) & 255, grain: (number >> 8) & 255, blue: number & 255 };
  return next;
}

const newEffect = (key) => ({ key, desc: DEFAULTS[key]() });

export {
  EFFECT_KEYS,
  ADDABLE,
  FIELDS,
  effectsFromLayer,
  buildLayerEffects,
  fieldValue,
  withField,
  colorHex,
  withColor,
  newEffect,
};
