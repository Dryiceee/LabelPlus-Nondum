// Ruby (行间注): glyph mapping, layout, base tracking and the XMP payload
const assert = require("assert");
const createLoader = require("./helpers/loadAppModule");

const load = createLoader();
const text = load("app_src/ruby/text.js");
const measure = load("app_src/ruby/measure.js");
const layout = load("app_src/ruby/layout.js");
const ranges = load("app_src/ruby/textRanges.js");
const payload = load("app_src/ruby/payload.js");

const near = (actual, expected, tolerance, message) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, (message || "") + " expected " + expected + " got " + actual);

// Glyph boxes of a vertical text: column `col` (x centre), one em per
// character down from y0. Each character's ink is 90 % of its em.
function verticalBoxes(str, { em = 100, x = 1000, y0 = 100, colGap = 150 } = {}) {
  const boxes = [];
  let line = 0;
  let row = 0;
  text.chars(str).forEach((ch) => {
    if (text.isLineBreak(ch)) {
      line++;
      row = 0;
      return;
    }
    if (!text.isBlank(ch)) {
      const cx = x - line * colGap;
      const cy = y0 + row * em + em / 2;
      const half = text.isFullWidth(ch) ? em * 0.45 : em * 0.25;
      boxes.push({ left: cx - em * 0.45, right: cx + em * 0.45, top: cy - half, bottom: cy + half });
    }
    row++;
  });
  return boxes;
}

/* ------------------------------- text ------------------------------- */
{
  assert.deepStrictEqual(text.chars("a𠮷b"), ["a", "𠮷", "b"], "a character outside the BMP is one character");
  assert.deepStrictEqual(text.utf16Offsets(["a", "𠮷", "b"]), [0, 1, 3, 4]);
  assert.ok(text.isBlank(" ") && text.isBlank("　") && text.isBlank("\r") && text.isBlank("\t") && !text.isBlank("回"));
  assert.ok(text.isFullWidth("回") && text.isFullWidth("か") && text.isFullWidth("、") && text.isFullWidth("！"));
  assert.ok(!text.isFullWidth("A") && !text.isFullWidth("1"));
}

/* ------------------------------ measure ----------------------------- */
{
  const str = "回国 器A\r日本";
  const mapped = measure.mapGlyphs(str, verticalBoxes(str));
  assert.ok(mapped.ok, "one box per character that draws something");
  assert.strictEqual(mapped.glyphs.length, 8);
  assert.strictEqual(mapped.glyphs[2].box, null, "the space has no box");
  assert.strictEqual(mapped.glyphs[5].box, null, "the line break has no box");
  assert.deepStrictEqual(mapped.glyphs.map((g) => g.line), [0, 0, 0, 0, 0, 0, 1, 1]);
  near(mapped.glyphs[6].box.left, 1000 - 150 - 45, 1e-9, "second column");
  const short = measure.mapGlyphs(str, verticalBoxes(str).slice(0, 5));
  assert.ok(!short.ok && short.code === "short", "a ligature (or a cut-off end) gives fewer boxes");
  const extra = measure.mapGlyphs("回", verticalBoxes("回回"));
  assert.ok(!extra.ok && extra.code === "mismatch", "more boxes than characters");
  // Surrogate pairs: offsets in UTF-16
  const pair = measure.mapGlyphs("𠮷回", verticalBoxes("回回"));
  assert.deepStrictEqual(pair.glyphs.map((g) => g.offset), [0, 2]);

  const lines = measure.lineGeometry(mapped.glyphs, true);
  near(lines[0].cross, 1000, 1e-9, "column centre");
  near(lines[1].cross, 850, 1e-9);
  // A punctuation mark off the centre line does not pull the median
  const punct = measure.mapGlyphs("回国、器", [
    { left: 955, right: 1045, top: 105, bottom: 195 }, { left: 955, right: 1045, top: 205, bottom: 295 },
    { left: 1020, right: 1048, top: 300, bottom: 330 }, { left: 955, right: 1045, top: 405, bottom: 495 }]);
  near(measure.lineGeometry(punct.glyphs, true)[0].cross, 1000, 1e-9, "median");

  // Path units: the candidate that matches the layer bounds
  assert.strictEqual(measure.pickFactor([{ left: 24, top: 24, right: 48, bottom: 48 }], { left: 100, top: 100, right: 200, bottom: 200 }, "distanceUnit", 300), 300 / 72);
  assert.strictEqual(measure.pickFactor([{ left: 100, top: 100, right: 200, bottom: 200 }], { left: 100, top: 100, right: 200, bottom: 200 }, "distanceUnit", 300), 1);
}

