// SFX editor: outlines, layout, glyph normalisation and the XMP payload
const assert = require("assert");
const createLoader = require("./helpers/loadAppModule");

const load = createLoader();
const outline = load("app_src/sfx/outline.js");
const layout = load("app_src/sfx/layout.js");
const glyphs = load("app_src/sfx/glyphs.js");
const payload = load("app_src/sfx/payload.js");
const group = load("app_src/sfx/group.js");

const near = (actual, expected, tolerance, message) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, (message || "") + " expected " + expected + " got " + actual);

// A square ring (回-like: an outer contour and a hole), in px
const ring = (x, y, outer, inner) => {
  const sq = (l, t, size, reverse) => {
    const corners = [[l, t], [l + size, t], [l + size, t + size], [l, t + size]];
    if (reverse) corners.reverse();
    return { closed: true, pts: corners.map((c) => [c[0], c[1], c[0], c[1], c[0], c[1], 0]) };
  };
  const pad = (outer - inner) / 2;
  return [{ op: "add", paths: [sq(x, y, outer, false), sq(x + pad, y + pad, inner, true)] }];
};

/* ----------------------------- outline ----------------------------- */
{
  const comps = ring(10, 20, 100, 40);
  // Photoshop's distanceUnit: points at 72 dpi; at 300 dpi px = v * 300 / 72
  const factor = outline.unitFactor(outline.UNIT_DISTANCE, 300);
  const descriptor = outline.buildPathContents(comps, outline.UNIT_DISTANCE, factor);
  const first = descriptor.pathComponents[0].subpathListKey[0].points[0];
  assert.strictEqual(first.anchor.horizontal._unit, "distanceUnit");
  near(first.anchor.horizontal._value, 10 * 72 / 300, 1e-9, "unit conversion");
  assert.strictEqual(descriptor.pathComponents[0].subpathListKey.length, 2, "the hole stays a subpath");
  assert.strictEqual(outline.detectUnit(descriptor), "distanceUnit");
  const back = outline.parsePathContents(descriptor, factor);
  assert.deepStrictEqual(outline.roundComponents(back, 6), outline.roundComponents(comps, 6), "round trip");
  // Raw numbers (no unit objects) stay raw
  const raw = outline.buildPathContents(comps, outline.UNIT_RAW, 1);
  assert.strictEqual(typeof raw.pathComponents[0].subpathListKey[0].points[0].anchor.horizontal, "number");
  assert.strictEqual(outline.detectUnit(raw), "raw");
  // Matrices
  const m = [2, 0, 0, 3, 5, 7];
  const inv = outline.invert(m);
  const p = outline.applyToPoint(outline.multiply(inv, m), 11, -4);
  near(p[0], 11, 1e-9); near(p[1], -4, 1e-9);
  const box = outline.bounds(comps);
  assert.deepStrictEqual([box.left, box.top, box.right, box.bottom], [10, 20, 110, 120]);
  assert.strictEqual(outline.countPoints(comps), 8);
  const svg = outline.toSvgPath(comps);
  assert.ok(/^M10 20C/.test(svg) && (svg.match(/Z/g) || []).length === 2, svg);
  // Missing handles fall back on the anchor; the shape operation is kept
  const parsed = outline.parsePathContents({ pathComponents: [{ shapeOperation: { _enum: "shapeOperation", _value: "xor" }, subpathListKey: [{ closedSubpath: true, points: [{ anchor: { horizontal: 1, vertical: 2 } }] }] }] });
  assert.deepStrictEqual(parsed, [{ op: "xor", paths: [{ closed: true, pts: [[1, 2, 1, 2, 1, 2, 0]] }] }]);
}

