// Image matching, group rules and the import plan
// (app_src/labelplus/importPlan.js). No Photoshop involved.
const assert = require("assert");
const load = require("./helpers/loadAppModule")();
const {
  detectImageFolder,
  matchImages,
  defaultGroupRules,
  mergeGroupRules,
  buildImportPlan,
  labelPointOffset,
} = load("app_src/labelplus/importPlan.js");
const { parseLpText } = load("app_src/labelplus/lpParser.js");

// Finding the pages
assert.strictEqual(detectImageFolder([{ name: "misc", images: 3 }, { name: "Images", images: 2 }], 5), "Images");
assert.strictEqual(detectImageFolder([{ name: "images", images: 0 }], 4), "");
assert.strictEqual(detectImageFolder([{ name: "第一话", images: 8 }], 0), "第一话");
assert.strictEqual(detectImageFolder([{ name: "a", images: 1 }, { name: "b", images: 1 }], 0), null);

// Exact name, then the same page under another extension, then missing
{
  const matches = matchImages(["001.jpg", "002.jpg", "003.jpg"], ["001.JPG", "002.png", "002.tif", "note.txt"]);
  assert.deepStrictEqual(matches.map((match) => match.file), ["001.JPG", "002.png", ""]);
}

// A forced extension does not fall back to another one
{
  const matches = matchImages(["1.jpg", "2.jpg"], ["1.png", "2.tif"], { replaceExtension: "png" });
  assert.deepStrictEqual(matches.map((match) => match.file), ["1.png", ""]);
}

// By order follows the reading order, not the raw text order
{
  const matches = matchImages(["a.jpg", "b.jpg", "c.jpg"], ["10.png", "2.png"], { byOrder: true });
  assert.deepStrictEqual(matches.map((match) => match.file), ["2.png", "10.png", ""]);
}

// Group names are not hard-coded: the first one is centred, whatever its name;
// whitening waits for the user
assert.deepStrictEqual(defaultGroupRules(["对白", "旁白", "拟声"]), {
  对白: { styleId: null, center: true, clean: false },
  旁白: { styleId: null, center: false, clean: false },
  拟声: { styleId: null, center: false, clean: false },
});

// Saved rules win, new groups get the default, old ones are kept for later
{
  const merged = mergeGroupRules(["框内", "新组"], { 框内: { styleId: "s1", center: false }, 旧组: { styleId: "s2", center: true } });
  assert.deepStrictEqual(merged.框内, { styleId: "s1", center: false });
  assert.deepStrictEqual(merged.新组, { styleId: null, center: false, clean: false });
  assert.deepStrictEqual(merged.旧组, { styleId: "s2", center: true });
}

const LP = parseLpText([
  "1,0", "-", "框内", "框外", "-", "",
  ">>>>>>[1.jpg]<<<<<<",
  "------[1]------[0.1,0.1,1]", "你好...",
  "------[2]------[0.2,0.2,2]", "拟声",
  ">>>>>>[1.png]<<<<<<",
  "------[1]------[0.3,0.3,1]", "同名",
  ">>>>>>[2.jpg]<<<<<<",
  ">>>>>>[3.jpg]<<<<<<",
  "------[1]------[0.4,0.4,1]", "缺图",
  ">>>>>>[4.jpg]<<<<<<",
  "------[1]------[0.5,0.5,2]", "只有框外",
].join("\n"));
const MATCHES = [
  { image: "1.jpg", file: "1.jpg" }, { image: "1.png", file: "1.png" }, { image: "2.jpg", file: "2.jpg" },
  { image: "3.jpg", file: "" }, { image: "4.jpg", file: "4.jpg" },
];

// Replacements apply, unlabelled pages are skipped, every problem is reported
{
  const plan = buildImportPlan(LP, { matches: MATCHES, rules: [{ from: "...", to: "…" }] });
  assert.deepStrictEqual(plan.pages.map((page) => page.output), ["1.psd", "4.psd"]);
  assert.strictEqual(plan.pages[0].labels[0].text, "你好…");
  assert.deepStrictEqual(plan.skipped, ["2.jpg"]);
  assert.deepStrictEqual(plan.issues.map((issue) => [issue.code, issue.image]), [["outputCollision", "1.png"], ["imageMissing", "3.jpg"]]);
}

// Selected groups and images narrow the plan, and a page left empty is skipped
{
  const plan = buildImportPlan(LP, { matches: MATCHES, selectedGroups: ["框内"], selectedImages: ["1.jpg", "4.jpg"] });
  assert.deepStrictEqual(plan.pages.map((page) => page.image), ["1.jpg"]);
  assert.deepStrictEqual(plan.pages[0].labels.map((label) => label.group), ["框内"]);
  assert.deepStrictEqual(plan.skipped, ["4.jpg"]);
}

// Unlabelled pages can still produce a PSD when asked
{
  const plan = buildImportPlan(LP, { matches: MATCHES, skipEmpty: false, selectedImages: ["2.jpg"] });
  assert.deepStrictEqual(plan.pages.map((page) => page.output), ["2.psd"]);
}

// A replacement that empties a label drops it and says so
{
  const plan = buildImportPlan(LP, { matches: MATCHES, rules: [{ from: "拟声", to: "" }], selectedImages: ["1.jpg"] });
  assert.deepStrictEqual(plan.pages[0].labels.map((label) => label.index), [1]);
  assert.deepStrictEqual(plan.issues.map((issue) => issue.code), ["emptyLabel"]);
}

// The text starts on its label point
{
  const box = { left: 100, top: 200, right: 160, bottom: 500 };
  assert.deepStrictEqual(labelPointOffset(box, { x: 400, y: 300 }, "vertical", 20), { x: 250, y: 100 });
  assert.deepStrictEqual(labelPointOffset(box, { x: 400, y: 300 }, "horizontal", 20), { x: 300, y: 90 });
}

console.log("LabelPlus import plan tests passed");