/* ------------------------------ layout ------------------------------ */
const setup = (str, opts) => {
  const mapped = measure.mapGlyphs(str, verticalBoxes(str, opts));
  const lines = measure.lineGeometry(mapped.glyphs, true);
  const ems = text.chars(str).map(() => (opts && opts.em) || 100);
  return { glyphs: mapped.glyphs, lines, ems };
};
// Exact measure: full-width characters one em each, no ink trimming
const exact = (str, size, tracking = 0, scale = 1) => {
  const n = text.chars(str).length;
  return n * size * scale + Math.max(0, n - 1) * (tracking / 1000) * size;
};
{
  const { glyphs, lines, ems } = setup("今天天气真好\r第二列");
  const span = layout.spanGeometry(glyphs, lines, ems, true, 2, 4);
  near(span.start, 300, 1e-9, "a full-width character takes its em");
  near(span.end, 500, 1e-9);
  near(span.length, 200, 1e-9);
  near(span.cross, 1000, 1e-9);
  assert.strictEqual(span.prev, 1, "the character before, on the same line");
  assert.strictEqual(layout.spanGeometry(glyphs, lines, ems, true, 0, 2).prev, null, "none at the top of a column");
  assert.strictEqual(layout.spanGeometry(glyphs, lines, ems, true, 5, 8).error, "crossLine");
  assert.strictEqual(layout.spanGeometry(glyphs, lines, ems, true, 3, 3).error, "empty");
  assert.strictEqual(layout.spanGeometry(glyphs, lines, ems, true, 7, 8).prev, null, "the first of the second column");

  assert.strictEqual(layout.normalizeNote({}).align, "spread", "spread by default");
  const note = (extra) => layout.normalizeNote(Object.assign({ id: "a", start: 2, end: 4, text: "晴朗", align: "center" }, extra));
  // Fits: half size, centred, to the right of the column
  let plan = layout.planNote(span, note(), exact);
  near(plan.size, 50, 1e-9);
  near(plan.length, 100, 1e-9);
  let rect = layout.placeNote(span, plan, note(), true);
  near(rect.main0, 350, 1e-9, "centred on the characters");
  near(rect.cross, 1000 + 50 + 25, 1e-9, "right of the column, touching it");
  near(rect.box.left, 1050, 1e-9);
  // Start alignment
  rect = layout.placeNote(span, plan, note({ align: "start" }), true);
  near(rect.main0, 300, 1e-9);
  // Gap, in base ems
  near(layout.placeNote(span, plan, note({ gap: 0.1 }), true).cross, 1085, 1e-9);
  // Horizontal: above the line
  near(layout.placeNote(Object.assign({}, span, { cross: 500 }), plan, note(), false).cross, 500 - 50 - 25, 1e-9);
  // 1-2-1: the room shared out, half a share at each end
  plan = layout.planNote(span, note({ align: "spread" }), exact);
  near(plan.tracking, (2 * (100 / 4) / 50) * 1000, 1e-9);
  near(plan.length, 150, 1e-9, "ink ends half a share from each end");

  // Longer than its characters: 8 characters at 50 px = 400 > 200
  const long = (extra) => note(Object.assign({ text: "这是一个很长的注" }, extra));
  plan = layout.planNote(span, long(), exact);
  near(plan.size, 25, 1e-6, "shrink: down to the span's length");
  assert.ok(!plan.overhang);
  plan = layout.planNote(span, long({ text: "这是一个很长很长很长很长很长很长很长很长的注" }), exact);
  near(plan.size, 15, 1e-9, "shrink stops at its smallest size");
  assert.ok(plan.overhang, "and overhangs from there");
  plan = layout.planNote(span, long({ size: 40 }), exact);
  near(plan.size, 40, 1e-9, "a size set by hand never shrinks");
  assert.ok(plan.overhang);
  plan = layout.planNote(span, long({ overflow: "squeeze" }), exact);
  near(plan.scale, 0.5, 1e-9, "squeeze");
  near(plan.length, 200, 1e-9);
  plan = layout.planNote(span, long({ overflow: "overhang" }), exact);
  assert.ok(plan.overhang && plan.size === 50);
  plan = layout.planNote(span, long({ overflow: "spread" }), exact);
  near(plan.baseExtra, 200, 1e-9, "spread: the base grows by the difference");
  assert.ok(!plan.overhang);

  // Spread deltas: half a share before, shares between, half after
  const deltas = layout.spreadDeltas(span, 200, ems);
  assert.deepStrictEqual(deltas.map((d) => d.index), [1, 2, 3]);
  near(deltas[0].delta, 500, 1e-9);
  near(deltas[1].delta, 1000, 1e-9);
  near(deltas[2].delta, 500, 1e-9);
  near(deltas.reduce((sum, d) => sum + (d.delta / 1000) * 100, 0), 200, 1e-9, "adds up to the extra length");
  const top = layout.spreadDeltas(layout.spanGeometry(glyphs, lines, ems, true, 0, 2), 200, ems);
  assert.deepStrictEqual(top.map((d) => [d.index, d.delta]), [[0, 1000], [1, 1000]], "no character before: all after");
  // The room the tracking makes, for centring the note
  assert.deepStrictEqual(layout.spreadRoom(span, 200), { lead: 50, trail: 50 });
  assert.deepStrictEqual(layout.spreadRoom(layout.spanGeometry(glyphs, lines, ems, true, 0, 2), 200), { lead: 0, trail: 100 });
  const wide = layout.widenSpan(span, { lead: 50, trail: 50 });
  near(wide.length, 300, 1e-9);
  near(wide.start, 250, 1e-9);
  assert.deepStrictEqual(layout.mergeDeltas([[{ index: 1, delta: 5 }], [{ index: 1, delta: -5 }, { index: 2, delta: 3 }]]), [{ index: 2, delta: 3 }]);

  // Everything at once: overlap, collision, errors
  const all = layout.layoutNotes({
    glyphs, ems, vertical: true, measure: exact,
    notes: [
      { id: "a", start: 0, end: 1, text: "很长很长", overflow: "overhang" },
      { id: "b", start: 1, end: 2, text: "很长很长", overflow: "overhang" },
      { id: "c", start: 1, end: 3, text: "重叠" },
      { id: "d", start: 3, end: 4, text: "" },
      { id: "e", start: 4, end: 8, text: "跨列" },
      { id: "f", start: 8, end: 10, text: "撑开很长很长", overflow: "spread" },
    ],
  });
  const byId = {};
  all.items.forEach((item) => { byId[item.id] = item; });
  assert.strictEqual(byId.c.error, "overlap");
  assert.strictEqual(byId.d.error, "noText");
  assert.strictEqual(byId.e.error, "crossLine");
  assert.ok(all.collisions.has("a") && all.collisions.has("b"), "overhanging notes on one line run into each other");
  assert.ok(!all.collisions.has("f"));
  assert.deepStrictEqual(all.baseDeltas.map((d) => d.index), [7, 8, 9], "spread deltas, from the character before");

  // Room between lines: a note right of column 2 sits between columns 2 and
  // 1, 150 px apart centre to centre (100 px characters): a 40 px note needs
  // 50 + 40 + 15 % air + 50 = 146 and fits; a 60 px note needs 50 + 69 + 50
  const fits = layout.layoutNotes({ glyphs, ems, vertical: true, measure: exact, notes: [{ id: "a", start: 7, end: 9, text: "注释", ratio: 0.4 }] });
  assert.deepStrictEqual(fits.room, [], "room enough");
  const big = layout.layoutNotes({ glyphs, ems, vertical: true, measure: exact, notes: [{ id: "a", start: 7, end: 9, text: "注", size: 60 }, { id: "b", start: 9, end: 10, text: "注", size: 40 }] });
  assert.strictEqual(big.room.length, 1, "one line to move");
  assert.strictEqual(big.room[0].line, 1);
  near(big.room[0].pitch, 150, 1e-9);
  near(big.room[0].required, 50 + 69 + 50, 1e-9, "the biggest note of the line decides");
  assert.deepStrictEqual(big.room[0].indices, [7, 8, 9]);
  assert.deepStrictEqual(big.room[0].before, [0, 1, 2, 3, 4, 5, 6], "the line before, with its line break");
  assert.deepStrictEqual(layout.leadingTarget(big.room[0], "leadingAbove"), big.room[0].before, "top to top: the line before holds the distance");
  assert.deepStrictEqual(layout.leadingTarget(big.room[0], "leadingBelow"), big.room[0].indices, "Roman: the line itself");
  assert.strictEqual(ranges.leadingTypeAt({ paragraphStyleRange: [{ from: 0, to: 3, paragraphStyle: { leadingType: "leadingBelow" } }] }, 1), "leadingBelow");
  assert.deepStrictEqual(layout.layoutNotes({ glyphs, ems, vertical: true, measure: exact, notes: [{ id: "a", start: 0, end: 2, text: "注", size: 90 }] }).room, [], "the first line has no line before it");
  near(layout.layoutNotes({ glyphs, ems, vertical: true, measure: exact, notes: [{ id: "a", start: 7, end: 9, text: "注", size: 60, gap: 0.2 }] }).room[0].required, 50 + 20 + 69 + 50, 1e-9, "the gap counts");

  // The preview: the base as Apply leaves it, notes placed on that
  const predicted = layout.predictLayout({ glyphs, ems, vertical: true, measure: exact, notes: [{ id: "a", start: 7, end: 9, text: "注", size: 60, align: "center" }] });
  near(predicted.glyphs[7].shift.dx, -(169 - 150), 1e-9, "column 2 moves left by the missing room");
  near(predicted.glyphs[0].shift.dx, 0, 1e-9, "column 1 stays");
  const noteBox = predicted.items[0].rect.box;
  const columnLeft = Math.min(...predicted.glyphs.filter((g) => g.line === 0 && g.box).map((g) => g.box.left));
  assert.ok(noteBox.right <= columnLeft - 60 * 0.15 + 1e-9 + 5, "the note clears the column before it in the preview");
  near(predicted.glyphs[7].box.left, glyphs[7].box.left - 19, 1e-9);
  // Spread tracking pushes the rest of the line
  const pushed = layout.predictLayout({ glyphs, ems, vertical: true, measure: exact, notes: [{ id: "s", start: 2, end: 4, text: "撑开很长的注释", overflow: "spread", ratio: 0.3 }] });
  const d = pushed.baseDeltas.map((x) => (x.delta / 1000) * 100);
  near(pushed.glyphs[2].shift.dy, d[0], 1e-9, "after the character before the span");
  near(pushed.glyphs[4].shift.dy, d[0] + d[1] + d[2], 1e-9, "after the span");
  near(pushed.glyphs[7].shift.dy, 0, 1e-9, "the next column starts again");
  const r = pushed.items[0].rect;
  near(r.main1 - r.main0, pushed.items[0].plan.length, 1e-9);
  near((r.main0 + r.main1) / 2, (pushed.glyphs[2].box.top + pushed.glyphs[3].box.bottom) / 2, 6, "centred on the spaced-out characters");

  // Picking: one line, no blanks at the ends
  assert.deepStrictEqual(layout.clampSpan(glyphs, 4, 9), { start: 4, end: 6 }, "stops at the line break");
  assert.deepStrictEqual(layout.clampSpan(glyphs, 3, 1), { start: 1, end: 4 }, "either direction");

  // Estimate: full-width = 1 em, a little less ink at the end
  near(layout.estimateLength("晴朗", 50), 100 - 4, 1e-9);
  near(layout.estimateLength("晴朗", 50, 100), 96 + 5, 1e-9);
}