/* ------------------------------ paths ------------------------------ */
{
  const line = { type: "line", p0: [0, 0], p1: [300, 0] };
  near(layout.pathLength(line), 300, 1e-9, "line length");
  // A half circle: sagitta = half chord
  const arc = { type: "arc", p0: [0, 0], p1: [200, 0], bend: -100 };
  near(layout.pathLength(arc), Math.PI * 100, 0.1, "half circle length");
  const top = layout.bendHandle(arc);
  near(top[0], 100, 1e-6); near(top[1], -100, 1e-6, "arc top on the bend side");
  const pts = layout.samplePath(arc);
  assert.deepStrictEqual(pts[0], [0, 0]); assert.deepStrictEqual(pts[pts.length - 1], [200, 0]);
  assert.ok(pts.every((q) => q[1] <= 1e-9), "arc bulges up (negative y) for a negative bend");
  // Bend handle drag: a line becomes an arc through the dragged point
  const bent = layout.bendTo(line, [150, 60]);
  assert.strictEqual(bent.type, "arc"); near(bent.bend, 60, 1e-9);
  near(layout.bendHandle(bent)[1], 60, 1e-6);
  // A big bend (more than a half circle) still passes through its top
  const deep = { type: "arc", p0: [0, 0], p1: [100, 0], bend: 120 };
  const deepPts = layout.samplePath(deep);
  near(Math.max.apply(null, deepPts.map((q) => q[1])), 120, 0.5, "deep arc reaches its top");
  // Ends: a free path turns and stretches around the other end
  const free = { type: "free", pts: [[0, 0], [50, 10], [100, 0]] };
  const moved = layout.moveEnd(free, 1, [0, 200]);
  assert.deepStrictEqual(moved.pts[0], [0, 0]);
  near(moved.pts[2][0], 0, 1e-9); near(moved.pts[2][1], 200, 1e-9);
  near(Math.hypot(moved.pts[1][0], moved.pts[1][1]), 2 * Math.hypot(50, 10), 1e-9, "scaled with the stretch");
  // Arc end drag keeps the bend in proportion
  const arc2 = layout.moveEnd(arc, 1, [400, 0]);
  near(arc2.bend, -200, 1e-9);
  // Conversions keep the ends
  const asFree = layout.convertPath(arc, "free");
  assert.deepStrictEqual(layout.pathEnds(asFree), [[0, 0], [200, 0]]);
  assert.strictEqual(layout.convertPath(asFree, "line").type, "line");
  // Hand drawing: jitter dropped, ends kept, bounded size
  const stroke = [];
  for (let i = 0; i <= 2000; i++) stroke.push([i * 0.5, Math.sin(i / 50) * 40 + (i % 2) * 0.3]);
  const smooth = layout.smoothStroke(stroke);
  assert.ok(smooth.length <= 240 && smooth.length > 10, "smoothed size " + smooth.length);
  assert.deepStrictEqual(smooth[0], [0, 0]);
  near(smooth[smooth.length - 1][0], 1000, 1e-6);
}

