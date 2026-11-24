// Live check of the SFX editor's Photoshop side, through the development
// build's channel (uxp-src/host/devChannel.js). Needs Photoshop with the
// "LabelPlus-Nondum DEV" plugin loaded (npm run build:uxp:dev, then UXP
// Developer Tools) and its panel open once. Not part of npm test.
//
//   node scripts/sfxLiveCheck.js            everything
//   node scripts/sfxLiveCheck.js --multi    several layers at once only
//
// Works on documents it creates itself (closed at the end, without saving),
// and on a PSD it saves in the channel folder.
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const layout = require("./helpers/loadAppModule")()("app_src/sfx/layout.js");

const DIR = process.platform === "win32" ? "C:/private/tmp/typer-uxp-dev" : "/private/tmp/typer-uxp-dev";
const DIR_URL = process.platform === "win32" ? "file:/C:/private/tmp/typer-uxp-dev" : "file:/private/tmp/typer-uxp-dev";
let counter = 0;

function run(body, timeoutMs = 60000) {
  const id = "sfx" + Date.now() + "_" + ++counter;
  const result = path.join(DIR, "result-" + id + ".txt");
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, "cmd.js"), id + " host\n" + PRELUDE + body);
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (fs.existsSync(result)) {
        const text = fs.readFileSync(result, "utf8");
        fs.unlinkSync(result);
        if (text.startsWith("ERR ")) reject(new Error(text.slice(4)));
        else resolve(JSON.parse(text));
        return;
      }
      if (Date.now() - started > timeoutMs) return reject(new Error("no answer from Photoshop: is the DEV plugin loaded?"));
      setTimeout(poll, 100);
    };
    poll();
  });
}

// Shared helpers, evaluated before each step inside the plugin host
const PRELUDE = `
const ps = require("photoshop");
const { batchPlay } = ps.action;
const T = globalThis.__typer;
const sfx = T.sfx._internals;
const modal = (fn) => ps.core.executeAsModal(fn, { commandName: "SFX check" });
const play = (d) => batchPlay([d], { synchronousExecution: true })[0];
const doc = () => ps.app.activeDocument;
const historyCount = () => doc().historyStates.length;
const layerList = () => { const out = []; const walk = (ls) => ls.forEach((l) => { out.push({ id: l.id, name: l.name, kind: l.kind, visible: l.visible }); if (l.layers) walk(l.layers); }); walk(doc().layers); return out; };
const bounds = (l) => { const b = l.boundsNoEffects; return [b.left, b.top, b.right, b.bottom]; };
const cjkFont = () => {
  const wanted = ["SourceHanSansSC-Heavy", "SourceHanSansCN-Heavy", "NotoSansSC-Black", "MicrosoftYaHei-Bold", "SimHei", "MicrosoftYaHei", "PingFangSC-Semibold", "STHeitiSC-Medium"];
  for (const name of wanted) { const f = ps.app.fonts.find((x) => x.postScriptName === name); if (f) return f.postScriptName; }
  const f = ps.app.fonts.find((x) => /Hei|Song|Kai|Han|YaHei|Noto Sans (SC|CJK)/i.test(x.name));
  return f ? f.postScriptName : null;
};
const selectIds = (ids) => modal(async () => {
  play({ _obj: "select", _target: [{ _ref: "layer", _id: ids[0] }], makeVisible: false });
  ids.slice(1).forEach((id) => play({ _obj: "select", _target: [{ _ref: "layer", _id: id }], selectionModifier: { _enum: "selectionModifierType", _value: "addToSelection" }, makeVisible: false }));
});
const selectedIds = () => (play({ _obj: "get", _target: [{ _property: "targetLayersIDs" }, { _ref: "document", _enum: "ordinal", _value: "targetEnum" }] }).targetLayersIDs || []).map((r) => r._id).sort((a, b) => a - b);
const layerById = (id) => { let hit = null; const walk = (ls) => ls.forEach((l) => { if (l.id === id) hit = l; if (l.layers) walk(l.layers); }); walk(doc().layers); return hit; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, ms, what) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error("timed out waiting for " + what); await sleep(100); } };
// The real editor window (development builds answer "dev" messages, see uxp-src/sfx/entry.jsx)
const openWindow = async () => {
  globalThis.__sfxEditor = null;
  globalThis.__sfxOpenRun = T.sfx.methods.sfxOpen().then((raw) => (typeof raw === "string" ? JSON.parse(raw) : raw));
  await waitFor(() => globalThis.__sfxEditor && globalThis.__sfxEditor.log.indexOf("ready") >= 0, 120000, "the editor window");
};
const devCall = async (op, ...args) => {
  const e = globalThis.__sfxEditor;
  for (let attempt = 0; attempt < 50; attempt++) {
    const n = e.log.length;
    e.post({ type: "dev", op, args });
    const t = Date.now();
    let hit = null;
    while (!hit && Date.now() - t < 5000) { hit = e.log.slice(n).find((x) => x && typeof x === "object" && x.op === op); if (!hit) await sleep(50); }
    if (hit && !(hit.result && hit.result.error)) return hit.result;
    await sleep(200);
  }
  throw new Error("the editor window did not answer " + op);
};
`;

