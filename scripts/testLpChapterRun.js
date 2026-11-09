// Whole chapters against a stubbed host (app_src/labelplus/chapterRun.js) and
// what a style may change on a LabelPlus layer (stylePayload.js). No Photoshop.
const assert = require("assert");
const load = require("./helpers/loadAppModule")();
const { joinPath, dirnameOf, groupIssues, parseSidecar, readSidecar, runImport, runProcess, SIDECAR_NAME } = load("app_src/labelplus/chapterRun.js");
const { lookOnlyStyle, newLayerProps } = load("app_src/labelplus/stylePayload.js");

const makeHost = (answers) => {
  const calls = [];
  return {
    calls,
    call: async (name, ...args) => {
      calls.push({ name, args });
      const answer = answers[name];
      return typeof answer === "function" ? answer(...args) : answer;
    },
  };
};

const STYLE = {
  id: "s1",
  name: "对白",
  stroke: { enabled: false },
  textProps: {
    layerText: {
      orientation: "horizontal",
      textKey: "old",
      textShape: [{ textType: "box" }],
      textClickPoint: { horizontal: 1, vertical: 2 },
      antiAlias: "antiAliasSmooth",
      textStyleRange: [{ from: 0, to: 3, textStyle: { fontPostScriptName: "SourceHanSans", size: 20 } }, { from: 3, to: 5, textStyle: {} }],
      paragraphStyleRange: [{ from: 0, to: 3, paragraphStyle: { alignment: "center" } }],
    },
  },
};

// A style changes the look, never the direction or shape of a layer
{
  const look = lookOnlyStyle(STYLE).textProps.layerText;
  ["orientation", "textKey", "textShape", "textClickPoint"].forEach((key) => assert.ok(!(key in look), key));
  assert.strictEqual(look.textStyleRange.length, 1);
  assert.strictEqual(look.antiAlias, "antiAliasSmooth");
  assert.strictEqual(STYLE.textProps.layerText.orientation, "horizontal", "the stored style is untouched");
}

// A new layer is built vertical whatever the style says
{
  const layerText = newLayerProps(STYLE, "第一行\r第二", "vertical", 800, 1200).layerText;
  assert.strictEqual(layerText.textKey, "第一行\r第二");
  assert.strictEqual(layerText.orientation, "vertical");
  assert.strictEqual(layerText.textShape[0].orientation, "vertical");
  assert.deepStrictEqual(layerText.textShape[0].bounds, { top: 0, left: 0, right: 800, bottom: 1200 });
  assert.strictEqual(layerText.textStyleRange[0].to, 6);
  assert.strictEqual(layerText.paragraphStyleRange[0].to, 6);
}

// Paths
assert.strictEqual(joinPath("C:\\a\\b\\", "c.psd"), "C:\\a\\b\\c.psd");
assert.strictEqual(joinPath("/a/b", "c.psd"), "/a/b/c.psd");
assert.strictEqual(dirnameOf("C:\\a\\b\\t.txt"), "C:\\a\\b");

// Group problems are reported once, by group
{
  const rules = { 框内: { styleId: "s1" }, 框外: { styleId: null }, 其他: { styleId: "gone" } };
  const issues = groupIssues(["框内", "框外", "其他"], rules, [STYLE], new Set(["Arial"]));
  assert.deepStrictEqual(issues.map((issue) => [issue.code, issue.group]), [["missingFont", "框内"], ["noStyle", "框外"], ["styleGone", "其他"]]);
  assert.deepStrictEqual(groupIssues(["框内"], rules, [STYLE], new Set(["SourceHanSans"])), []);
}

const PLAN = {
  pages: [
    { image: "1.jpg", file: "1.jpg", output: "1.psd", labels: [{ index: 1, x: 0.1, y: 0.2, group: "框内", text: "你好" }] },
    { image: "2.jpg", file: "2.jpg", output: "2.psd", labels: [{ index: 1, x: 0.3, y: 0.4, group: "框外", text: "嘭" }] },
    { image: "3.jpg", file: "3.jpg", output: "3.psd", labels: [{ index: 1, x: 0.5, y: 0.6, group: "框内", text: "再见" }] },
  ],
};
const importOptions = (host, extra) => Object.assign({
  plan: PLAN,
  groups: ["框内", "框外"],
  sourceFolder: "C:\\src",
  outputFolder: "C:\\out",
  rules: { 框内: { styleId: "s1", center: true, clean: true }, 框外: { styleId: null, center: false } },
  styles: [STYLE],
  orientation: "vertical",
  host,
}, extra);