/* ------------------------------ layout ----------------------------- */
{
  const model = layout.initialModel({ text: "轰隆隆", em: 100, color: { r: 255, g: 0, b: 0 }, box: { left: 100, top: 100, right: 400, bottom: 200 } });
  assert.strictEqual(model.path.type, "line");
  assert.deepStrictEqual(model.path.p0, [100, 150]); assert.deepStrictEqual(model.path.p1, [400, 150]);
  near(layout.trackingOf(model), 0, 1e-9, "side by side");
  const placed = layout.layoutGlyphs(model);
  assert.deepStrictEqual(placed.map((g) => Math.round(g.x)), [150, 250, 350], "centres on the path");
  assert.ok(placed.every((g) => g.y === 150 && g.angle === 0));
  // Tracking 50%: the path grows around its middle
  const spaced = layout.withTracking(model, 50);
  near(layout.trackingOf(spaced), 50, 1e-6);
  assert.deepStrictEqual(layout.layoutGlyphs(spaced).map((g) => Math.round(g.x)), [100, 250, 400]);
  // Growing toward the end: sizes 0.5 -> 1.5, still filling the path
  const growing = Object.assign({}, model, { startScale: 0.5, endScale: 1.5 });
  const sizes = layout.layoutGlyphs(growing).map((g) => g.size);
  assert.deepStrictEqual(sizes, [50, 100, 150]);
  // Vertical path: characters follow it unless upright
  const vertical = Object.assign({}, model, { path: { type: "line", p0: [0, 0], p1: [0, 300] } });
  near(layout.layoutGlyphs(vertical)[0].angle, Math.PI / 2, 1e-9);
  near(layout.layoutGlyphs(Object.assign({}, vertical, { upright: true }))[0].angle, 0, 1e-9);
  // Per-character offset, rotation and size
  const tuned = Object.assign({}, model, { glyphs: [{ dx: 5, dy: -7, rot: 30, scale: 2 }, layout.defaultGlyph(), layout.defaultGlyph()] });
  const first = layout.layoutGlyphs(tuned)[0];
  near(first.angle, Math.PI / 6, 1e-9); assert.strictEqual(first.size, 200);
  // The whole shape: a 回 ring per character, positioned in document px
  const outlines = { "轰": ring(-40, -40, 80, 30), "隆": ring(-40, -40, 80, 30) };
  const shape = layout.composeShape(model, outlines);
  assert.strictEqual(shape.length, 3, "one component per character");
  assert.ok(shape.every((c) => c.paths.length === 2), "holes kept");
  const box = outline.bounds(shape);
  assert.deepStrictEqual([box.left, box.top, box.right, box.bottom].map(Math.round), [110, 110, 390, 190]);
  // Text edits keep the settings of unchanged characters
  const edited = layout.withText(tuned, "轰咔");
  assert.strictEqual(edited.glyphs.length, 2);
  assert.strictEqual(edited.glyphs[0].scale, 2); assert.strictEqual(edited.glyphs[1].scale, 1);
  // normalizeModel clamps and repairs
  const repaired = layout.normalizeModel({ text: "啊", em: 50, scale: 999, color: { r: 300, g: -1, b: "x" }, path: { type: "free", pts: [[1, 1]] } });
  assert.strictEqual(repaired.scale, layout.LIMITS.scale[1]);
  assert.deepStrictEqual(repaired.color, { r: 255, g: 0, b: 0 });
  assert.strictEqual(repaired.path.type, "line", "a free path needs two points");
  assert.deepStrictEqual(layout.chars("𠮷a\n"), ["𠮷", "a"]);
}