const near = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) <= tolerance, label + ": expected " + expected + " ±" + tolerance + ", got " + actual);
const log = (...args) => console.log("  ", ...args);
const rounded = (c) => c && { r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b) };

/* 11. Several layers at once: two text layers and a pixel layer selected */
async function checkMulti() {
  const ids = await run(`
    const font = cjkFont();
    if (!font) throw new Error("no Chinese font installed");
    await modal(async () => {
      await ps.app.createDocument({ width: 1600, height: 1200, resolution: 72, fill: "white", mode: "RGBColorMode", name: "SFX check multi" });
      const color = (r, g, b) => { const c = new ps.app.SolidColor(); c.rgb.red = r; c.rgb.green = g; c.rgb.blue = b; return c; };
      const a = await doc().createTextLayer({ contents: "砰砰", fontSize: 120, position: { x: 200, y: 300 }, fontName: font });
      a.textItem.characterStyle.color = color(200, 20, 40);
      a.name = "multi-a";
      a.opacity = 70;
      const b = await doc().createTextLayer({ contents: "咚", fontSize: 160, position: { x: 900, y: 800 }, fontName: font });
      b.textItem.characterStyle.color = color(20, 60, 210);
      b.name = "multi-b";
      await (doc().createPixelLayer ? doc().createPixelLayer({ name: "multi-paper" }) : doc().createLayer({ name: "multi-paper" }));
    });
    const out = {};
    layerList().forEach((l) => { out[l.name] = l.id; });
    return out;
  `);
  const A = ids["multi-a"];
  const B = ids["multi-b"];
  const P = ids["multi-paper"];

  // Reading: one session per text layer, top first; the pixel layer left out
  const read = await run(`
    await selectIds([${A}, ${B}, ${P}]);
    const before = { history: historyCount(), layers: JSON.stringify(layerList()), work: !!sfx.readWorkPath(), selected: selectedIds() };
    const g = await sfx.startGroup();
    globalThis.__sfxMulti = g;
    const init = sfx.editorInit(g, g.notices, null);
    const after = { history: historyCount(), layers: JSON.stringify(layerList()), work: !!sfx.readWorkPath(), selected: selectedIds() };
    return { before, after, sessions: g.sessions.map((s) => ({ mode: s.mode, name: s.layerName, id: s.layerId, text: s.model.text, color: s.model.color })),
      skipped: g.skipped, notices: g.notices, preview: g.preview && { width: g.preview.width, height: g.preview.height }, items: init.items.map((i) => i.layerName), active: init.active };
  `, 180000);
  log("group", JSON.stringify({ sessions: read.sessions.map((s) => s.name + ":" + s.mode), skipped: read.skipped, notices: read.notices }));
  assert.strictEqual(read.before.selected.length, 3, "three layers selected");
  assert.deepStrictEqual(read.sessions.map((s) => s.name), ["multi-b", "multi-a"], "one session per text layer, top first");
  assert.deepStrictEqual(read.sessions.map((s) => s.mode), ["new", "new"]);
  assert.deepStrictEqual(read.skipped, [{ id: P, name: "multi-paper", code: "notText" }], "the pixel layer is left out");
  assert.deepStrictEqual(read.notices[0], { key: "sfxLayerSkipped", layer: "multi-paper", reason: "notText" });
  assert.deepStrictEqual(rounded(read.sessions[0].color), { r: 20, g: 60, b: 210 });
  assert.deepStrictEqual(rounded(read.sessions[1].color), { r: 200, g: 20, b: 40 });
  assert.strictEqual(read.after.layers, read.before.layers, "reading left the layers alone");
  assert.strictEqual(read.after.history, read.before.history, "reading left no history state");
  assert.strictEqual(read.after.work, read.before.work, "reading left the work path alone");
  assert.deepStrictEqual(read.after.selected, read.before.selected, "the selection is kept");
  assert.ok(read.preview && read.preview.width === 1600, "one preview for the group");
  assert.deepStrictEqual(read.items, ["multi-b", "multi-a"], "the window gets both layers");

  // A failure after the first layer: neither layer changes
  const rolled = await run(`
    const g = globalThis.__sfxMulti;
    const before = { history: historyCount(), layers: JSON.stringify(layerList()), work: JSON.stringify(sfx.readWorkPath()) };
    globalThis.__sfxFailAt = "betweenLayers";
    let error = null;
    try { await sfx.applyGroup(g, g.sessions.map((s) => s.model)); } catch (e) { error = String(e.message || e); }
    globalThis.__sfxFailAt = null;
    const after = { history: historyCount(), layers: JSON.stringify(layerList()), work: JSON.stringify(sfx.readWorkPath()) };
    return { error, same: JSON.stringify(before) === JSON.stringify(after), modes: g.sessions.map((s) => s.mode) };
  `, 120000);
  assert.ok(rolled.error && /test failure/.test(rolled.error), "failed on purpose between the layers");
  assert.ok(rolled.same, "rollback between layers: document unchanged");
  assert.deepStrictEqual(rolled.modes, ["new", "new"]);
  log("rollback ok: between layers");

  // Apply: each layer its own model, one history state, both selected after
  const applied = await run(`
    const g = globalThis.__sfxMulti;
    const models = g.sessions.map((s, i) => Object.assign({}, s.model, { rotation: i === 0 ? 15 : -10 }));
    const before = historyCount();
    const done = await sfx.applyGroup(g, models);
    const ids = done.map((d) => d.layerId);
    return { history: historyCount() - before, ids, layers: layerList(), selected: selectedIds(),
      rotations: ids.map((id) => JSON.parse(sfx.readPayloadText(id).text).model.rotation),
      colors: ids.map((id) => sfx.fillColor(id)), opacity: ids.map((id) => layerById(id).opacity), names: ids.map((id) => layerById(id).name) };
  `, 180000);
  log("applied", JSON.stringify({ history: applied.history, names: applied.names, rotations: applied.rotations }));
  assert.strictEqual(applied.history, 1, "several layers: one history state");
  assert.ok(!applied.layers.some((l) => l.name === "multi-a" || l.name === "multi-b"), "both text layers replaced");
  assert.ok(applied.layers.some((l) => l.id === P), "the pixel layer is untouched");
  assert.deepStrictEqual(applied.selected, applied.ids.slice().sort((a, b) => a - b), "both SFX layers selected");
  assert.deepStrictEqual(applied.rotations, [15, -10], "each layer got its own model");
  assert.deepStrictEqual(applied.names, ["咚", "砰砰"]);
  assert.deepStrictEqual(rounded(applied.colors[0]), { r: 20, g: 60, b: 210 });
  assert.deepStrictEqual(rounded(applied.colors[1]), { r: 200, g: 20, b: 40 });
  near(applied.opacity[1], 70, 0.5, "multi-a's opacity is kept");

  const undo = await run(`
    await modal(async () => play({ _obj: "select", _target: [{ _ref: "historyState", _enum: "ordinal", _value: "previous" }] }));
    const afterUndo = layerList();
    await modal(async () => play({ _obj: "select", _target: [{ _ref: "historyState", _enum: "ordinal", _value: "next" }] }));
    return { afterUndo, afterRedo: layerList() };
  `);
  assert.ok(["multi-a", "multi-b"].every((name) => undo.afterUndo.some((l) => l.name === name && l.kind === "text" && l.visible)), "one undo: both text layers back");
  assert.ok(!undo.afterUndo.some((l) => applied.ids.indexOf(l.id) >= 0), "one undo: both SFX layers gone");
  assert.ok(applied.ids.every((id) => undo.afterRedo.some((l) => l.id === id && l.visible)), "redo: both SFX layers back");
  log("several layers: undo / redo ok");

  // The real window, two SFX layers and a new text layer: switch to the
  // second, rotate it, Apply
  const windowApply = await run(`
    await modal(async () => {
      const c = await doc().createTextLayer({ contents: "嘭", fontSize: 100, position: { x: 300, y: 1000 }, fontName: cjkFont() });
      c.name = "multi-c";
    });
    const C = layerList().find((l) => l.name === "multi-c").id;
    await selectIds([${applied.ids[0]}, ${applied.ids[1]}, C]);
    const before = historyCount();
    await openWindow();
    const state = await devCall("state");
    await devCall("switchTo", 1);
    await devCall("rotate", 33);
    const edited = await devCall("state");
    await devCall("apply");
    const result = await globalThis.__sfxOpenRun;
    const ids = result.layerIds || [];
    return { state, edited, result, history: historyCount() - before, C, layers: layerList(),
      rotations: ids.map((id) => JSON.parse(sfx.readPayloadText(id).text).model.rotation), texts: ids.map((id) => JSON.parse(sfx.readPayloadText(id).text).model.text) };
  `, 240000);
  log("window", JSON.stringify({ state: windowApply.state, result: windowApply.result, rotations: windowApply.rotations }));
  assert.strictEqual(windowApply.state.count, 3, "the window opened all three layers");
  assert.deepStrictEqual(windowApply.state.modes.slice().sort(), ["new", "update", "update"], "a text layer and two SFX layers");
  assert.strictEqual(windowApply.edited.active, 1, "switched to the second layer");
  assert.strictEqual(windowApply.result.code, "applied");
  assert.strictEqual(windowApply.history, 1, "window Apply: one history state");
  // Only the layer that was second in the window turned; the others kept theirs
  const expected = { "嘭": 0, "咚": 15, "砰砰": -10 };
  expected[windowApply.edited.texts[1]] = 33;
  const got = {};
  windowApply.texts.forEach((text, i) => { got[text] = windowApply.rotations[i]; });
  assert.deepStrictEqual(got, expected, "each layer written with its own model");
  assert.ok(applied.ids.every((id) => windowApply.result.layerIds.indexOf(id) >= 0), "the SFX layers are updated in place");
  assert.ok(!windowApply.layers.some((l) => l.id === windowApply.C), "the text layer was replaced");
  log("window apply ok");

  // Cancel: every layer as it was
  const windowCancel = await run(`
    await modal(async () => {
      for (const [text, y] of [["哗", 200], ["啦", 500]]) {
        const l = await doc().createTextLayer({ contents: text, fontSize: 90, position: { x: 1200, y }, fontName: cjkFont() });
        l.name = "cancel-" + text;
      }
    });
    const ids = layerList().filter((l) => /^cancel-/.test(l.name)).map((l) => l.id);
    await selectIds(ids.concat([${applied.ids[1]}]));
    const before = { history: historyCount(), layers: JSON.stringify(layerList()), selected: selectedIds() };
    await openWindow();
    const state = await devCall("state");
    await devCall("rotate", 45);
    await devCall("switchTo", 2);
    await devCall("rotate", -45);
    await devCall("cancel");
    const result = await globalThis.__sfxOpenRun;
    const after = { history: historyCount(), layers: JSON.stringify(layerList()), selected: selectedIds() };
    return { state, result, same: JSON.stringify(before) === JSON.stringify(after), before, after };
  `, 240000);
  assert.strictEqual(windowCancel.state.count, 3);
  assert.strictEqual(windowCancel.result.code, "cancel");
  assert.ok(windowCancel.same, "Cancel: document unchanged " + JSON.stringify({ before: windowCancel.before.history, after: windowCancel.after.history }));
  log("window cancel ok");
}