/* --------------------------- text ranges ---------------------------- */
{
  const layerText = {
    textKey: "𠮷天天气",
    textStyleRange: [{ from: 0, to: 3, textStyle: { size: 20, tracking: 10 } }, { from: 3, to: 5, textStyle: { size: 30 } }],
    transform: { xx: 2, xy: 0, yx: 0, yy: 2, tx: 0, ty: 0 },
  };
  const spread = ranges.addTracking(layerText, [{ index: 0, delta: 100 }, { index: 2, delta: 50.4 }]);
  assert.deepStrictEqual(spread.textStyleRange.map((r) => [r.from, r.to, r.textStyle.tracking]), [[0, 2, 110], [2, 3, 10], [3, 4, 50], [4, 5, undefined]],
    "split at the characters, UTF-16 ranges");
  assert.strictEqual(layerText.textStyleRange.length, 2, "the input stays as it was");
  const back = ranges.addTracking(spread, [{ index: 0, delta: 100 }, { index: 2, delta: 50 }], -1);
  assert.deepStrictEqual(back.textStyleRange.map((r) => r.textStyle.tracking || 0), [10, 10, 0, 0], "taken back");
  // Sizes as shown: the stored size times the layer's scale, in px
  assert.deepStrictEqual(ranges.emsOf({ layerText, typeUnit: "pointsUnit" }, 144), [80, 80, 120, 120]);
  assert.deepStrictEqual(ranges.emsOf({ layerText: Object.assign({}, layerText, { textStyleRange: [{ from: 0, to: 5, textStyle: { size: 20, impliedFontSize: 33 } }] }), typeUnit: "pixelsUnit" }, 72), [33, 33, 33, 33]);
  assert.ok(ranges.isPlainScale({ xx: 2, xy: 0, yx: 0, yy: 1.5 }));
  assert.ok(!ranges.isPlainScale({ xx: 0.87, xy: 0.5, yx: -0.5, yy: 0.87 }), "rotated");
  assert.ok(!ranges.isPlainScale({ xx: -1, xy: 0, yx: 0, yy: 1 }), "flipped");
  near(ranges.pixelsToTypeUnit(ranges.typeUnitToPixels(12, "pointsUnit", 300), "pointsUnit", 300), 12, 1e-9);
  const noteText = ranges.noteLayerText(layerText, 3, { text: "注释", size: 7, tracking: 12.6, scale: 0.8, scaleKey: "verticalScale" });
  assert.strictEqual(noteText.textKey, "注释");
  assert.deepStrictEqual(noteText.textStyleRange, [{ from: 0, to: 2, textStyle: { size: 7, tracking: 13, baselineShift: 0, horizontalScale: 100, verticalScale: 80, autoLeading: true } }]);
  assert.ok(noteText.transform && noteText.transform.xx === 2, "the layer keeps the base's transform");
  // Leading: read, set on a line, put back
  const lt = { textKey: "今天\r第二", textStyleRange: [{ from: 0, to: 5, textStyle: { size: 20, autoLeading: true } }] };
  const saved = ranges.leadingOf(lt, [3, 4]);
  assert.deepStrictEqual(saved, [{ index: 3, autoLeading: true }, { index: 4, autoLeading: true }]);
  const led = ranges.setLeading(lt, [3, 4], 33);
  assert.deepStrictEqual(led.textStyleRange.map((r) => [r.from, r.to, r.textStyle.autoLeading, r.textStyle.leading]), [[0, 3, true, undefined], [3, 4, false, 33], [4, 5, false, 33]]);
  const restored = ranges.restoreLeading(led, saved);
  assert.ok(restored.textStyleRange.every((r) => r.textStyle.autoLeading === true && r.textStyle.leading === undefined), "back to auto leading");
  const both = ranges.takeBackStyles(ranges.addTracking(led, [{ index: 3, delta: 40 }]), { tracking: [{ index: 3, delta: 40 }], leading: saved });
  assert.ok(both.textStyleRange.every((r) => !r.textStyle.tracking && r.textStyle.autoLeading === true), "tracking and leading taken back together");
  assert.ok(!ranges.hasTakeBack({ tracking: [], leading: [] }) && ranges.hasTakeBack({ leading: saved }));
  const plain = ranges.overrideStyles(layerText, { syntheticBold: false, ligature: false });
  assert.ok(plain.textStyleRange.every((r) => r.textStyle.syntheticBold === false && r.textStyle.ligature === false));
}