/* ---------------------------- selections ---------------------------- */
{
  const model = layout.initialModel({ text: "一二三四", em: 100, color: { r: 0, g: 0, b: 0 }, box: { left: 0, top: 0, right: 400, bottom: 100 } });
  // A character's own size does not push the others along the path
  const big = layout.updateGlyphs(model, [0], () => ({ scale: 3 }));
  assert.deepStrictEqual(layout.layoutGlyphs(big).map((g) => Math.round(g.x)), [50, 150, 250, 350]);
  assert.strictEqual(layout.layoutGlyphs(big)[0].size, 300);
  // Two characters turned 90° around their common centre (200, 50)
  const turned = layout.transformSelection(model, [1, 2], { angle: 90 });
  const placed = layout.layoutGlyphs(turned);
  near(placed[1].x, 200, 1e-9); near(placed[1].y, 0, 1e-9, "150,50 -> 200,0");
  near(placed[2].x, 200, 1e-9); near(placed[2].y, 100, 1e-9);
  assert.strictEqual(turned.glyphs[1].rot, 90);
  assert.deepStrictEqual(turned.glyphs[0], layout.defaultGlyph(), "others untouched");
  // Scaled 2x around their centre, then moved
  const grown = layout.transformSelection(model, [1, 2], { k: 2, dx: 10 });
  assert.deepStrictEqual(layout.layoutGlyphs(grown).map((g) => Math.round(g.x)), [50, 110, 310, 350]);
  assert.strictEqual(grown.glyphs[2].scale, 2);
  // A single character turns in place
  const one = layout.transformSelection(model, [3], { angle: -30 });
  near(layout.layoutGlyphs(one)[3].x, 350, 1e-9);
  assert.strictEqual(one.glyphs[3].rot, -30);
  // Spread apart without growing
  const spread = layout.transformSelection(model, [1, 2], { k: 2, keepSize: true });
  assert.deepStrictEqual(layout.layoutGlyphs(spread).map((g) => Math.round(g.x)), [50, 100, 300, 350]);
  assert.strictEqual(spread.glyphs[1].scale, 1);
  // Each turned in place, positions kept
  const each = layout.turnEach(model, [0, 3], 200);
  assert.deepStrictEqual(each.glyphs.map((g) => g.rot), [-160, 0, 0, -160]);
  assert.deepStrictEqual(layout.layoutGlyphs(each).map((g) => Math.round(g.x)), [50, 150, 250, 350]);
  // Growing toward the last selected character
  const ramp = layout.rampSize(model, [1, 2, 3], 2, true);
  assert.deepStrictEqual(ramp.glyphs.map((g) => g.scale), [1, 1, 1.5, 2]);
  const rampStart = layout.rampSize(model, [1, 2, 3], 0.5, false);
  assert.deepStrictEqual(rampStart.glyphs.map((g) => g.scale), [1, 0.5, 0.75, 1]);
  // Bend the path where the selection starts (end 1 dragged to 500,300)
  const six = layout.initialModel({ text: "一二三四五六", em: 100, color: { r: 0, g: 0, b: 0 }, box: { left: 0, top: 0, right: 600, bottom: 0 } });
  const bent = layout.bendAtSelection(six, [2, 3, 4, 5], 1, [500, 300]);
  const bp = layout.layoutGlyphs(bent);
  near(bp[0].x, 50, 1e-6); near(bp[1].x, 150, 1e-6, "kept characters do not move");
  near(bp[1].angle, 0, 1e-9);
  near(layout.pathEnds(bent.path)[1][0], 500, 1e-6); near(layout.pathEnds(bent.path)[1][1], 300, 1e-6, "the end follows the pointer");
  const segment = Math.hypot(300, 300);
  const f = segment / 400;
  near(bent.glyphs[2].space, f, 1e-9);
  near(bp[2].x, 200 + 50 * f * Math.SQRT1_2, 1e-6); near(bp[2].y, 50 * f * Math.SQRT1_2, 1e-6, "on the new stretch");
  near(bp[5].angle, Math.PI / 4, 1e-9, "tilted with it");
  near(bp[5].x, 500 - 50 * f * Math.SQRT1_2, 1e-6);
  assert.strictEqual(bent.glyphs[0].space, 1);
  // The first end: the characters after the selection stay
  const bentStart = layout.bendAtSelection(six, [0, 1], 0, [0, -200]);
  const bs = layout.layoutGlyphs(bentStart);
  assert.deepStrictEqual(bs.slice(2).map((g) => Math.round(g.x * 1000) / 1000), [250, 350, 450, 550]);
  near(layout.pathEnds(bentStart.path)[0][0], 0, 1e-6); near(layout.pathEnds(bentStart.path)[0][1], -200, 1e-6);
  // A second bend further in, then a wider selection grabbed and let go
  // where it was: the earlier bend stays (it used to be flattened)
  const twice = layout.bendAtSelection(bent, [4, 5], 1, [520, 420]);
  const grabbed = layout.bendAtSelection(twice, [2, 3, 4, 5], 1, layout.pathEnds(twice.path)[1]);
  const tp = layout.layoutGlyphs(twice);
  layout.layoutGlyphs(grabbed).forEach((g, i) => { near(g.x, tp[i].x, 1e-6); near(g.y, tp[i].y, 1e-6, "nothing moves on a click"); });
  // Dragged on: the bent stretch turns as one piece around the selection start
  const swung = layout.layoutGlyphs(layout.bendAtSelection(twice, [2, 3, 4, 5], 1, [200 + (layout.pathEnds(twice.path)[1][0] - 200), -(layout.pathEnds(twice.path)[1][1])]));
  near(swung[1].x, tp[1].x, 1e-6, "kept part stays");
  near(swung[4].angle - swung[3].angle, tp[4].angle - tp[3].angle, 1e-6, "the corner keeps its angle");
  // Bézier paths: an arc as anchors keeps its circle
  const arcPath = { type: "arc", p0: [0, 0], p1: [400, 0], bend: -150 };
  const arcGeo = layout.arcGeometry(arcPath.p0, arcPath.p1, arcPath.bend);
  const asBez = layout.toBezier(arcPath);
  assert.strictEqual(asBez.type, "bezier");
  layout.samplePath(asBez).forEach((p) => near(Math.hypot(p[0] - arcGeo.center[0], p[1] - arcGeo.center[1]), arcGeo.radius, arcGeo.radius * 0.001, "on the circle"));
  near(layout.pathLength(asBez), layout.pathLength(arcPath), 0.5);
  // A split leaves the curve as it was
  const split = layout.splitBezierAt(asBez, 123);
  assert.strictEqual(split.path.nodes.length, asBez.nodes.length + 1);
  near(layout.pathLength(split.path), layout.pathLength(asBez), 0.01);
  const onArc = layout.pointAt(layout.measure(layout.samplePath(asBez)), 123);
  near(split.path.nodes[split.index].p[0], onArc.x, 0.01); near(split.path.nodes[split.index].p[1], onArc.y, 0.01, "anchor where asked");
  assert.strictEqual(layout.splitBezierAt(split.path, 123).path, split.path, "an anchor already there is used");
  // Stored and read back
  assert.deepStrictEqual(layout.normalizeModel({ text: "一", path: split.path }).path, split.path);
  // Ends move the whole Bézier path around the other end
  const swungBez = layout.moveEnd(asBez, 1, [0, 400]);
  near(layout.pathEnds(swungBez)[1][0], 0, 1e-6); near(layout.pathEnds(swungBez)[1][1], 400, 1e-6);
  // Bend just the selected stretch: the characters outside it stay put
  const local = layout.bendStretch(six, [2, 3], [0, -80]);
  const lp = layout.layoutGlyphs(local);
  const sp = layout.layoutGlyphs(six);
  [0, 1, 4, 5].forEach((i) => { near(lp[i].x, sp[i].x, 1e-3); near(lp[i].y, sp[i].y, 1e-3, "outside the stretch"); });
  assert.ok(lp[2].y < -20 && lp[3].y < -20, "the stretch bulges");
  near(lp[2].x + lp[3].x, 600, 1e-3, "symmetric");
  const knob = layout.stretchHandle(local, [2, 3]);
  near(knob[0], 300, 1e-3); near(knob[1], -80, 0.01, "its middle follows the pointer");
  assert.strictEqual(lp[2].size, 100, "room grows, size does not");
  assert.strictEqual(layout.stretchHandle(six, [2]), null, "one character: no stretch handle");
  // ... also on a path already bent, the earlier corner kept
  const localTwice = layout.bendStretch(twice, [1, 2], [30, -40]);
  const ltp = layout.layoutGlyphs(localTwice);
  [0, 3, 4, 5].forEach((i) => { near(ltp[i].x, tp[i].x, 1e-3); near(ltp[i].y, tp[i].y, 1e-3, "outside, on a bent path"); });
  // The middle handle of a Bézier path bends all of it, ends fixed
  const whole = layout.bendWhole(local.path, [0, 50]);
  assert.deepStrictEqual(layout.pathEnds(whole), layout.pathEnds(local.path));
  near(layout.pathMidpoint(whole)[1] - layout.pathMidpoint(local.path)[1], 50, 2);
  assert.deepStrictEqual(layout.bendHandle(whole), layout.pathMidpoint(whole));
  assert.deepStrictEqual(layout.pathAnchors(local.path).length, 2, "the stretch's two anchors");
  // Control handles: pull the stretch's two handles opposite ways -> an S
  assert.deepStrictEqual(layout.handleSegments(local, null, [2, 3]), [1], "the stretch's segment shows its handles");
  assert.deepStrictEqual(layout.handleSegments(local, 1, []), [0, 1], "a picked anchor shows both its segments");
  const hOut = layout.handlePoint(local.path, 1, "o");
  const hIn = layout.handlePoint(local.path, 2, "i");
  const sCurve = layout.moveHandle(layout.moveHandle(local, 1, "o", [hOut[0], hOut[1] + 200]), 2, "i", [hIn[0], hIn[1] - 120]);
  const sp2 = layout.layoutGlyphs(sCurve);
  [0, 1, 4, 5].forEach((i) => { near(sp2[i].x, sp[i].x, 1e-3); near(sp2[i].y, sp[i].y, 1e-3, "outside the S"); });
  const segPts = layout.samplePath(sCurve.path).filter((p) => p[0] > 200 && p[0] < 400);
  assert.ok(segPts.some((p) => p[1] > 5) && segPts.some((p) => p[1] < -5), "the stretch crosses its chord: an S");
  assert.strictEqual(sCurve.path.nodes.length, local.path.nodes.length, "no new anchors");
  // A smooth anchor keeps both handles in line, Alt breaks them
  const arcModel = Object.assign({}, six, { path: layout.toBezier({ type: "arc", p0: [0, 0], p1: [600, 0], bend: -200 }) });
  const smoothNode = arcModel.path.nodes[1];
  const pulled = layout.moveHandle(arcModel, 1, "o", [smoothNode.o[0] + 40, smoothNode.o[1] + 60]).path.nodes[1];
  const cross = (pulled.o[0] - pulled.p[0]) * (pulled.p[1] - pulled.i[1]) - (pulled.o[1] - pulled.p[1]) * (pulled.p[0] - pulled.i[0]);
  near(cross, 0, 1e-6, "still in line");
  near(Math.hypot(pulled.i[0] - pulled.p[0], pulled.i[1] - pulled.p[1]), Math.hypot(smoothNode.i[0] - smoothNode.p[0], smoothNode.i[1] - smoothNode.p[1]), 1e-6, "other handle keeps its length");
  const broken = layout.moveHandle(arcModel, 1, "o", [smoothNode.o[0] + 40, smoothNode.o[1] + 60], true).path.nodes[1];
  assert.deepStrictEqual(broken.i, smoothNode.i, "Alt: the other handle stays");
  // A straight segment's handle can be pulled out
  const pulledStraight = layout.moveHandle(bent, 1, "o", [300, 100]);
  assert.ok(pulledStraight.path.nodes[1].o && pulledStraight.path.nodes[2].i, "both control points of that segment set");
  // Moving an anchor: the characters past its segments stay
  const movedAnchor = layout.layoutGlyphs(layout.moveAnchor(local, 1, [200, 60]));
  [4, 5].forEach((i) => { near(movedAnchor[i].x, sp[i].x, 1e-3); near(movedAnchor[i].y, sp[i].y, 1e-3, "after the moved anchor"); });
  // Room is not size: spacing a character out keeps its size
  assert.strictEqual(bp[2].size, 100);
  // Remove some characters with their settings
  const removed = layout.removeGlyphs(turned, [0, 2]);
  assert.strictEqual(removed.text, "二四");
  assert.strictEqual(removed.glyphs[0].rot, 90);
  // Reset everything to a straight line at a given centre
  const messy = Object.assign({}, turned, { scale: 2, rotation: 40, startScale: 0.5, path: { type: "arc", p0: [0, 0], p1: [10, 300], bend: 50 } });
  const reset = layout.resetLayout(messy, { center: [200, 50] });
  assert.deepStrictEqual(reset.path, { type: "line", p0: [0, 50], p1: [400, 50] });
  assert.strictEqual(reset.scale, 1); assert.strictEqual(reset.rotation, 0); assert.strictEqual(reset.startScale, 1);
  assert.ok(reset.glyphs.every((g) => g.rot === 0 && g.scale === 1 && g.dx === 0 && g.space === 1));
  assert.strictEqual(reset.text, "一二三四");
  const resetVertical = layout.resetLayout(messy, { center: [0, 0], vertical: true });
  assert.deepStrictEqual(resetVertical.path.p0, [0, -200]); assert.strictEqual(resetVertical.upright, true);
}