async function main() {
  console.log("Photoshop:", await run(`return { ps: require("uxp").host.version, docs: ps.app.documents.length };`, 8000));
  if (process.argv.includes("--multi")) {
    await checkMulti();
    await run(`await modal(async () => { while (ps.app.documents.length && /SFX check multi/.test(doc().name)) await doc().closeWithoutSaving(); }); return true;`);
    console.log("SFX live check (several layers) passed");
    return;
  }

  /* 1. A 300 dpi manga page, larger than the editor's preview */
  const setup = await run(`
    const font = cjkFont();
    if (!font) throw new Error("no Chinese font installed");
    await modal(async () => {
      await ps.app.createDocument({ width: 2480, height: 3508, resolution: 300, fill: "white", mode: "RGBColorMode", name: "SFX check" });
      const layer = await doc().createTextLayer({ contents: "回器", fontSize: 200, position: { x: 900, y: 1500 }, fontName: font });
      const red = new ps.app.SolidColor(); red.rgb.red = 200; red.rgb.green = 20; red.rgb.blue = 40;
      layer.textItem.characterStyle.color = red;
      layer.name = "source";
      layer.opacity = 60;
    });
    const layer = doc().activeLayers[0];
    return { font, id: layer.id, bounds: bounds(layer), history: historyCount(), layers: layerList().length };
  `);
  log("text layer", setup);

  /* 2. Reading: no change to the document, outlines with holes, units */
  const session = await run(`
    const before = { history: historyCount(), layers: JSON.stringify(layerList()), work: !!sfx.readWorkPath() };
    const s = await sfx.startSession();
    globalThis.__sfxCheckSession = s;
    const after = { history: historyCount(), layers: JSON.stringify(layerList()), work: !!sfx.readWorkPath(), visible: doc().activeLayers[0].visible };
    const subpaths = (ch) => (s.outlines[ch] || []).reduce((n, c) => n + c.paths.length, 0);
    return { mode: s.mode, em: s.model.em, color: s.model.color, debug: s.debug, before, after,
      preview: s.preview && { width: s.preview.width, height: s.preview.height, bytes: s.preview.src.length },
      subpaths: { hui: subpaths("回"), qi: subpaths("器") }, path: s.model.path };
  `, 120000);
  log("session", JSON.stringify({ mode: session.mode, em: session.em, debug: session.debug, preview: session.preview, subpaths: session.subpaths }));
  assert.strictEqual(session.mode, "new");
  assert.deepStrictEqual(session.after.layers, session.before.layers, "reading left the layers alone");
  assert.strictEqual(session.after.history, session.before.history, "reading left no history state");
  assert.strictEqual(session.after.work, session.before.work, "reading left the work path alone");
  assert.strictEqual(session.after.visible, true, "the source is visible again");
  // The em: about the height the characters render at (createTextLayer's
  // fontSize is taken in pixels by Photoshop 27)
  const typedHeight = setup.bounds[3] - setup.bounds[1];
  near(session.em, typedHeight, typedHeight * 0.25, "em close to the rendered height");
  assert.ok(session.subpaths.hui >= 2, "回 keeps its hole");
  assert.ok(session.subpaths.qi >= 5, "器 keeps its holes");
  session.debug.unitCheck.forEach((c) => c.path.forEach((v, i) => near(v, c.layer[i], 3, "path vs layer bounds of " + c.ch)));
  assert.ok(session.preview && session.preview.height === 2400, "preview scaled down to 2400 px");
  assert.deepStrictEqual(rounded(session.color), { r: 200, g: 20, b: 40 });

  /* 3. Apply: one shape layer in place, one history state */
  const applied = await run(`
    const s = globalThis.__sfxCheckSession;
    const before = historyCount();
    const done = await sfx.applySession(s, s.model);
    const layer = doc().activeLayers[0];
    const stored = sfx.readPayloadText(layer.id);
    return { history: historyCount() - before, id: layer.id, kind: layer.kind, name: layer.name, layers: layerList(), bounds: bounds(layer), shape: done.bounds,
      hasMask: !!play({ _obj: "get", _target: [{ _property: "hasVectorMask" }, { _ref: "layer", _id: layer.id }] }).hasVectorMask,
      color: sfx.fillColor(layer.id), stored: stored && stored.where, payloadBytes: stored && stored.text.length, opacity: layer.opacity };
  `, 120000);
  log("applied", JSON.stringify({ history: applied.history, kind: applied.kind, bounds: applied.bounds, shape: applied.shape, stored: applied.stored, payloadBytes: applied.payloadBytes }));
  assert.strictEqual(applied.history, 1, "one history state");
  assert.ok(applied.hasMask, "a vector mask");
  assert.ok(!applied.layers.some((l) => l.name === "source"), "the text layer was replaced");
  const s = applied.shape;
  [s.left, s.top, s.right, s.bottom].forEach((v, i) => near(applied.bounds[i], v, 1.5, "layer bounds = composed shape in document px"));
  // The text stays where it was typed (same centre, ±10% of the em)
  const cx = (setup.bounds[0] + setup.bounds[2]) / 2;
  const cy = (setup.bounds[1] + setup.bounds[3]) / 2;
  near((applied.bounds[0] + applied.bounds[2]) / 2, cx, session.em * 0.1, "same centre x");
  near((applied.bounds[1] + applied.bounds[3]) / 2, cy, session.em * 0.1, "same centre y");
  assert.deepStrictEqual(rounded(applied.color), { r: 200, g: 20, b: 40 });
  near(applied.opacity, 60, 0.5, "the text layer's opacity is kept");

  /* 4. One undo brings the text layer back, redo the shape */
  const undo = await run(`
    await modal(async () => play({ _obj: "select", _target: [{ _ref: "historyState", _enum: "ordinal", _value: "previous" }] }));
    const afterUndo = layerList();
    await modal(async () => play({ _obj: "select", _target: [{ _ref: "historyState", _enum: "ordinal", _value: "next" }] }));
    return { afterUndo, afterRedo: layerList() };
  `);
  assert.ok(undo.afterUndo.some((l) => l.name === "source" && l.kind === "text" && l.visible), "undo: text layer back, visible");
  assert.ok(!undo.afterUndo.some((l) => l.id === applied.id), "undo: shape layer gone");
  assert.ok(undo.afterRedo.some((l) => l.id === applied.id && l.visible), "redo: shape layer back, visible");
  log("undo / redo ok");

  /* 5. Edit again: same layer, new path and per-character settings */
  const updated = await run(`
    await modal(async () => play({ _obj: "select", _target: [{ _ref: "layer", _id: ${applied.id} }] }));
    const s = await sfx.startSession();
    const m = Object.assign({}, s.model, { path: Object.assign({}, s.model.path, { type: "arc", bend: -s.model.em }) });
    m.glyphs = m.glyphs.map((g, i) => i === 1 ? Object.assign({}, g, { rot: 25, scale: 1.3 }) : g);
    const before = historyCount();
    const done = await sfx.applySession(s, m);
    const layer = doc().activeLayers[0];
    return { mode: s.mode, sameId: layer.id === ${applied.id}, history: historyCount() - before, opacity: layer.opacity, bounds: bounds(layer), shape: done.bounds, payload: JSON.parse(sfx.readPayloadText(layer.id).text).model };
  `, 120000);
  assert.strictEqual(updated.mode, "update");
  assert.ok(updated.sameId, "the same shape layer is updated");
  near(updated.opacity, 60, 0.5, "re-edit keeps the opacity");
  assert.strictEqual(updated.history, 1, "one history state");
  assert.strictEqual(updated.payload.path.type, "arc");
  assert.strictEqual(updated.payload.glyphs[1].rot, 25);
  [updated.shape.left, updated.shape.top, updated.shape.right, updated.shape.bottom].forEach((v, i) => near(updated.bounds[i], v, 1.5, "updated bounds"));
  log("re-edit ok");

  /* 6. Moved with the Move tool: the editor follows */
  const moved = await run(`
    await modal(async () => { await doc().activeLayers[0].translate(100, -50); });
    const s = await sfx.startSession();
    return { p0: s.model.path.p0, notices: s.notices };
  `, 120000);
  const was = updated.payload.path.p0;
  near(moved.p0[0], was[0] + 100, 1, "moved x"); near(moved.p0[1], was[1] - 50, 1, "moved y");
  assert.deepStrictEqual(moved.notices, []);
  log("move followed");

  /* 7. Save, close, reopen: the settings come back from the PSD */
  const reopened = await run(`
    const lfs = require("uxp").storage.localFileSystem;
    const folder = await lfs.getEntryWithUrl("${DIR_URL}");
    const file = await folder.createFile("sfx-check.psd", { overwrite: true });
    await modal(async () => { await doc().saveAs.psd(file); await doc().closeWithoutSaving(); });
    await modal(async () => { await ps.app.open(file); });
    const target = layerList().find((l) => l.name === "回器");
    await modal(async () => play({ _obj: "select", _target: [{ _ref: "layer", _id: target.id }] }));
    const s = await sfx.startSession();
    const before = historyCount();
    await sfx.applySession(s, Object.assign({}, s.model, { rotation: 10 }));
    return { mode: s.mode, text: s.model.text, glyph: s.model.glyphs[1], path: s.model.path.type, outlines: Object.keys(s.outlines), history: historyCount() - before };
  `, 180000);
  assert.strictEqual(reopened.mode, "update");
  assert.strictEqual(reopened.text, "回器");
  assert.strictEqual(reopened.glyph.rot, 25);
  assert.strictEqual(reopened.path, "arc");
  assert.deepStrictEqual(reopened.outlines.sort(), ["器", "回"].sort());
  assert.strictEqual(reopened.history, 1);
  log("save / reopen ok");

  /* 8. Failure: the document is left exactly as it was */
  for (const step of ["afterWorkPath", "afterShapeLayer", "afterMetadata", "beforeRestore"]) {
    const rolled = await run(`
      await modal(async () => {
        const layer = await doc().createTextLayer({ contents: "咔嚓", fontSize: 36, position: { x: 300, y: 600 }, fontName: cjkFont() });
        layer.name = "fail-${step}";
      });
      // A work path of the user's, which must survive
      await modal(async () => {
        await doc().selection.selectRectangle({ left: 10, top: 10, right: 200, bottom: 120 });
        play({ _obj: "make", _target: [{ _ref: "path" }], from: { _ref: "channel", _property: "selection" }, tolerance: { _unit: "pixelsUnit", _value: 2 } });
        await doc().selection.deselect();
      });
      const textId = doc().layers.find((l) => l.name === "fail-${step}").id;
      await modal(async () => play({ _obj: "select", _target: [{ _ref: "layer", _id: textId }] }));
      const s = await sfx.startSession();
      const before = { history: historyCount(), layers: JSON.stringify(layerList()), work: JSON.stringify(sfx.readWorkPath()) };
      globalThis.__sfxFailAt = "${step}";
      let error = null;
      try { await sfx.applySession(s, s.model); } catch (e) { error = String(e.message || e); }
      globalThis.__sfxFailAt = null;
      const after = { history: historyCount(), layers: JSON.stringify(layerList()), work: JSON.stringify(sfx.readWorkPath()) };
      return { error, same: JSON.stringify(before) === JSON.stringify(after), before: before.history, after: after.history };
    `, 120000);
    assert.ok(rolled.error && /test failure/.test(rolled.error), step + ": failed on purpose");
    assert.ok(rolled.same, step + ": document unchanged " + JSON.stringify(rolled));
    log("rollback ok:", step);
  }
  // Update mode failure
  const rolledUpdate = await run(`
    const target = layerList().find((l) => l.name === "回器");
    await modal(async () => play({ _obj: "select", _target: [{ _ref: "layer", _id: target.id }] }));
    const s = await sfx.startSession();
    const mask = JSON.stringify(sfx.readVectorMask(target.id));
    const before = { history: historyCount(), layers: JSON.stringify(layerList()), xmp: sfx.readLayerXmp(target.id) };
    globalThis.__sfxFailAt = "afterShapeUpdate";
    let error = null;
    try { await sfx.applySession(s, Object.assign({}, s.model, { scale: 2 })); } catch (e) { error = String(e.message || e); }
    globalThis.__sfxFailAt = null;
    const after = { history: historyCount(), layers: JSON.stringify(layerList()), xmp: sfx.readLayerXmp(target.id) };
    return { error, same: JSON.stringify(before) === JSON.stringify(after) && mask === JSON.stringify(sfx.readVectorMask(target.id)) };
  `, 120000);
  assert.ok(rolledUpdate.error && rolledUpdate.same, "update rollback " + JSON.stringify(rolledUpdate));
  log("rollback ok: update");

  /* 9. Faux bold: Photoshop makes no path from it; the SFX is read without it */
  const faux = await run(`
    const TL = { _ref: "layer", _enum: "ordinal", _value: "targetEnum" };
    await modal(async () => {
      await doc().createTextLayer({ contents: "轰隆", fontSize: 120, position: { x: 300, y: 900 }, fontName: cjkFont() });
      const tk = play({ _obj: "get", _target: [{ _property: "textKey" }, TL] }).textKey;
      const range = Object.assign({}, tk.textStyleRange[0]);
      range.textStyle = Object.assign({}, range.textStyle, { syntheticBold: true });
      play({ _obj: "set", _target: [TL], to: { _obj: "textLayer", textKey: tk.textKey, textStyleRange: [range], antiAlias: tk.antiAlias } });
    });
    const s = await sfx.startSession();
    const before = historyCount();
    await sfx.applySession(s, s.model);
    return { notices: s.notices, inked: Object.keys(s.outlines).filter((ch) => s.outlines[ch].length).length, history: historyCount() - before };
  `, 120000);
  assert.deepStrictEqual(faux.notices, ["sfxFauxBoldIgnored"], "faux bold notice");
  assert.strictEqual(faux.inked, 2, "faux bold text has outlines");
  assert.strictEqual(faux.history, 1);
  log("faux bold ok");

  /* 10. Bézier path: a local bend pulled into an S, then a bend at a
     selection; stored, re-read, undone, moved and saved as it was made */
  const start = await run(`
    await modal(async () => {
      const layer = await doc().createTextLayer({ contents: "轰隆咔嚓", fontSize: 150, position: { x: 600, y: 2400 }, fontName: cjkFont() });
      layer.name = "bezier";
    });
    const s = await sfx.startSession();
    globalThis.__sfxBezierSession = s;
    return { model: s.model };
  `, 120000);
  const em = start.model.em;
  let curved = layout.bendStretch(start.model, [1, 2], [0, -0.8 * em]);
  const [segment] = layout.handleSegments(curved, null, [1, 2]);
  const hOut = layout.handlePoint(curved.path, segment, "o");
  const hIn = layout.handlePoint(curved.path, segment + 1, "i");
  curved = layout.moveHandle(curved, segment, "o", [hOut[0], hOut[1] + 1.4 * em]);
  curved = layout.moveHandle(curved, segment + 1, "i", [hIn[0], hIn[1] - 1.0 * em]);
  const tip = layout.pathEnds(curved.path)[1];
  curved = layout.bendAtSelection(curved, [3], 1, [tip[0] + 0.4 * em, tip[1] + 0.9 * em]);
  assert.strictEqual(curved.path.type, "bezier");
  const bezApplied = await run(`
    const s = globalThis.__sfxBezierSession;
    const before = historyCount();
    const done = await sfx.applySession(s, ${JSON.stringify(curved)});
    const layer = doc().activeLayers[0];
    const again = await sfx.startSession();
    return { id: layer.id, history: historyCount() - before, bounds: bounds(layer), shape: done.bounds,
      payload: JSON.parse(sfx.readPayloadText(layer.id).text).model.path, reread: { mode: again.mode, notices: again.notices, path: again.model.path } };
  `, 120000);
  assert.strictEqual(bezApplied.history, 1, "Bézier: one history state");
  [bezApplied.shape.left, bezApplied.shape.top, bezApplied.shape.right, bezApplied.shape.bottom].forEach((v, i) => near(bezApplied.bounds[i], v, 1.5, "Bézier: layer bounds = composed shape"));
  assert.deepStrictEqual(bezApplied.payload, curved.path, "Bézier: path stored as made");
  assert.strictEqual(bezApplied.reread.mode, "update");
  assert.deepStrictEqual(bezApplied.reread.notices, [], "Bézier: the vector mask matches the stored settings");
  assert.deepStrictEqual(bezApplied.reread.path, curved.path, "Bézier: path read back");
  const bezUndo = await run(`
    await modal(async () => play({ _obj: "select", _target: [{ _ref: "historyState", _enum: "ordinal", _value: "previous" }] }));
    const afterUndo = layerList();
    await modal(async () => play({ _obj: "select", _target: [{ _ref: "historyState", _enum: "ordinal", _value: "next" }] }));
    return { afterUndo, afterRedo: layerList() };
  `);
  assert.ok(bezUndo.afterUndo.some((l) => l.name === "bezier" && l.kind === "text" && l.visible), "Bézier undo: text layer back, visible");
  assert.ok(bezUndo.afterRedo.some((l) => l.id === bezApplied.id && l.visible), "Bézier redo (after re-reading it): shape layer back, visible");
  const bezMoved = await run(`
    await modal(async () => play({ _obj: "select", _target: [{ _ref: "layer", _id: ${bezApplied.id} }] }));
    await modal(async () => { await doc().activeLayers[0].translate(80, 40); });
    const lfs = require("uxp").storage.localFileSystem;
    const folder = await lfs.getEntryWithUrl("${DIR_URL}");
    const file = await folder.createFile("sfx-bezier.psd", { overwrite: true });
    await modal(async () => { await doc().saveAs.psd(file); await doc().closeWithoutSaving(); });
    await modal(async () => { await ps.app.open(file); });
    const target = layerList().find((l) => l.id === ${bezApplied.id}) || layerList().find((l) => l.name === "轰隆咔嚓");
    await modal(async () => play({ _obj: "select", _target: [{ _ref: "layer", _id: target.id }] }));
    const s = await sfx.startSession();
    return { mode: s.mode, notices: s.notices, path: s.model.path };
  `, 180000);
  assert.strictEqual(bezMoved.mode, "update");
  assert.deepStrictEqual(bezMoved.notices, [], "Bézier: no hand-edit notice after a move");
  assert.strictEqual(bezMoved.path.nodes.length, curved.path.nodes.length);
  bezMoved.path.nodes.forEach((n, i) => ["p", "i", "o"].forEach((key) => {
    const was = curved.path.nodes[i][key];
    if (!was) return assert.strictEqual(n[key], null, "Bézier: missing handle stays missing");
    near(n[key][0], was[0] + 80, 1, "Bézier moved x"); near(n[key][1], was[1] + 40, 1, "Bézier moved y");
  }));
  log("Bézier ok:", curved.path.nodes.length, "anchors, S curve and bend stored, re-read, undone, moved, saved");

  await checkMulti();

  await run(`await modal(async () => { while (ps.app.documents.length && /SFX check|sfx-check|sfx-bezier/.test(doc().name)) await doc().closeWithoutSaving(); }); return true;`);
  console.log("SFX live check passed");
}

main().catch((error) => {
  console.error("SFX live check FAILED:", error.message);
  process.exit(1);
});
