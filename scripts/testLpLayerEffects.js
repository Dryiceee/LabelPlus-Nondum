// Layer styles kept by a style (app_src/labelplus/layerEffects.js). No Photoshop.
const assert = require("assert");
const load = require("./helpers/loadAppModule")();
const fx = load("app_src/labelplus/layerEffects.js");

const px = (value) => ({ _unit: "pixelsUnit", _value: value });
const LAYER = {
  _obj: "layerEffects",
  scale: { _unit: "percentUnit", _value: 100 },
  frameFX: { _obj: "frameFX", enabled: true, present: true, size: px(3) },
  dropShadowMulti: [
    { _obj: "dropShadow", enabled: true, present: true, distance: px(5), blur: px(4), color: { _obj: "RGBColor", red: 0, grain: 0, blue: 0 } },
    { _obj: "dropShadow", enabled: false, present: true, distance: px(9), blur: px(2) },
  ],
  innerGlow: { _obj: "innerGlow", enabled: true, present: true, blur: px(6) },
  outerGlow: { _obj: "outerGlow", enabled: true, present: false },
  bevelEmboss: { _obj: "bevelEmboss", enabled: true, present: true, highlightMode: { _enum: "blendMode", _value: "screen" } },
};

// Read: every effect but the stroke and those not present, lists split
{
  const effects = fx.effectsFromLayer(LAYER);
  assert.deepStrictEqual(effects.map((effect) => effect.key), ["bevelEmboss", "innerGlow", "dropShadow", "dropShadow"]);
  assert.strictEqual(effects[0].desc.highlightMode._value, "screen", "unknown options are kept as they are");
  assert.deepStrictEqual(fx.effectsFromLayer(null), []);
}

// Write: lists again, disabled effects left out, the style's stroke added
{
  const effects = fx.effectsFromLayer(LAYER);
  const stroke = { enabled: true, size: 4, opacity: 100, color: { r: 255, g: 255, b: 255 } };
  const desc = fx.buildLayerEffects(effects, stroke);
  assert.strictEqual(desc._obj, "layerEffects");
  assert.strictEqual(desc.dropShadow.distance._value, 5, "one shadow left on: a single entry");
  assert.ok(!desc.dropShadowMulti);
  assert.ok(desc.innerGlow && desc.bevelEmboss);
  assert.strictEqual(desc.frameFX.size._value, 4);
  assert.strictEqual(desc.frameFX.color.grain, 255);
  const twoOn = effects.map((effect) => ({ key: effect.key, desc: { ...effect.desc, enabled: true } }));
  assert.strictEqual(fx.buildLayerEffects(twoOn, null).dropShadowMulti.length, 2);
}

// A style with nothing on clears the layer: no descriptor at all
assert.strictEqual(fx.buildLayerEffects([], { enabled: false, size: 3, color: { r: 0, g: 0, b: 0 } }), null);
assert.strictEqual(fx.buildLayerEffects([{ key: "dropShadow", desc: { enabled: false } }], null), null);
assert.strictEqual(fx.buildLayerEffects(undefined, undefined), null);

// Editing keeps units and turns off the global angle for an edited angle
{
  const shadow = fx.newEffect("dropShadow");
  assert.strictEqual(fx.fieldValue(shadow.desc, "distance"), 5);
  const moved = fx.withField(shadow.desc, "localLightingAngle", 90);
  assert.deepStrictEqual(moved.localLightingAngle, { _unit: "angleUnit", _value: 90 });
  assert.strictEqual(moved.useGlobalAngle, false);
  assert.strictEqual(fx.colorHex(shadow.desc), "#000000");
  assert.strictEqual(fx.colorHex(fx.withColor(shadow.desc, "#ff8000")), "#ff8000");
  assert.strictEqual(fx.withColor(shadow.desc, "bad"), shadow.desc);
  assert.strictEqual(fx.colorHex({ color: { gray: 50 } }), null);
  fx.ADDABLE.forEach((key) => assert.strictEqual(fx.newEffect(key).desc._obj, key));
}

console.log("LabelPlus layer effects tests passed");