/* ------------------------- glyph normalising ------------------------ */
{
  // Photoshop at 144 dpi: path in distanceUnit, layer bounds in px. The
  // reference 国 is a 90 px square around the slot centre (200, 300).
  const res = 144;
  const f = res / 72;
  const asDescriptor = (comps) => outline.buildPathContents(comps, outline.UNIT_DISTANCE, f);
  const ref = ring(155, 255, 90, 50);
  const hui = ring(160, 260, 80, 30);
  const samples = [
    { ch: glyphs.REFERENCE_CHAR, reference: true, pathContents: asDescriptor(ref), layerBounds: { left: 155, top: 255, right: 245, bottom: 345 } },
    { ch: "回", pathContents: asDescriptor(hui), layerBounds: { left: 160, top: 260, right: 240, bottom: 340 } },
    { ch: " ", pathContents: null, layerBounds: null },
  ];
  const result = glyphs.normalizeGlyphs({ samples, resolution: res, sizePx: 100 });
  near(result.factor, 2, 1e-9, "px per unit");
  assert.strictEqual(result.unit, "distanceUnit");
  near(result.em, 100, 1e-9);
  const box = outline.bounds(result.outlines["回"]);
  assert.deepStrictEqual([box.left, box.top, box.right, box.bottom], [-40, -40, 40, 40], "centred on the slot");
  assert.strictEqual(result.outlines["回"][0].paths.length, 2, "hole kept");
  assert.ok(!result.outlines[glyphs.REFERENCE_CHAR], "the reference is not a text character");
  near(result.referenceWidth, 90, 1e-9);
  // A layer rotated by 90° and scaled 2x: outlines come back upright, 2x
  const rot = { xx: 0, xy: 2, yx: -2, yy: 0 };
  const turn = (comps) => outline.transformComponents(comps, [0, 2, -2, 0, 0, 0]);
  const rotated = glyphs.normalizeGlyphs({
    samples: [
      { ch: glyphs.REFERENCE_CHAR, reference: true, pathContents: asDescriptor(turn(ring(-22.5, -22.5, 45, 25))) },
      { ch: "回", pathContents: asDescriptor(turn(ring(-20, -22.5, 40, 15))) },
    ],
    resolution: res, transform: rot, sizePx: 50,
  });
  const rbox = outline.bounds(rotated.outlines["回"]);
  assert.deepStrictEqual([rbox.left, rbox.top, rbox.right, rbox.bottom].map((v) => Math.round(v * 1000) / 1000), [-40, -45, 40, 35]);
  near(rotated.em, 100, 1e-9, "em includes the layer's scale");
  // A reported size that does not fit the outlines is replaced
  const wrongSize = glyphs.normalizeGlyphs({ samples: samples.slice(0, 2), resolution: res, sizePx: 1000 });
  near(wrongSize.em, 100, 1e-9);
  // Later typing of the same font at another size
  const scaled = glyphs.matchScale({ a: ring(-20, -20, 40, 10) }, 45, 90);
  assert.deepStrictEqual(outline.bounds(scaled.a).width, 80);
}

