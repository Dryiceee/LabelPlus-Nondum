const assert = require("assert");
const loadAppModule = require("./helpers/loadAppModule")();

const { buildFontGroups, getFontGroupKey } = loadAppModule("app_src/fontScan.js");

const makeRun = (overrides = {}) => ({
  fontPostScriptName: "CCWildWords",
  fontName: "CC Wild Words",
  fontStyleName: "Regular",
  syntheticBold: false,
  syntheticItalic: false,
  size: 16,
  color: { red: 0, green: 0, blue: 0 },
  ...overrides,
});

const makeLayer = (runs, overrides = {}) => ({
  layerName: "text layer",
  antiAlias: "antiAliasSmooth",
  typeUnit: "pixelsUnit",
  paragraphStyle: { alignment: "center" },
  stroke: null,
  runs,
  ...overrides,
});

// Real and synthetic bold/italic variants get distinct group keys
assert.notStrictEqual(getFontGroupKey(makeRun()), getFontGroupKey(makeRun({ fontPostScriptName: "CCWildWords-BoldItalic" })));
assert.notStrictEqual(getFontGroupKey(makeRun()), getFontGroupKey(makeRun({ syntheticBold: true })));
assert.notStrictEqual(getFontGroupKey(makeRun()), getFontGroupKey(makeRun({ syntheticItalic: true })));

// Most-used size wins; variants stay separate groups
const groups = buildFontGroups([
  {
    file: "a.psd",
    layers: [
      makeLayer([makeRun({ size: 16 })]),
      makeLayer([makeRun({ size: 16 })]),
      makeLayer([makeRun({ size: 20 })]),
      makeLayer([makeRun({ fontPostScriptName: "CCWildWords-BoldItalic", fontStyleName: "Bold Italic", size: 18 })]),
    ],
  },
  {
    file: "b.psd",
    layers: [
      makeLayer([makeRun({ size: 16 })]),
      makeLayer([makeRun({ syntheticItalic: true, size: 14 })]),
    ],
  },
]);

assert.strictEqual(groups.length, 3, "regular, real bold-italic and faux italic should be separate");
const regular = groups.find((g) => g.key === getFontGroupKey(makeRun()));
assert.ok(regular, "regular group exists");
assert.strictEqual(regular.topSize, 16, "most-used size wins");
assert.strictEqual(regular.usageCount, 4);
assert.strictEqual(regular.fileCount, 2);
assert.strictEqual(regular.textProps.layerText.textStyleRange[0].textStyle.size, 16);
assert.strictEqual(groups[0].key, regular.key, "groups sorted by usage count");

const fauxItalic = groups.find((g) => g.syntheticItalic);
assert.ok(fauxItalic, "faux italic group exists");
assert.ok(/faux italic/i.test(fauxItalic.defaultName), "faux italic flagged in default name");

// Identical runs inside one layer count once; different sizes still feed the histogram
const dedupGroups = buildFontGroups([
  {
    file: "c.psd",
    layers: [
      makeLayer([makeRun({ size: 12 }), makeRun({ size: 12 }), makeRun({ size: 13 })]),
    ],
  },
]);
assert.strictEqual(dedupGroups.length, 1);
assert.strictEqual(dedupGroups[0].usageCount, 2, "identical runs in a layer deduplicated");

// Stroke of the representative variant is normalized and kept
const strokeGroups = buildFontGroups([
  {
    file: "d.psd",
    layers: [
      makeLayer([makeRun({ size: 15 })], { stroke: { enabled: true, size: 3.14159, opacity: 87.4, position: "outer", color: { r: 254.6, g: 0, b: 0 } } }),
    ],
  },
]);
assert.strictEqual(strokeGroups[0].stroke.enabled, true);
assert.strictEqual(strokeGroups[0].stroke.size, 3.14);
assert.strictEqual(strokeGroups[0].stroke.opacity, 87);
assert.strictEqual(strokeGroups[0].stroke.color.r, 255);