/* ------------------------------ payload ----------------------------- */
{
  const note = layout.normalizeNote({ id: "x", start: 2, end: 4, text: "晴朗", overflow: "spread" });
  const built = payload.buildPayload({ note, baseId: 42, baseText: "今天天气真好", deltas: [{ index: 1, delta: 12.3456 }], leading: [{ index: 2, autoLeading: false, leading: 30 }, { index: 3, autoLeading: true }] });
  assert.strictEqual(built.span, "天气");
  assert.deepStrictEqual(built.deltas, [{ index: 1, delta: 12.35 }]);
  const parsed = payload.parsePayload(JSON.stringify(built));
  assert.strictEqual(parsed.base, 42);
  assert.strictEqual(parsed.note.overflow, "spread");
  assert.strictEqual(payload.parsePayload(JSON.stringify(Object.assign({}, built, { v: 99 }))), null, "a newer version");
  assert.strictEqual(payload.parsePayload("{oops"), null);
  assert.strictEqual(payload.parsePayload(JSON.stringify(Object.assign({}, built, { kind: "other" }))), null);

  assert.deepStrictEqual(payload.relocate(parsed, "今天天气真好"), { status: "same", start: 2, end: 4, shift: 0 });
  assert.deepStrictEqual(payload.relocate(parsed, "啊今天天气真好"), { status: "moved", start: 3, end: 5, shift: 1 });
  assert.deepStrictEqual(payload.relocate(parsed, "天气好，今天天气真好"), { status: "moved", start: 0, end: 2, shift: -2 }, "the nearest one");
  assert.strictEqual(payload.relocate(parsed, "今天下雨").status, "lost");
  assert.deepStrictEqual(payload.relocatedDeltas(parsed, { status: "moved", shift: 1 }, 7), [{ index: 2, delta: 12.35 }]);
  assert.deepStrictEqual(payload.relocatedDeltas(parsed, { status: "lost", shift: 0 }, 7), []);
  assert.deepStrictEqual(parsed.leading, [{ index: 2, autoLeading: false, leading: 30 }, { index: 3, autoLeading: true }]);
  assert.deepStrictEqual(payload.relocatedLeading(parsed, { status: "moved", shift: 1 }, 7), [{ index: 3, autoLeading: false, leading: 30 }, { index: 4, autoLeading: true }]);

  const xmp = payload.writeXmpData("", JSON.stringify(built));
  assert.ok(xmp.indexOf("lpruby:data") > 0);
  assert.strictEqual(payload.readXmpData(xmp), JSON.stringify(built), "XMP round trip");
  assert.strictEqual(payload.readXmpData(payload.writeXmpData(xmp, null)), null, "removed");
}

console.log("Ruby tests passed");