/* ------------------------------ payload ----------------------------- */
{
  const model = layout.initialModel({ text: "咔嚓&<\"", em: 80, color: { r: 1, g: 2, b: 3 } });
  const outlines = { "咔": ring(-10, -10, 20, 5), unused: ring(0, 0, 1, 0.5) };
  const data = payload.buildPayload({ model, outlines, font: { postScriptName: "SourceHanSans-Heavy" }, shape: payload.shapeSignature(ring(0, 0, 10, 4)) });
  assert.ok(!data.outlines.unused, "only the characters in use");
  assert.deepStrictEqual(data.shape, { points: 8, left: 0, top: 0, width: 10, height: 10 });
  const json = JSON.stringify(data);
  const xmp = payload.writeXmpData("", json);
  assert.ok(/<rdf:RDF/.test(xmp) && xmp.indexOf("<\"") < 0, "escaped");
  assert.strictEqual(payload.readXmpData(xmp), json);
  const parsed = payload.parsePayload(payload.readXmpData(xmp));
  assert.strictEqual(parsed.model.text, "咔嚓&<\"");
  assert.deepStrictEqual(parsed.font, { postScriptName: "SourceHanSans-Heavy" });
  // Other metadata survives; a second write replaces ours
  const foreign = "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description rdf:about=\"\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><dc:format>x</dc:format></rdf:Description></rdf:RDF></x:xmpmeta>";
  const twice = payload.writeXmpData(payload.writeXmpData(foreign, "one"), "two");
  assert.ok(/<dc:format>x<\/dc:format>/.test(twice));
  assert.strictEqual(payload.readXmpData(twice), "two");
  assert.strictEqual((twice.match(/lpsfx:data>/g) || []).length, 2, "one element (open + close)");
  // A toolkit may rename the prefix and use the attribute form
  const compact = "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description rdf:about=\"\" xmlns:ns1=\"" + payload.XMP_NS + "\" ns1:data=\"{&quot;a&quot;:&#x4E00;}\"/></rdf:RDF></x:xmpmeta>";
  assert.strictEqual(payload.readXmpData(compact), "{\"a\":一}");
  assert.strictEqual(payload.readXmpData(payload.writeXmpData(compact, null)), null, "removed");
  assert.strictEqual(payload.parsePayload("{\"v\":99,\"model\":{}}"), null, "newer payloads are refused");
  assert.strictEqual(payload.parsePayload("not json"), null);
  assert.strictEqual(payload.layerProperty(42.7), "layer42");
}

