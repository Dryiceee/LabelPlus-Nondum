// Live check of the ruby (行间注) editor's Photoshop side, through the
// development build's channel (uxp-src/host/devChannel.js). Needs Photoshop
// with the "LabelPlus-Nondum DEV" plugin loaded (npm run build:uxp:dev, then
// UXP Developer Tools) and its panel open once. Not part of npm test.
//
//   node scripts/rubyLiveCheck.js            everything
//   node scripts/rubyLiveCheck.js --window   the real editor window only
//   node scripts/rubyLiveCheck.js --distribute | --second | --scaled   one part only
//
// Works on documents it creates itself (closed at the end, without saving),
// and on a PSD it saves in the channel folder.
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const DIR = process.platform === "win32" ? "C:/private/tmp/typer-uxp-dev" : "/private/tmp/typer-uxp-dev";
const DIR_URL = process.platform === "win32" ? "file:/C:/private/tmp/typer-uxp-dev" : "file:/private/tmp/typer-uxp-dev";
let counter = 0;

function run(body, timeoutMs = 60000) {
  const id = "ruby" + Date.now() + "_" + ++counter;
  const result = path.join(DIR, "result-" + id + ".txt");
  fs.mkdirSync(DIR, { recursive: true });
  // One write: the channel polls cmd.js and must never see half a command
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

const PRELUDE = `
const ps = require("photoshop");
const { batchPlay } = ps.action;
const T = globalThis.__typer;
if (!T.ruby) throw new Error("the DEV plugin has no ruby editor: reload it in UXP Developer Tools");
const R = T.ruby._internals;
const host = T.photoshop._internals;
// A plugin loaded before uxp-src/host/ruby.js stopped using it (live patch)
if (!host._setLayerText) host._setLayerText = (t) => batchPlay([{ _obj: "set", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }], to: host.jamText.toLayerTextObject(t) }], { synchronousExecution: true });
const modal = (fn) => ps.core.executeAsModal(fn, { commandName: "Ruby check" });
const play = (d) => batchPlay([d], { synchronousExecution: true })[0];
const doc = () => ps.app.activeDocument;
const historyCount = () => doc().historyStates.length;
const layerList = () => { const out = []; const walk = (ls, parent) => ls.forEach((l) => { out.push({ id: l.id, name: l.name, kind: l.kind, parent }); if (l.layers) walk(l.layers, l.id); }); walk(doc().layers, null); return out; };
const byName = (name) => layerList().find((l) => l.name === name);
const bounds = (id) => R.layerBounds(id);
const select = (id) => modal(async () => play({ _obj: "select", _target: [{ _ref: "layer", _id: id }], makeVisible: false }));
const cjkFont = () => {
  const wanted = ["SourceHanSansSC-Regular", "SourceHanSansCN-Regular", "SourceHanSansCN-Heavy", "NotoSansSC-Regular", "MicrosoftYaHei", "SimHei"];
  for (const name of wanted) { const f = ps.app.fonts.find((x) => x.postScriptName === name); if (f) return f.postScriptName; }
  const f = ps.app.fonts.find((x) => /Hei|Song|Han|YaHei|Noto Sans (SC|CJK)/i.test(x.name));
  return f ? f.postScriptName : null;
};
const trackingOf = (id) => {
  const tk = play({ _obj: "get", _target: [{ _property: "textKey" }, { _ref: "layer", _id: id }] }).textKey;
  return tk.textStyleRange.map((r) => ({ from: r.from, to: r.to, tracking: r.textStyle.tracking || 0 }));
};
const textOf = (id) => play({ _obj: "get", _target: [{ _property: "textKey" }, { _ref: "layer", _id: id }] }).textKey.textKey;
const notesOf = (groupId) => layerList().filter((l) => l.parent === groupId && R.readNote(l.id)).map((l) => ({ id: l.id, name: l.name, bounds: bounds(l.id), payload: R.readNote(l.id).payload }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Where the characters of a text layer are now, measured and rolled back
const measureNow = (id) => ps.core.executeAsModal(async (context) => {
  const sid = await context.hostControl.suspendHistory({ documentID: doc().id, name: "Ruby check measure" });
  try {
    return (await R.measureBase({ resolution: Number(doc().resolution) || 72 }, id, [])).glyphs;
  } finally {
    await context.hostControl.resumeHistory(sid, false);
  }
}, { commandName: "Ruby check" });
const waitFor = async (cond, ms, what) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error("timed out waiting for " + what); await sleep(100); } };
const devCall = async (op, ...args) => {
  const e = globalThis.__rubyEditor;
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
// Checks that report and carry on, so one run finds every problem
const failures = [];
const soft = (label, fn) => {
  try {
    fn();
  } catch (error) {
    failures.push(label + ": " + error.message);
    console.log("   FAIL", label, error.message);
  }
};

// The span of glyphs [start, end) along the reading direction, from a session
function spanOf(glyphs, start, end, vertical) {
  const boxes = glyphs.slice(start, end).map((g) => g.box).filter(Boolean);
  const lo = Math.min(...boxes.map((b) => (vertical ? b.top : b.left)));
  const hi = Math.max(...boxes.map((b) => (vertical ? b.bottom : b.right)));
  const cross = boxes.reduce((s, b) => s + (vertical ? (b.left + b.right) / 2 : (b.top + b.bottom) / 2), 0) / boxes.length;
  return { lo, hi, center: (lo + hi) / 2, cross };
}

async function setupDocument() {
  return run(`
    const font = cjkFont();
    if (!font) throw new Error("no Chinese font installed");
    await modal(async () => {
      await ps.app.createDocument({ width: 2000, height: 1600, resolution: 72, fill: "white", mode: "RGBColorMode", name: "Ruby check" });
      const v = await doc().createTextLayer({ contents: "今天天气真好\\r第二列文字", fontSize: 100, position: { x: 1500, y: 150 }, fontName: font });
      v.textItem.orientation = "vertical";
      v.name = "vertical";
      const h = await doc().createTextLayer({ contents: "横排文字测试", fontSize: 80, position: { x: 150, y: 1300 }, fontName: font });
      h.name = "horizontal";
      const p = await doc().createTextLayer({ contents: "段落", fontSize: 60, position: { x: 150, y: 600 }, fontName: font });
      p.name = "paragraph";
      p.textItem.convertToParagraphText();
      const r = await doc().createTextLayer({ contents: "旋转", fontSize: 60, position: { x: 500, y: 600 }, fontName: font });
      r.name = "rotated";
      await r.rotate(20);
    });
    return { font, layers: layerList() };
  `, 120000);
}

async function checkVertical() {
  /* 1. Reading: glyphs per character, nothing changed */
  const read = await run(`
    const base = byName("vertical");
    await select(base.id);
    const before = { history: historyCount(), layers: JSON.stringify(layerList()) };
    const s = await R.startSession();
    globalThis.__rubySession = s;
    const init = R.editorInit(s, s.notices, null);
    return { base: base.id, before, after: { history: historyCount(), layers: JSON.stringify(layerList()) },
      vertical: s.measured.vertical, glyphs: s.measured.glyphs, ems: s.measured.ems, preview: !!s.preview, font: s.font, initGlyphs: init.glyphs.length, mode: init.mode };
  `, 120000);
  assert.strictEqual(read.vertical, true);
  assert.strictEqual(read.glyphs.length, 12, "one entry per character");
  assert.strictEqual(read.glyphs.filter((g) => g.box).length, 11, "a box for every character but the line break");
  assert.strictEqual(read.glyphs[6].box, null);
  near(read.ems[0], 100, 0.5, "em in px");
  assert.ok(read.preview, "page preview");
  assert.strictEqual(read.mode, "new");
  assert.strictEqual(read.after.history, read.before.history, "reading left no history state");
  assert.strictEqual(read.after.layers, read.before.layers, "reading left the layers alone");
  const col1 = spanOf(read.glyphs, 0, 6, true);
  const col2 = spanOf(read.glyphs, 7, 12, true);
  assert.ok(col2.cross < col1.cross - 50, "the second column is left of the first");
  log("read", JSON.stringify({ glyphs: read.glyphs.length, col1: Math.round(col1.cross), col2: Math.round(col2.cross), font: read.font.name }));

  /* 2. Apply three notes: fits, shrinks, spreads the base */
  const notes = [
    { id: "a", start: 2, end: 4, text: "晴朗" },
    { id: "b", start: 0, end: 1, text: "很长的注释文" },
    { id: "c", start: 7, end: 9, text: "撑开很长的注释", overflow: "spread" },
  ];
  const applied = await run(`
    const s = globalThis.__rubySession;
    const before = historyCount();
    const done = await R.applyNotes(s, ${JSON.stringify(notes)});
    return { done, history: historyCount() - before, layers: layerList(), notes: notesOf(done.groupId), tracking: trackingOf(${read.base}),
      baseBounds: bounds(${read.base}), baseParent: layerList().find((l) => l.id === ${read.base}).parent };
  `, 180000);
  assert.strictEqual(applied.history, 1, "one undo step");
  assert.ok(applied.done.groupId, "a group");
  assert.strictEqual(applied.baseParent, applied.done.groupId, "the base is in the group");
  assert.strictEqual(applied.notes.length, 3, "three note layers in the group");
  const note = (text) => applied.notes.find((n) => n.payload.note.text === text);
  // Base tracking: 第 and 二 spaced out (no character before 第 in its column)
  const spread = applied.tracking.filter((r) => r.tracking > 0);
  log("tracking", JSON.stringify(applied.tracking));
  assert.ok(spread.length >= 1 && spread.every((r) => r.from >= 7 && r.to <= 9), "only the spread note's characters got tracking");
  assert.deepStrictEqual(note("撑开很长的注释").payload.deltas.map((d) => d.index), [7, 8]);

  // Re-read the base to know where the characters are now
  const now = await run(`await select(${read.base}); const s = await R.startSession(); globalThis.__rubySession = s; return { glyphs: s.measured.glyphs, notes: s.notes, notices: s.notices, mode: R.editorInit(s, [], null).mode };`, 120000);
  assert.strictEqual(now.mode, "update", "the base of a ruby group opens its notes");
  assert.deepStrictEqual(now.notes.map((n) => [n.start, n.end, n.text]).sort(), notes.map((n) => [n.start, n.end, n.text]).sort(), "notes read back from the layers");
  const a = note("晴朗").bounds;
  const sa = spanOf(now.glyphs, 2, 4, true);
  log("note a", JSON.stringify(a), "span", JSON.stringify(sa));
  near((a.top + a.bottom) / 2, sa.center, 4, "centred on its characters");
  assert.ok(a.left >= sa.cross + 40 && a.left <= sa.cross + 60, "right of the column: left " + a.left + ", column centre " + sa.cross);
  near(a.right - a.left, 50 * 0.9, 8, "half size");
  const b = note("很长的注释文").bounds;
  const sb = spanOf(now.glyphs, 0, 1, true);
  assert.ok(b.bottom - b.top <= 100 + 2, "the long note shrank to its character's length: " + (b.bottom - b.top));
  assert.ok(b.right - b.left < 30, "and its size with it");
  near((b.top + b.bottom) / 2, sb.center, 6, "still centred");
  const c = note("撑开很长的注释").bounds;
  // The base as it is (spaced out): 第 starts its column, so all the room
  // went after the characters, and the note starts with 第
  const real = await run(`return await measureNow(${read.base});`, 120000);
  const second = real[8].box;
  const first = real[7].box;
  const trail = (applied.tracking.find((r) => r.from <= 8 && r.to > 8).tracking / 1000) * 100;
  const slotStart = (first.top + first.bottom) / 2 - 50;
  const slotEnd = (second.top + second.bottom) / 2 + 50 + trail;
  log("spread", JSON.stringify({ note: c, slotStart, slotEnd, trail }));
  soft("spread size", () => assert.ok(c.bottom - c.top > 250, "the spread note keeps its size: " + (c.bottom - c.top)));
  soft("spread centre", () => near((c.top + c.bottom) / 2, (slotStart + slotEnd) / 2, 6, "centred on the spaced-out characters and their room"));
  soft("spread length", () => near(slotEnd - slotStart, c.bottom - c.top, 20, "the characters grew to the note's length"));
  const groupId = applied.done.groupId;

  /* 3. Undo / redo */
  const undo = await run(`
    await modal(async () => play({ _obj: "select", _target: [{ _ref: "historyState", _enum: "ordinal", _value: "previous" }] }));
    const afterUndo = { layers: layerList().length, tracking: trackingOf(${read.base}), group: !!layerList().find((l) => l.id === ${groupId}) };
    await modal(async () => play({ _obj: "select", _target: [{ _ref: "historyState", _enum: "ordinal", _value: "next" }] }));
    return { afterUndo, afterRedo: { group: !!layerList().find((l) => l.id === ${groupId}), notes: notesOf(${groupId}).length } };
  `);
  assert.strictEqual(undo.afterUndo.group, false, "undo removes the group");
  assert.ok(undo.afterUndo.tracking.every((r) => r.tracking === 0), "and the base tracking");
  assert.strictEqual(undo.afterRedo.notes, 3, "redo brings it all back");
  log("undo/redo ok");

  /* 4. Move the base, re-align from the group: notes follow, tracking not doubled */
  const moved = await run(`
    await select(${read.base});
    await modal(async () => host._moveLayer(-200, 120));
    await select(${groupId});
    const s = await R.startSession();
    const before = notesOf(${groupId}).map((n) => n.payload.note.text);
    const done = await R.applyNotes(s, s.notes);
    return { done, notes: notesOf(done.groupId), tracking: trackingOf(${read.base}), before };
  `, 180000);
  const a2 = moved.notes.find((n) => n.payload.note.text === "晴朗").bounds;
  near(a2.left - a.left, -200, 3, "re-aligned after a move (x)");
  near(a2.top - a.top, 120, 3, "re-aligned after a move (y)");
  assert.deepStrictEqual(moved.tracking, applied.tracking, "the spread tracking is not added twice");
  assert.strictEqual(moved.done.groupId, groupId, "the same group");
  log("re-align after move ok");

  /* 5. Edit the base text: the notes find their characters again */
  const edited = await run(`
    await select(${read.base});
    await modal(async () => {
      const t = host._getLayerText();
      const lt = t.layerText;
      lt.textKey = "啊" + lt.textKey;
      lt.textStyleRange = lt.textStyleRange.map((r, i) => Object.assign({}, r, { from: i === 0 ? 0 : r.from + 1, to: r.to + 1 }));
      if (lt.paragraphStyleRange) lt.paragraphStyleRange = lt.paragraphStyleRange.map((r, i) => Object.assign({}, r, { from: i === 0 ? 0 : r.from + 1, to: r.to + 1 }));
      play({ _obj: "set", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }], to: host.jamText.toLayerTextObject(t) });
    });
    const s = await R.startSession();
    const done = await R.applyNotes(s, s.notes);
    return { notes: s.notes.map((n) => [n.start, n.end, n.text, n.lost]), notices: s.notices, after: notesOf(done.groupId).map((n) => [n.payload.note.start, n.payload.note.text]), text: textOf(${read.base}), tracking: trackingOf(${read.base}) };
  `, 180000);
  log("edited", JSON.stringify(edited));
  assert.deepStrictEqual(edited.notices, ["rubyNoteMoved"], "told once that the notes moved");
  assert.deepStrictEqual(edited.notes.map((n) => n[0]).sort((x, y) => x - y), [1, 3, 8], "every note one character later");
  assert.ok(edited.tracking.filter((r) => r.tracking > 0).every((r) => r.from >= 8 && r.to <= 10), "the spread tracking moved with its characters");
  return { base: read.base, groupId };
}

async function checkHorizontalAndRefusals() {
  const out = await run(`
    const h = byName("horizontal");
    await select(h.id);
    const s = await R.startSession();
    const done = await R.applyNotes(s, [{ start: 0, end: 2, text: "注释" }]);
    const n = notesOf(done.groupId)[0];
    const refusals = {};
    for (const name of ["paragraph", "rotated"]) {
      await select(byName(name).id);
      try { await R.startSession(); refusals[name] = "opened"; } catch (e) { refusals[name] = e.code || e.message; }
    }
    return { glyphs: s.measured.glyphs, vertical: s.measured.vertical, note: n.bounds, refusals };
  `, 180000);
  assert.strictEqual(out.vertical, false);
  const span = spanOf(out.glyphs, 0, 2, false);
  near((out.note.left + out.note.right) / 2, span.center, 4, "horizontal: centred");
  assert.ok(out.note.bottom <= span.cross - 30, "horizontal: above the line (" + out.note.bottom + " vs centre " + span.cross + ")");
  assert.deepStrictEqual(out.refusals, { paragraph: "paragraph", rotated: "transformed" });
  log("horizontal ok, refusals", JSON.stringify(out.refusals));
}

async function checkRollback(base) {
  const out = await run(`
    await select(${base});
    const s = await R.startSession();
    const before = { history: historyCount(), layers: JSON.stringify(layerList()), tracking: trackingOf(${base}) };
    globalThis.__rubyFailAt = "afterNotes";
    let error = "";
    try { await R.applyNotes(s, s.notes.concat([{ start: 5, end: 6, text: "失败" }])); error = "no error"; } catch (e) { error = String((e && (e.message || JSON.stringify(e))) || e); }
    globalThis.__rubyFailAt = null;
    return { error, before, after: { history: historyCount(), layers: JSON.stringify(layerList()), tracking: trackingOf(${base}) } };
  `, 180000);
  assert.ok(/test failure/.test(out.error), "the apply failed on purpose: " + out.error);
  assert.strictEqual(out.after.history, out.before.history, "no history state left");
  assert.strictEqual(out.after.layers, out.before.layers, "the layers are as they were");
  assert.deepStrictEqual(out.after.tracking, out.before.tracking, "the base tracking is as it was");
  log("rollback ok");
}

async function checkSaveReopen(groupId) {
  const out = await run(`
    const lfs = require("uxp").storage.localFileSystem;
    const folder = await lfs.getEntryWithUrl("${DIR_URL}");
    const file = await folder.createFile("ruby-check.psd", { overwrite: true });
    await modal(async () => { await doc().saveAs.psd(file); await doc().closeWithoutSaving(); });
    await modal(async () => { await ps.app.open(file); });
    const group = layerList().find((l) => l.kind === "group" && notesOf(l.id).length === 3);
    await select(group.id);
    const s = await R.startSession();
    globalThis.__rubySession = s;
    return { notes: s.notes.map((n) => n.text).sort(), notices: s.notices };
  `, 180000);
  assert.deepStrictEqual(out.notes, ["晴朗", "撑开很长的注释", "很长的注释文"].sort(), "notes come back from the PSD");
  assert.deepStrictEqual(out.notices, []);
  log("save / reopen ok");
}

// Columns too close for a note: the note's column moves away from the one
// before it (leading), the other columns keep theirs; re-align does not add
// it again; undo puts it back
async function checkLeading() {
  const centres = (glyphs) => {
    const lines = {};
    glyphs.forEach((g) => { if (g.box) (lines[g.line] = lines[g.line] || []).push((g.box.left + g.box.right) / 2); });
    return Object.keys(lines).sort().map((k) => lines[k].reduce((a, b) => a + b, 0) / lines[k].length);
  };
  const out = await run(`
    let id = 0;
    await modal(async () => {
      await ps.app.createDocument({ width: 1200, height: 900, resolution: 72, fill: "white", mode: "RGBColorMode", name: "Ruby leading" });
      const v = await doc().createTextLayer({ contents: "我去滴哦\\r欧锦请我\\r佛钦佩勤", fontSize: 80, position: { x: 900, y: 100 }, fontName: cjkFont() });
      v.textItem.orientation = "vertical";
      id = v.id;
      await select(id);
      const t = host._getLayerText();
      t.layerText.textStyleRange = t.layerText.textStyleRange.map((r) => Object.assign({}, r, { textStyle: Object.assign({}, r.textStyle, { autoLeading: false, leading: 90 }) }));
      play({ _obj: "set", _target: [{ _ref: "layer", _id: id }], to: host.jamText.toLayerTextObject(t) });
    });
    const before = await measureNow(id);
    await select(id);
    let s = await R.startSession();
    const done = await R.applyNotes(s, [{ start: 6, end: 8, text: "测试测" }]);
    const after = await measureNow(id);
    const note = notesOf(done.groupId)[0];
    await select(done.groupId);
    s = await R.startSession();
    await R.applyNotes(s, s.notes);
    const again = await measureNow(id);
    const note2 = notesOf(done.groupId)[0];
    await modal(async () => play({ _obj: "select", _target: [{ _ref: "historyState", _enum: "ordinal", _value: "previous" }] }));
    await modal(async () => play({ _obj: "select", _target: [{ _ref: "historyState", _enum: "ordinal", _value: "previous" }] }));
    const undone = await measureNow(id);
    await modal(async () => { await doc().closeWithoutSaving(); });
    return { before, after, again, undone, note: note.bounds, note2: note2.bounds, room: done.room };
  `, 240000);
  const b = centres(out.before);
  const a = centres(out.after);
  const g = centres(out.again);
  const u = centres(out.undone);
  log("leading", JSON.stringify({ before: b.map(Math.round), after: a.map(Math.round), again: g.map(Math.round), undone: u.map(Math.round), note: out.note }));
  near(b[0] - b[1], 90, 2, "tight columns to start with");
  const col0Left = Math.min(...out.after.filter((x) => x.box && x.line === 0).map((x) => x.box.left));
  soft("room made", () => assert.ok(out.note.right <= col0Left + 1, "the note clears the column before it: note right " + out.note.right + ", column left " + col0Left));
  soft("only that column", () => near(a[1] - a[2], 90, 2, "the next column keeps its leading"));
  soft("not twice", () => near(g[0] - g[1], a[0] - a[1], 1, "re-align does not add the room again"));
  soft("note stays", () => near(out.note2.left, out.note.left, 1, "the note stays put on re-align"));
  soft("undo", () => near(u[0] - u[1], 90, 2, "undo puts the leading back"));
}

// A note on column 2, applied; the editor opened again from the group and a
// note added on column 3: both columns must make room (reported 2026-11-27)
async function checkSecondSession(autoLeading, below) {
  const centres = (glyphs) => {
    const lines = {};
    glyphs.forEach((g) => { if (g.box) (lines[g.line] = lines[g.line] || []).push((g.box.left + g.box.right) / 2); });
    return Object.keys(lines).sort().map((k) => lines[k].reduce((a, b) => a + b, 0) / lines[k].length);
  };
  const out = await run(`
    let id = 0;
    await modal(async () => {
      await ps.app.createDocument({ width: 1200, height: 1100, resolution: 72, fill: "white", mode: "RGBColorMode", name: "Ruby second" });
      const v = await doc().createTextLayer({ contents: "区和符号肥沃的\\r达斯科群岛去哦我\\r诉求我去过而王鹏", fontSize: 80, position: { x: 900, y: 100 }, fontName: cjkFont() });
      v.textItem.orientation = "vertical";
      id = v.id;
      await select(id);
      const t = host._getLayerText();
      if (!${!!autoLeading}) t.layerText.textStyleRange = t.layerText.textStyleRange.map((r) => Object.assign({}, r, { textStyle: Object.assign({}, r.textStyle, { autoLeading: false, leading: 90 }) }));
      if (${!!below}) t.layerText.paragraphStyleRange = t.layerText.paragraphStyleRange.map((r) => Object.assign({}, r, { paragraphStyle: Object.assign({}, r.paragraphStyle, { leadingType: "leadingBelow" }) }));
      play({ _obj: "set", _target: [{ _ref: "layer", _id: id }], to: host.jamText.toLayerTextObject(t) });
    });
    const before = await measureNow(id);
    await select(id);
    let s = await R.startSession();
    const first = await R.applyNotes(s, [{ id: "a", start: 8, end: 11, text: "测测测", ratio: ${autoLeading ? 1 : 0.5} }]);
    const once = await measureNow(id);
    await select(first.groupId);
    s = await R.startSession();
    const reopened = { notes: s.notes.map((n) => [n.start, n.end, n.text]), takeBack: s.takeBack };
    const second = await R.applyNotes(s, s.notes.concat([{ id: "b", start: 17, end: 20, text: "测测测", ratio: ${autoLeading ? 1 : 0.5} }]));
    const twice = await measureNow(id);
    const notes = notesOf(second.groupId).map((n) => ({ text: n.payload.note.text, start: n.payload.note.start, bounds: n.bounds, leading: n.payload.leading }));
    const leadingNow = host.jamText ? null : null;
    await select(id);
    const tk = play({ _obj: "get", _target: [{ _property: "textKey" }, { _ref: "layer", _id: id }] }).textKey;
    const styles = tk.textStyleRange.map((r) => ({ from: r.from, to: r.to, autoLeading: r.textStyle.autoLeading, leading: r.textStyle.leading && (r.textStyle.leading._value || r.textStyle.leading) }));
    await modal(async () => { await doc().closeWithoutSaving(); });
    return { before, once, twice, reopened, notes, styles, room1: first.room, room2: second.room };
  `, 300000);
  const b = centres(out.before);
  const o = centres(out.once);
  const t = centres(out.twice);
  log("second session " + (autoLeading ? "auto" : "90") + (below ? " leadingBelow" : ""), JSON.stringify({ before: b.map(Math.round), once: o.map(Math.round), twice: t.map(Math.round) }));
  log("  reopened", JSON.stringify(out.reopened));
  log("  room1", JSON.stringify(out.room1), "room2", JSON.stringify(out.room2));
  log("  styles", JSON.stringify(out.styles));
  log("  notes", JSON.stringify(out.notes));
  soft("first note room", () => assert.ok(o[0] - o[1] > b[0] - b[1] + 10, "column 2 moved away for its note"));
  soft("first stays", () => near(t[0] - t[1], o[0] - o[1], 1, "column 2 keeps its room"));
  soft("second note room", () => assert.ok(t[1] - t[2] > b[1] - b[2] + 10, "column 3 moved away for its note: " + (t[1] - t[2]) + " vs " + (b[1] - b[2])));
}

// A free-transformed base at 300 ppi (reported 2026-11-28): stored 4.029 pt,
// scaled 436.42 %, shown 17.58 pt. Apply must keep the base's size and give
// the note the size it planned.
async function checkScaled() {
  const out = await run(`
    let id = 0;
    const shownPt = (layerId) => play({ _obj: "get", _target: [{ _property: "textKey" }, { _ref: "layer", _id: layerId }] }).textKey.textStyleRange.map((r) => {
      const s = r.textStyle; const v = s.impliedFontSize || s.size; return Math.round((typeof v === "object" ? v._value : v) * 1000) / 1000; });
    await modal(async () => {
      await ps.app.createDocument({ width: 2400, height: 2400, resolution: 300, fill: "white", mode: "RGBColorMode", name: "Ruby scaled" });
      // createTextLayer takes fontSize in px: 4.029 pt at 300 ppi
      const v = await doc().createTextLayer({ contents: "区和符号肥沃的\\r的额全微分去哦我\\r诉求我去过而王鹏", fontSize: 4.029 * 300 / 72, position: { x: 400, y: 300 }, fontName: cjkFont() });
      v.textItem.orientation = "vertical";
      id = v.id;
      // Tight columns (fixed leading 1.1 em), set before the scaling
      await select(id);
      const t = host._getLayerText();
      t.layerText.textStyleRange = t.layerText.textStyleRange.map((r) => Object.assign({}, r, { textStyle: Object.assign({}, r.textStyle, { autoLeading: false, leading: 4.029 * 1.1 }) }));
      play({ _obj: "set", _target: [{ _ref: "layer", _id: id }], to: host.jamText.toLayerTextObject(t) });
      await v.scale(436.4203, 436.4203);
    });
    await select(id);
    const transform = play({ _obj: "get", _target: [{ _property: "textKey" }, { _ref: "layer", _id: id }] }).textKey.transform;
    const baseBefore = shownPt(id);
    const before = await measureNow(id);
    await select(id);
    const s = await R.startSession();
    const ems = s.measured.ems.slice(8, 13);
    const done = await R.applyNotes(s, [{ id: "a", start: 8, end: 13, text: "测试测试测试", align: "spread", distribute: "121", ratio: 0.5, gap: 0 }]);
    const after = await measureNow(id);
    const note = notesOf(done.groupId)[0];
    const baseAfter = shownPt(id);
    const noteShown = shownPt(note.id);
    // Opened again from the group and applied as it is: nothing moves
    await select(done.groupId);
    const s2 = await R.startSession();
    await R.applyNotes(s2, s2.notes);
    const again = await measureNow(id);
    const note2 = notesOf(done.groupId)[0];
    const result = { transform, baseBefore, baseAfter, noteShown, ems, before, after, note: note.bounds, room: done.room,
      again, baseAgain: shownPt(id), noteAgain: shownPt(note2.id), note2: note2.bounds };
    await modal(async () => { await doc().closeWithoutSaving(); });
    return result;
  `, 300000);
  const centres = (glyphs) => [0, 1, 2].map((l) => { const bs = glyphs.filter((g) => g.line === l && g.box).map((g) => g.box); return bs.reduce((a, b) => a + (b.left + b.right) / 2, 0) / bs.length; });
  const b = centres(out.before);
  const a = centres(out.after);
  const span = spanOf(out.after, 8, 13, true);
  log("scaled", JSON.stringify({ scale: out.transform && out.transform.xx, baseBefore: out.baseBefore, baseAfter: out.baseAfter, noteShown: out.noteShown, em: out.ems[0], cols: { before: b.map(Math.round), after: a.map(Math.round) }, note: out.note, span: { lo: Math.round(span.lo), hi: Math.round(span.hi) } }));
  const plannedPt = (out.ems[0] * 0.5 * 72) / 300;
  soft("base size kept", () => out.baseAfter.forEach((pt) => near(pt, out.baseBefore[0], 0.05, "the base still shows " + out.baseBefore[0] + " pt, got " + pt)));
  soft("note size", () => near(out.noteShown[0], plannedPt, 0.1, "the note shows the planned " + plannedPt.toFixed(3) + " pt"));
  soft("room made", () => assert.ok(a[0] - a[1] > b[0] - b[1] + 5, "column 2 moved away for its note: " + (a[0] - a[1]) + " vs " + (b[0] - b[1])));
  soft("note centred", () => near((out.note.top + out.note.bottom) / 2, span.center, 4, "the note centres on its characters"));
  soft("note beside", () => assert.ok(out.note.left >= span.cross && out.note.right <= a[0], "the note sits between the two columns"));
  const g = centres(out.again);
  log("scaled again", JSON.stringify({ baseAgain: out.baseAgain, noteAgain: out.noteAgain, cols: g.map(Math.round), note2: out.note2 }));
  soft("re-align size", () => out.baseAgain.forEach((pt) => near(pt, out.baseBefore[0], 0.05, "the base keeps its size on re-align")));
  soft("re-align note", () => near(out.noteAgain[0], out.noteShown[0], 0.02, "the note keeps its size on re-align"));
  soft("re-align columns", () => [0, 1, 2].forEach((i) => near(g[i], a[i], 1, "column " + (i + 1) + " stays put on re-align")));
  soft("re-align note place", () => near(out.note2.left, out.note.left, 1, "the note stays put on re-align"));
}

async function checkWindow() {
  // The real window, driven through the page's dev hook
  const opened = await run(`
    let base = byName("horizontal") || byName("vertical");
    if (!base) {
      await modal(async () => {
        await ps.app.createDocument({ width: 1200, height: 800, resolution: 72, fill: "white", mode: "RGBColorMode", name: "Ruby window check" });
        const l = await doc().createTextLayer({ contents: "窗口测试文字", fontSize: 90, position: { x: 100, y: 400 }, fontName: cjkFont() });
        l.name = "window";
      });
      base = byName("window");
    }
    await select(base.id);
    globalThis.__rubyEditor = null;
    globalThis.__rubyOpenRun = T.ruby.methods.rubyOpen().then((raw) => (typeof raw === "string" ? JSON.parse(raw) : raw));
    await waitFor(() => globalThis.__rubyEditor && globalThis.__rubyEditor.log.indexOf("ready") >= 0, 120000, "the editor window");
    await sleep(800);
    const state = await devCall("state");
    return { state, base: base.id };
  `, 180000);
  log("window open", JSON.stringify(opened.state).slice(0, 200));
  const result = await run(`
    const count0 = (await devCall("state")).notes.length;
    await devCall("pick", 2, 3);
    await sleep(300);
    let state = await devCall("state");
    // Undo / redo in the window
    await devCall("undo");
    await sleep(200);
    const undone = (await devCall("state")).notes.length;
    await devCall("redo");
    await sleep(200);
    state = await devCall("state");
    if (undone !== count0 || state.notes.length !== count0 + 1) throw new Error("undo/redo in the window: " + [count0, undone, state.notes.length].join(", "));
    const added = state.notes[state.notes.length - 1];
    await devCall("setNotes", state.notes.map((n) => (n.id === added.id ? Object.assign({}, n, { text: "窗口注" }) : n)));
    await sleep(300);
    state = await devCall("state");
    await devCall("apply");
    const res = await globalThis.__rubyOpenRun;
    return { state, res };
  `, 180000);
  log("window", JSON.stringify(result.res));
  assert.strictEqual(result.res.code, "applied", "Apply from the window");
  assert.ok(result.state.notes.some((n) => n.text === "窗口注" && n.end - n.start === 2), "the picked note");
}

// 均分方式: the same note spread 1-2-1 (half a gap at each end) and 0-1-0
// (flush with the ends of its characters), measured on the real note layers
async function checkDistribute() {
  const out = await run(`
    const font = cjkFont();
    await modal(async () => {
      await ps.app.createDocument({ width: 1200, height: 1000, resolution: 72, fill: "white", mode: "RGBColorMode", name: "Ruby distribute" });
      const v = await doc().createTextLayer({ contents: "四个字的\\r四个字的", fontSize: 100, position: { x: 800, y: 150 }, fontName: font });
      v.textItem.orientation = "vertical";
      v.name = "spread";
    });
    const base = byName("spread");
    await select(base.id);
    const s = await R.startSession();
    const done = await R.applyNotes(s, [
      { id: "a", start: 0, end: 4, text: "注释文", align: "spread", distribute: "121" },
      { id: "b", start: 5, end: 9, text: "注释文", align: "spread", distribute: "010" },
    ]);
    return { glyphs: (await measureNow(base.id)), notes: notesOf(done.groupId) };
  `, 180000);
  const slot = (from, to) => {
    const first = out.glyphs[from].box;
    const last = out.glyphs[to - 1].box;
    return { start: (first.top + first.bottom) / 2 - 50, end: (last.top + last.bottom) / 2 + 50 };
  };
  const byDistribute = (d) => out.notes.find((n) => n.payload.note.distribute === d);
  const a = byDistribute("121");
  const b = byDistribute("010");
  assert.ok(a && b, "both notes written, with their 均分方式 in the payload");
  const sa = slot(0, 4);
  const sb = slot(5, 9);
  const ends = (note, s) => ({ lead: note.bounds.top - s.start, trail: s.end - note.bounds.bottom, length: note.bounds.bottom - note.bounds.top });
  const ea = ends(a, sa);
  const eb = ends(b, sb);
  log("distribute", JSON.stringify({ "121": ea, "010": eb }));
  soft("1-2-1 centred", () => near(ea.lead, ea.trail, 4, "the same room at both ends"));
  soft("1-2-1 room", () => assert.ok(ea.lead > 30, "half a gap at each end: " + ea.lead));
  soft("0-1-0 flush top", () => near(eb.lead, 0, 6, "the note starts with its characters"));
  soft("0-1-0 flush bottom", () => near(eb.trail, 0, 6, "the note ends with its characters"));
  soft("0-1-0 longer", () => assert.ok(eb.length > ea.length + 40, "0-1-0 runs further than 1-2-1"));
}

(async () => {
  const windowOnly = process.argv.includes("--window");
  const only = process.argv.includes("--scaled") ? [checkScaled] : process.argv.includes("--distribute") ? [checkDistribute] : process.argv.includes("--second") ? [() => checkSecondSession(false), () => checkSecondSession(true), () => checkSecondSession(true, true), () => checkSecondSession(false, true)] : null;
  if (only) {
    try {
      for (const check of only) await check();
      if (failures.length) throw new Error(failures.length + " check(s) failed:\n" + failures.join("\n"));
      console.log("Ruby check passed");
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    } finally {
      try { await run(`await modal(async () => { while (ps.app.documents.length && /^Ruby/.test(doc().name)) await doc().closeWithoutSaving(); }); return 0;`, 30000); } catch (error) {}
    }
    return;
  }
  try {
    if (!windowOnly) {
      const setup = await setupDocument();
      log("font", setup.font);
      const v = await checkVertical();
      await checkHorizontalAndRefusals();
      await checkRollback(v.base);
      await checkSaveReopen(v.groupId);
      await checkLeading();
      await checkDistribute();
      await checkSecondSession(false);
      await checkSecondSession(true, true);
      await checkSecondSession(false, true);
      await checkScaled();
    }
    await checkWindow();
    if (failures.length) throw new Error(failures.length + " check(s) failed:\n" + failures.join("\n"));
    console.log("Ruby live check passed");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    try {
      await run(`
        await modal(async () => { while (ps.app.documents.length && /^Ruby|ruby-check/.test(doc().name)) await doc().closeWithoutSaving(); });
        return ps.app.documents.map((d) => d.name);
      `, 30000);
    } catch (error) {}
  }
})();
