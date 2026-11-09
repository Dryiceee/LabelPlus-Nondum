// A style from a text layer (app_src/labelplus/layerStyle.js). No Photoshop.
const assert = require("assert");
const load = require("./helpers/loadAppModule")();
const { mixedLooks, styleFromLayer } = load("app_src/labelplus/layerStyle.js");

const run = (from, to, textStyle) => ({ from, to, textStyle });
const look = { fontPostScriptName: "SourceHanSans-Bold", fontName: "思源黑体", size: 24, color: { red: 0, green: 0, blue: 0 } };
const layer = (ranges) => ({
  textProps: {
    layerText: {
      textKey: "你好！？",
      orientation: "vertical",
      textShape: [{ textType: "point" }],
      textClickPoint: { horizontal: 1, vertical: 2 },
      textStyleRange: ranges,
      paragraphStyleRange: [{ from: 0, to: 4, paragraphStyle: { alignment: "left" } }, { from: 4, to: 5, paragraphStyle: {} }],
    },
  },
  stroke: { enabled: true, size: 3 },
});

// One look, even split by upright "!?" in vertical text
assert.strictEqual(mixedLooks(layer([run(0, 2, look)]).textProps), false);
assert.strictEqual(mixedLooks(layer([run(0, 2, look), run(2, 4, { ...look, tcyUpDown: 0, baselineDirection: "crossStream" })]).textProps), false);

// Two fonts, or two sizes or colours: refused
assert.strictEqual(mixedLooks(layer([run(0, 2, look), run(2, 4, { ...look, fontPostScriptName: "Other", fontName: "Other" })]).textProps), true);
assert.strictEqual(mixedLooks(layer([run(0, 2, look), run(2, 4, { ...look, size: 30 })]).textProps), true);
assert.strictEqual(mixedLooks(layer([run(0, 2, look), run(2, 4, { ...look, color: { red: 255, green: 0, blue: 0 } })]).textProps), true);
assert.strictEqual(mixedLooks({}), false);

// The editor gets the look only, named after the font and size
{
  const data = layer([run(0, 2, look), run(2, 4, look)]);
  const style = styleFromLayer(data);
  const layerText = style.textProps.layerText;
  ["textKey", "textShape", "textClickPoint", "orientation"].forEach((key) => assert.ok(!(key in layerText), key));
  assert.strictEqual(layerText.textStyleRange.length, 1);
  assert.strictEqual(layerText.paragraphStyleRange.length, 1);
  assert.strictEqual(style.name, "思源黑体 24");
  assert.deepStrictEqual(style.stroke, { enabled: true, size: 3 });
  assert.strictEqual(data.textProps.layerText.textKey, "你好！？", "the layer data is untouched");
}

console.log("LabelPlus layer style tests passed");