/* ------------------------- several layers -------------------------- */
{
  // targetLayersIDs come bottom to top; the editor lists them top first
  assert.deepStrictEqual(group.selectionOrder([3, 7, 7, 12]), [12, 7, 3]);
  assert.deepStrictEqual(group.selectionOrder([5, 0, -1, "x", 9]), [9, 5], "bad ids dropped");
  assert.deepStrictEqual(group.selectionOrder(null), []);

  // Layers that cannot open are left out; anything else stops the editor
  ["notText", "emptyText", "noOutlines", "badPayload"].forEach((code) => assert.ok(group.isSkippable(code), code));
  ["noDocument", "duplicate", "failed", undefined].forEach((code) => assert.ok(!group.isSkippable(code), String(code)));
  assert.deepStrictEqual(group.skipNotice("图层 3", "notText"), { key: "sfxLayerSkipped", layer: "图层 3", reason: "notText" });

  // A layer's notices name it only when several layers are open
  assert.deepStrictEqual(group.layerNotices(["sfxWarpIgnored", { key: "sfxPathEdited", detail: "x" }], "砰", false),
    [{ key: "sfxWarpIgnored" }, { key: "sfxPathEdited", detail: "x" }]);
  assert.deepStrictEqual(group.layerNotices(["sfxWarpIgnored"], "砰", true), [{ key: "sfxWarpIgnored", layer: "砰" }]);

  // The editor's models: one per layer; a missing one stays as it opened
  const a = layout.initialModel({ text: "砰", em: 40, color: { r: 0, g: 0, b: 0 } });
  const b = layout.initialModel({ text: "咚咚", em: 60, color: { r: 9, g: 9, b: 9 } });
  const a2 = Object.assign({}, a, { rotation: 12 });
  assert.deepStrictEqual(group.stateModels(null, [a, b]), [a, b]);
  assert.deepStrictEqual(group.stateModels({ models: [a2] }, [a, b]), [a2, b]);
  assert.deepStrictEqual(group.stateModels({ models: [null, a2] }, [a, b]), [a, a2]);
  assert.deepStrictEqual(group.stateModels({ model: a2 }, [a]), [a2], "single-layer state");
  assert.deepStrictEqual(group.stateModels({ model: a2 }, [a, b]), [a, b], "a single model is no answer for several layers");

  assert.strictEqual(group.clampIndex(5, 3), 2);
  assert.strictEqual(group.clampIndex(-1, 3), 0);
  assert.strictEqual(group.clampIndex(undefined, 3), 0);
  assert.strictEqual(group.clampIndex(1, 0), 0);

  assert.strictEqual(group.firstEmpty([a, b]), -1);
  assert.strictEqual(group.firstEmpty([a, Object.assign({}, b, { text: "" })]), 1);
  assert.strictEqual(group.firstEmpty([null]), 0);
}

console.log("SFX tests passed");