// A failed page does not stop the chapter; layer problems reach the checklist
(async () => {
  const host = makeHost({
    lpImportPage: (data) => {
      if (data.source.endsWith("2.jpg")) return { ok: false, code: "documentOpen" };
      return { ok: true, layers: [{ layerId: 7, index: 1, x: data.labels[0].x, y: data.labels[0].y, group: data.labels[0].group }], issues: data.source.endsWith("3.jpg") ? [{ code: "orientation", index: 1 }] : [] };
    },
    lpWriteText: { ok: true },
  });
  const progress = [];
  const run = await runImport(importOptions(host, { onProgress: (step) => progress.push(step.name), previous: { pages: { "9.psd": { image: "9.jpg", layers: [] } } } }));
  assert.strictEqual(run.done, 2);
  assert.deepStrictEqual(progress, ["1.psd", "2.psd", "3.psd"]);
  assert.deepStrictEqual(run.checklist.map((issue) => [issue.page, issue.code]), [["2.psd", "documentOpen"], ["3.psd", "orientation"]]);
  const first = host.calls.find((call) => call.name === "lpImportPage").args[0];
  assert.strictEqual(first.source, "C:\\src\\1.jpg");
  assert.strictEqual(first.output, "C:\\out\\1.psd");
  assert.strictEqual(first.orientation, "vertical");
  assert.strictEqual(first.labels[0].style.id, "s1");
  // Generating PSDs only places the text; the processing run centres and whitens
  assert.strictEqual(first.labels[0].center, false);
  assert.strictEqual(first.labels[0].clean, false);
  const whitening = makeHost({ lpImportPage: { ok: true, layers: [], issues: [], cleaned: 2, centred: 1 }, lpWriteText: { ok: true } });
  const whitened = await runImport(importOptions(whitening, { center: true }));
  const labelsOf = (index) => whitening.calls.filter((call) => call.name === "lpImportPage")[index].args[0].labels[0];
  assert.deepStrictEqual([labelsOf(0).center, labelsOf(0).clean], [true, true]);
  assert.deepStrictEqual([labelsOf(1).center, labelsOf(1).clean], [false, false], "a group without the options");
  assert.strictEqual(whitened.stats.cleaned, 6);
  // Pages of an earlier run stay, the failed page has no entry
  assert.deepStrictEqual(Object.keys(run.sidecar.pages).sort(), ["1.psd", "3.psd", "9.psd"]);
  // Saved after every finished page, not once at the end
  const writes = host.calls.filter((call) => call.name === "lpWriteText");
  assert.strictEqual(writes.length, 2);
  assert.strictEqual(writes[0].args[0], "C:\\out\\" + SIDECAR_NAME);
  assert.ok(parseSidecar(writes[1].args[1]));

  // Stopping keeps what is done
  let imported = 0;
  const stopHost = makeHost({ lpImportPage: () => { imported++; return { ok: true, layers: [], issues: [] }; }, lpWriteText: { ok: true } });
  const stopped = await runImport(importOptions(stopHost, { isCancelled: () => imported >= 1 }));
  assert.strictEqual(stopped.done, 1);
  assert.strictEqual(stopped.cancelled, true);

  // A failed sidecar write is said, because centring depends on it
  const noWrite = makeHost({ lpImportPage: { ok: true, layers: [], issues: [] }, lpWriteText: { ok: false, message: "denied" } });
  const unsaved = await runImport(importOptions(noWrite, { plan: { pages: [PLAN.pages[0]] } }));
  assert.deepStrictEqual(unsaved.checklist.map((issue) => issue.code), ["sidecarWrite"]);

  // Processing: label points from the sidecar, rules by group, styles resolved
  const processHost = makeHost({
    lpProcessPage: (data) => (data.path.endsWith("b.psd") ? { ok: false, code: "documentOpen" } : { ok: true, issues: [{ code: "noBubble", index: 3 }] }),
  });
  const sidecar = { pages: { "a.psd": { layers: [{ layerId: 1, index: 3, x: 0.5, y: 0.5, group: "框内" }] } } };
  const processed = await runProcess({
    folder: "C:\\out",
    psdFiles: ["a.psd", "b.psd", "c.psd"],
    sidecar,
    rules: { 框内: { styleId: "s1", center: true }, 框外: { styleId: null, center: false } },
    styles: [STYLE],
    applyStyle: true,
    center: true,
    host: processHost,
  });
  assert.strictEqual(processed.done, 2);
  assert.deepStrictEqual(processed.checklist.map((issue) => [issue.page, issue.code]), [
    ["a.psd", "noBubble"], ["b.psd", "noLabelData"], ["b.psd", "documentOpen"], ["c.psd", "noLabelData"], ["c.psd", "noBubble"],
  ]);
  const payload = processHost.calls[0].args[0];
  assert.strictEqual(payload.path, "C:\\out\\a.psd");
  assert.strictEqual(payload.rules.框内.style.id, "s1");
  assert.strictEqual(payload.rules.框外.style, null);
  assert.strictEqual(payload.rules.框外.center, false);
  assert.strictEqual(payload.rules.框外.clean, false);
  assert.strictEqual(payload.labels[0].layerId, 1);
  assert.strictEqual(payload.applyStyle, true);

  // Sidecars: wrong or foreign files read as none
  assert.strictEqual(parseSidecar("not json"), null);
  assert.strictEqual(parseSidecar('{"version":99,"pages":{}}'), null);
  assert.strictEqual(await readSidecar(makeHost({ lpReadText: { ok: false } }), "C:\\out"), null);
  assert.ok(await readSidecar(makeHost({ lpReadText: { ok: true, text: '{"version":1,"pages":{}}' } }), "C:\\out"));

  console.log("LabelPlus chapter run tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