// Disabled or missing strokes normalize to the default disabled stroke
assert.strictEqual(regular.stroke.enabled, false);
assert.strictEqual(regular.stroke.color.r, 255);

// Paragraph defaults mirror copyLayerStyle normalization
const paragraphStyle = regular.textProps.layerText.paragraphStyleRange[0].paragraphStyle;
assert.strictEqual(paragraphStyle.burasagari, "burasagariNone");
assert.strictEqual(paragraphStyle.singleWordJustification, "justifyAll");
assert.strictEqual(paragraphStyle.justificationMethodType, "justifMethodAutomatic");
assert.strictEqual(paragraphStyle.textEveryLineComposer, false);
assert.strictEqual(paragraphStyle.alignment, "center");

// Layer styles other than the stroke travel with the style, as for a style
// made from the selected layer; the stroke keeps its own field
const shadow = { _obj: "dropShadow", enabled: true, present: true, opacity: { _unit: "percentUnit", _value: 60 } };
const fxGroups = buildFontGroups([{
  file: "fx.psd",
  layers: [
    makeLayer([makeRun({ fontPostScriptName: "FxFont" })], { layerEffects: { _obj: "layerEffects", dropShadow: shadow, frameFX: { _obj: "frameFX", enabled: true } } }),
    makeLayer([makeRun({ fontPostScriptName: "FxFont" })], { layerEffects: { _obj: "layerEffects", dropShadow: shadow } }),
    makeLayer([makeRun({ fontPostScriptName: "FxFont" })]),
  ],
}]);
assert.strictEqual(fxGroups.length, 1);
assert.deepStrictEqual(fxGroups[0].effects.map((effect) => effect.key), ["dropShadow"]);
assert.strictEqual(fxGroups[0].effects[0].desc.opacity._value, 60);
const plainGroup = buildFontGroups([{ file: "plain.psd", layers: [makeLayer([makeRun({ fontPostScriptName: "Plain" })])] }])[0];
assert.deepStrictEqual(plainGroup.effects, []);

// Empty input stays safe
assert.deepStrictEqual(buildFontGroups([]), []);
assert.deepStrictEqual(buildFontGroups(null), []);

// A layer scaled with free transform counts at the size Photoshop shows: 8 pt
// scaled by 2 is the same 16 as an unscaled 16 pt layer, leading included
{
  const scaled = (size, scale, extra = {}) => makeLayer([makeRun({ fontPostScriptName: "Scaled", size, leading: size * 1.2, autoLeading: false, ...extra })], { transform: { xx: scale, xy: 0, yx: 0, yy: scale, tx: 0, ty: 0 } });
  const scanned = buildFontGroups([{
    file: "scaled.psd",
    layers: [scaled(8, 2), scaled(16, 1), scaled(10, 2), makeLayer([makeRun({ fontPostScriptName: "Scaled", size: 16, leading: 19.2, autoLeading: false })])],
  }])[0];
  assert.deepStrictEqual(scanned.sizes, [{ size: 16, count: 3 }, { size: 20, count: 1 }]);
  assert.strictEqual(scanned.topSize, 16);
  assert.strictEqual(scanned.textProps.layerText.textStyleRange[0].textStyle.leading, 19.2);
  assert.ok(!("transform" in scanned.textProps.layerText));

  // Implied sizes, when Photoshop gives them, win; the scanned runs stay as they were
  const run = makeRun({ fontPostScriptName: "Implied", size: 18, impliedFontSize: 75.36690942939958 });
  const implied = buildFontGroups([{ file: "implied.psd", layers: [makeLayer([run], { transform: { xx: 4.187, xy: 0, yx: 0, yy: 4.187 } })] }])[0];
  assert.strictEqual(implied.topSize, 75.37);
  assert.strictEqual(run.size, 18);
}

console.log("fontScan tests passed");
