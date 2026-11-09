// Page list clicks and replacement options (app_src/labelplus/importOptions.js)
const assert = require("assert");
const load = require("./helpers/loadAppModule")();
const { DEFAULT_REPLACEMENTS, addReplacements, restoreDefaultReplacements, activeReplacements, clickRow } = load("app_src/labelplus/importOptions.js");
const { applyTextReplace } = load("app_src/labelplus/lpParser.js");

// The defaults, in an order that keeps "！？" whole
assert.strictEqual(applyTextReplace("啊！？...嗯？哦！", activeReplacements(DEFAULT_REPLACEMENTS)), "啊!?…嗯?哦!");

// New rules become options; known ones are switched back on; nothing is mutated
{
  const off = DEFAULT_REPLACEMENTS.map((option) => ({ ...option, enabled: option.from !== "？" }));
  const next = addReplacements(off, "？->?|A->B");
  assert.strictEqual(next.length, 5);
  assert.strictEqual(next[2].enabled, true);
  assert.deepStrictEqual(next[4], { from: "A", to: "B", enabled: true });
  assert.strictEqual(off[2].enabled, false);
  assert.strictEqual(addReplacements(off, "broken"), null);
  assert.deepStrictEqual(activeReplacements(off).map((rule) => rule.from), ["！？", "...", "！"]);
}

// Restoring brings deleted built-ins back on top and keeps the user's choices
{
  const restored = restoreDefaultReplacements([{ from: "A", to: "B", enabled: true }, { from: "？", to: "?", enabled: false }]);
  assert.deepStrictEqual(restored.map((option) => option.from), ["！？", "...", "？", "！", "A"]);
  assert.strictEqual(restored[2].enabled, false);
  assert.strictEqual(restored[0].enabled, true);
  assert.strictEqual(restoreDefaultReplacements([]).length, DEFAULT_REPLACEMENTS.length);
}

// Clicks
const NAMES = ["1", "2", "3", "4", "5"];
assert.deepStrictEqual(clickRow(NAMES, NAMES, null, "3"), { selected: ["3"], anchor: "3" });
assert.deepStrictEqual(clickRow(NAMES, ["1"], "1", "3", { ctrl: true }), { selected: ["1", "3"], anchor: "3" });
assert.deepStrictEqual(clickRow(NAMES, ["1", "3"], "1", "3", { ctrl: true }).selected, ["1"]);
assert.deepStrictEqual(clickRow(NAMES, ["5"], "2", "4", { shift: true }), { selected: ["2", "3", "4"], anchor: "2" });
assert.deepStrictEqual(clickRow(NAMES, ["2", "3", "4"], "2", "1", { shift: true }).selected, ["1", "2"]);
assert.deepStrictEqual(clickRow(NAMES, ["5"], "1", "2", { shift: true, ctrl: true }).selected, ["1", "2", "5"]);
assert.deepStrictEqual(clickRow(NAMES, [], null, "4", { shift: true }), { selected: ["4"], anchor: "4" });

console.log("LabelPlus import option tests passed");
