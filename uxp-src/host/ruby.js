// Ruby (行间注) editor in the UXP host.
//
//   rubyOpen - the panel's "ruby" button. The selected point text layer (or
//              a ruby group made earlier, or any layer in one) opens in a
//              modal window (uxp/ruby, a WebView): the user picks characters
//              and writes a note for them. Apply puts the base layer and one
//              text layer per note in a group, in one undo step.
//
// Where each character sits comes from Type > Create Work Path on a copy of
// the base layer: one path component per glyph, in character order (see
// app_src/ruby/measure.js). A note layer is a copy of the base layer (so it
// has its font, colour and layer style) with the note as its text, sized,
// measured in Photoshop and moved into place. Each note layer keeps its
// note in its XMP metadata; Apply removes the old note layers and makes them
// again, which is also how "re-align" works after the base text was moved
// or edited. Notes may space the base characters out ("spread"): that
// tracking is in the payload, and taken back before every new layout.

const ps = require("photoshop");
const photoshop = require("./photoshop");
const { componentBoxes, componentPaths, pickFactor, mapGlyphs } = require("../../app_src/ruby/measure");
const { detectUnit } = require("../../app_src/sfx/outline");
const { normalizeNote, spanGeometry, planNote, placeNote, spreadDeltas, spreadRoom, widenSpan, mergeDeltas, overlaps, lineRoom, leadingTarget, noteLength } = require("../../app_src/ruby/layout");
const { lineGeometry } = require("../../app_src/ruby/measure");
const { emsOf, addTracking, overrideStyles, noteLayerText, isPlainScale, pixelsToTypeUnit, transformScale, leadingOf, setLeading, leadingTypeAt, takeBackStyles, hasTakeBack, styleAt } = require("../../app_src/ruby/textRanges");
const { buildPayload, parsePayload, readXmpData, writeXmpData, relocate, relocatedDeltas, relocatedLeading } = require("../../app_src/ruby/payload");
const { chars, utf16Offsets } = require("../../app_src/ruby/text");

const host = photoshop._internals;
const { play, get, modal } = host;

const EDITOR_URL = "plugin:/ruby/index.html";
const COMMAND = "LabelPlus-Nondum Ruby";
const TARGET_DOCUMENT = { _ref: "document", _enum: "ordinal", _value: "targetEnum" };
const TARGET_TEXT_LAYER = { _ref: "textLayer", _enum: "ordinal", _value: "targetEnum" };
const WORK_PATH = { _ref: "path", _property: "workPath" };
const layerRef = (id) => ({ _ref: "layer", _id: id });
const unitValue = (value) => (value !== null && typeof value === "object" && "_value" in value ? value._value : value);
const answer = (value) => JSON.stringify(value);
const errorText = (error) => String((error && error.message) || error || "");
const isModalError = (error) => /modal|busy|another plugin|executeAsModal/i.test(errorText(error));

let getStrings = () => ({});
let onDocumentChanged = () => {};
let canShowWindow = () => typeof document !== "undefined" && !!document.body;

function setup(options) {
  if (options && options.getStrings) getStrings = options.getStrings;
  if (options && options.onDocumentChanged) onDocumentChanged = options.onDocumentChanged;
  if (options && options.canShowWindow) canShowWindow = options.canShowWindow;
}

function rubyStrings() {
  const all = getStrings() || {};
  const result = {};
  Object.keys(all).forEach((key) => { if (/^ruby/.test(key)) result[key] = all[key]; });
  return result;
}

class RubyError extends Error {
  constructor(code, detail) {
    super(detail ? code + ": " + detail : code);
    this.code = code;
    this.detail = detail || "";
  }
}

// Development builds: make a step fail on purpose, to check the rollback
function testFailure(step) {
  if (typeof TYPER_DEV !== "undefined" && TYPER_DEV && globalThis.__rubyFailAt === step) throw new Error("test failure at " + step);
}

/* ------------------------------ layers ------------------------------ */

function documentInfo() {
  const doc = ps.app.activeDocument;
  if (!doc) throw new RubyError("noDocument");
  return { doc, id: doc.id, width: Number(doc.width), height: Number(doc.height), resolution: Number(doc.resolution) || 72 };
}

function layerProperty(id, property) {
  try {
    return get([{ _property: property }, layerRef(id)])[property];
  } catch (error) {
    return undefined;
  }
}

function layerBounds(id) {
  for (const property of ["boundsNoEffects", "bounds"]) {
    try {
      const b = get([{ _property: property }, layerRef(id)])[property];
      if (b) return { left: unitValue(b.left), top: unitValue(b.top), right: unitValue(b.right), bottom: unitValue(b.bottom) };
    } catch (error) {}
  }
  return null;
}

function selectLayer(id) {
  play({ _obj: "select", _target: [layerRef(id)], makeVisible: false });
}

function textKeyOf(id) {
  try {
    return get([{ _property: "textKey" }, layerRef(id)]).textKey || null;
  } catch (error) {
    return null;
  }
}

const isText = (layer) => !!layer && (layer.kind === "text" || layer.kind === ps.constants.LayerKind.TEXT);
const isGroup = (layer) => !!layer && (layer.kind === "group" || layer.kind === ps.constants.LayerKind.GROUP);

function findLayer(doc, id) {
  const walk = (layers) => {
    for (const layer of layers || []) {
      if (layer.id === id) return layer;
      const inner = layer.layers ? walk(layer.layers) : null;
      if (inner) return inner;
    }
    return null;
  };
  return walk(doc.layers);
}

function selectedLayerIds(info) {
  try {
    const result = get([{ _property: "targetLayersIDs" }, TARGET_DOCUMENT]);
    if (Array.isArray(result.targetLayersIDs)) return result.targetLayersIDs.map((reference) => reference._id);
  } catch (error) {}
  return (info.doc.activeLayers || []).map((layer) => layer.id);
}

function deleteLayer(id) {
  play({ _obj: "delete", _target: [layerRef(id)] });
}

function renameLayer(id, name) {
  play({ _obj: "set", _target: [layerRef(id)], to: { _obj: "layer", name } });
}

function duplicateLayer(id) {
  selectLayer(id);
  play({ _obj: "duplicate", _target: [layerRef(id)], version: 5 });
  const copyId = host._getActiveLayerId();
  if (!copyId || copyId === id) throw new RubyError("duplicate");
  return copyId;
}

// The selected layer's text, in jamText's simplified form
function jamTextOf(id) {
  selectLayer(id);
  const text = host._getLayerText();
  if (!text || !text.layerText) throw new RubyError("notText");
  return text;
}

function setJamText(id, layerText, typeUnit) {
  play({ _obj: "set", _target: [layerRef(id)], to: host.jamText.toLayerTextObject({ layerText, typeUnit }) });
}

/* ------------------------------- XMP -------------------------------- */

function readLayerXmp(id) {
  const metadata = layerProperty(id, "metadata");
  return metadata && typeof metadata.layerXMP === "string" ? metadata.layerXMP : "";
}

// { payload } for a note layer, { bad: true } for damaged or newer data
function readNote(id) {
  const text = readXmpData(readLayerXmp(id));
  if (!text) return null;
  const payload = parsePayload(text);
  return payload ? { payload } : { bad: true };
}

function writeNote(id, text) {
  const xmp = writeXmpData(readLayerXmp(id), text);
  const attempts = [
    () => play({ _obj: "set", _target: [{ _ref: "property", _property: "metadata" }, layerRef(id)], to: { _obj: "metadata", layerXMP: xmp } }),
    () => play({ _obj: "set", _target: [layerRef(id)], to: { _obj: "layer", metadata: { _obj: "metadata", layerXMP: xmp } } }),
  ];
  for (const attempt of attempts) {
    try {
      attempt();
      if (readXmpData(readLayerXmp(id)) === text) return;
    } catch (error) {}
  }
  throw new RubyError("metadata");
}

/* ----------------------------- history ------------------------------ */

async function inHistory(context, documentID, name, fn, { rollback = false } = {}) {
  const suspensionID = await context.hostControl.suspendHistory({ documentID, name });
  let result;
  try {
    result = await fn();
  } catch (error) {
    try {
      await context.hostControl.resumeHistory(suspensionID, false);
    } catch (resumeError) {
      console.error("Ruby: rollback failed", resumeError);
    }
    throw error;
  }
  await context.hostControl.resumeHistory(suspensionID, !rollback);
  return result;
}

/* ------------------------------- paths ------------------------------ */

function readWorkPath() {
  for (const target of [[{ _property: "pathContents" }, WORK_PATH], [WORK_PATH]]) {
    try {
      const result = get(target);
      if (result && result.pathContents && result.pathContents.pathComponents) return result.pathContents;
    } catch (error) {}
  }
  return null;
}

function deleteWorkPath() {
  try {
    play({ _obj: "delete", _target: [WORK_PATH] });
  } catch (error) {}
}

function restoreWorkPath(saved) {
  if (saved) {
    try {
      play({ _obj: "set", _target: [WORK_PATH], to: saved });
      play({ _obj: "deselect", _target: [{ _ref: "path", _enum: "ordinal", _value: "targetEnum" }] });
    } catch (error) {}
  } else deleteWorkPath();
}

async function makeWorkPathFromSelectedText() {
  try {
    play({ _obj: "make", _target: [{ _ref: "path" }], from: TARGET_TEXT_LAYER });
  } catch (playError) {
    const layer = ps.app.activeDocument.activeLayers[0];
    if (layer && layer.textItem && typeof layer.textItem.createWorkPath === "function") await layer.textItem.createWorkPath();
    else throw playError;
  }
}

/* ------------------------------ base ------------------------------- */

// A base layer: point text, not warped, only scaled
function checkBase(id) {
  const textKey = textKeyOf(id);
  if (!textKey) throw new RubyError("notText");
  const text = String(textKey.textKey || "");
  if (!text.replace(/[\s\u0003]/g, "")) throw new RubyError("emptyText");
  const shape = textKey.textShape && textKey.textShape[0];
  const type = shape && (shape.char || shape.textType);
  if (type && unitValue(type) !== "paint") throw new RubyError("paragraph");
  const warp = textKey.warp && unitValue(textKey.warp.warpStyle);
  if (warp && warp !== "warpNone") throw new RubyError("warped");
  if (!isPlainScale(textKey.transform)) throw new RubyError("transformed");
  return { text, vertical: !!(shape && unitValue(shape.orientation) === "vertical") };
}

// Where each character of the base layer sits, measured on a copy (the
// base itself is never changed here). `takeBack`: what earlier notes did
// to the base ({ tracking, leading }), taken back first. Faux bold refuses Create Work Path, and a
// ligature merges glyphs: tried again without them.
//   { text, vertical, glyphs, ems, typeUnit, layerText }
async function measureBase(info, baseId, takeBack, withPaths = false) {
  const jam = jamTextOf(baseId);
  const layerText = takeBackStyles(jam.layerText, takeBack);
  const text = String(layerText.textKey || "");
  const shape = layerText.textShape && layerText.textShape[0];
  const vertical = !!(shape && (shape.orientation === "vertical" || unitValue(shape.orientation) === "vertical"));
  const copyId = duplicateLayer(baseId);
  try {
    if (layerProperty(copyId, "visible") === false) {
      try {
        play({ _obj: "show", _target: [layerRef(copyId)] });
      } catch (error) {}
    }
    const attempts = [
      null,
      { syntheticBold: false, syntheticItalic: false },
      { syntheticBold: false, syntheticItalic: false, ligature: false, altligature: false },
    ];
    let lastError = "";
    let mapped = null;
    for (let i = 0; i < attempts.length; i++) {
      const override = attempts[i];
      if (override || hasTakeBack(takeBack)) setJamText(copyId, override ? overrideStyles(layerText, override) : layerText, jam.typeUnit);
      selectLayer(copyId);
      deleteWorkPath();
      try {
        await makeWorkPathFromSelectedText();
      } catch (error) {
        lastError = errorText(error);
        continue;
      }
      const pathContents = readWorkPath();
      deleteWorkPath();
      if (!pathContents) continue;
      const raw = componentBoxes(pathContents, 1);
      const factor = pickFactor(raw, layerBounds(copyId), detectUnit(pathContents), info.resolution);
      mapped = mapGlyphs(text, componentBoxes(pathContents, factor), withPaths ? componentPaths(pathContents, factor) : null);
      if (mapped.ok) break;
      lastError = "found " + mapped.found + " glyphs for " + mapped.inked + " characters";
    }
    if (!mapped) throw new RubyError("noOutlines", lastError);
    if (!mapped.ok) throw new RubyError("mismatch", lastError);
    return { text, vertical, glyphs: mapped.glyphs, ems: emsOf({ layerText, typeUnit: jam.typeUnit }, info.resolution), typeUnit: jam.typeUnit, layerText };
  } finally {
    try {
      deleteLayer(copyId);
    } catch (error) {}
  }
}

/* ----------------------------- session ------------------------------ */

const textChildren = (group) => (group.layers || []).filter(isText);

// What the selection opens: { base, group (null: a new one), notes }
// - a ruby group, or any layer in one (a note or its base)
// - any other point text layer (new notes)
function resolveSelection(info) {
  const ids = selectedLayerIds(info);
  if (ids.length !== 1) throw new RubyError("selectOne");
  const layer = findLayer(info.doc, ids[0]);
  if (!layer) throw new RubyError("selectOne");
  let group = null;
  let base = null;
  if (isGroup(layer)) group = layer;
  else if (isText(layer)) {
    const own = readNote(layer.id);
    const parent = layer.parent && isGroup(layer.parent) ? layer.parent : null;
    if (own) {
      if (!parent) throw new RubyError("noBase");
      group = parent;
    } else {
      base = layer;
      group = parent;
    }
  } else throw new RubyError("notText");
  const notes = [];
  const others = [];
  if (group) {
    textChildren(group).forEach((child) => {
      const read = readNote(child.id);
      if (read && read.bad) throw new RubyError("badPayload");
      if (read) notes.push({ layerId: child.id, payload: read.payload });
      else others.push(child);
    });
  }
  if (!notes.length) {
    // A text layer in an ordinary group: new notes (the ruby group goes
    // inside that group); a group without notes is no ruby group
    if (!base) throw new RubyError("notText");
    return { base, group: null, notes: [] };
  }
  if (!base) base = others.find((child) => child.id === notes[0].payload.base) || (others.length === 1 ? others[0] : null);
  if (!base) throw new RubyError("noBase");
  return { base, group, notes };
}

// Everything the editor needs, read in a history suspension that is rolled
// back: the base measured without the old notes' tracking, and the page
// (old note layers out, base tracking back) for the backdrop
async function startSession() {
  const info = documentInfo();
  const selection = resolveSelection(info);
  const baseId = selection.base.id;
  const checked = checkBase(baseId);
  const textLength = chars(checked.text).length;
  const notices = [];
  let tracking = [];
  let leading = [];
  const notes = selection.notes.map((entry, i) => {
    const located = relocate(entry.payload, checked.text);
    tracking = tracking.concat(relocatedDeltas(entry.payload, located, textLength));
    // Notes of one line share its old leading: one entry per character
    relocatedLeading(entry.payload, located, textLength).forEach((saved) => {
      if (!leading.some((other) => other.index === saved.index)) leading.push(saved);
    });
    const key = located.status === "moved" ? "rubyNoteMoved" : located.status === "lost" ? "rubyNoteLost" : null;
    if (key && notices.indexOf(key) < 0) notices.push(key);
    return Object.assign({}, entry.payload.note, { id: "n" + (i + 1), start: located.start, end: located.end, lost: located.status === "lost" });
  });
  const takeBack = { tracking: mergeDeltas([tracking]), leading };
  const read = await modal(COMMAND, (context) => inHistory(context, info.id, "Ruby read", async () => {
    // How the base looks, for drawing it in the editor: its stroke (layer style)
    let stroke = null;
    try {
      selectLayer(baseId);
      const found = host._getLayerStroke();
      if (found && found.enabled !== false && found.size > 0) stroke = { size: Number(found.size) || 0, color: found.color, opacity: Number(found.opacity) / 100 || 1, outer: found.position === "outer" };
    } catch (error) {}
    const measured = await measureBase(info, baseId, takeBack, true);
    // The page without the base and its notes: the editor draws the base
    // from its outlines, where Apply will move it
    let preview = null;
    try {
      preview = await require("./sfx")._internals.capturePreview(info, selection.notes.map((entry) => entry.layerId).concat([baseId]));
    } catch (error) {
      console.error("Ruby: preview", error);
    }
    return { measured, preview, stroke };
  }, { rollback: true }));
  const style = (read.measured.layerText.textStyleRange && read.measured.layerText.textStyleRange[0] && read.measured.layerText.textStyleRange[0].textStyle) || {};
  const stroke = read.stroke;
  const opacity = Number(unitValue(layerProperty(baseId, "opacity")));
  return {
    look: { stroke, opacity: isFinite(opacity) ? Math.max(0, Math.min(1, opacity / 255)) : 1 },
    docId: info.id,
    baseId,
    baseName: selection.base.name,
    groupId: selection.group ? selection.group.id : null,
    noteLayerIds: selection.notes.map((entry) => entry.layerId),
    takeBack,
    measured: read.measured,
    preview: read.preview,
    notes,
    notices,
    font: { name: style.fontName || "", style: style.fontStyleName || "", postScriptName: style.fontPostScriptName || "", color: rgbOf(style.color) },
  };
}

// 0-255 RGB of a text colour, for the editor's preview
function rgbOf(color) {
  if (!color || typeof color !== "object") return null;
  const value = (v) => Number(unitValue(v));
  let rgb = null;
  if ("red" in color && "blue" in color) rgb = { r: value(color.red), g: value("green" in color ? color.green : color.grain), b: value(color.blue) };
  else if ("redFloat" in color) rgb = { r: value(color.redFloat) * 255, g: value(color.greenFloat) * 255, b: value(color.blueFloat) * 255 };
  if (!rgb || ![rgb.r, rgb.g, rgb.b].every(isFinite)) return null;
  return { r: Math.round(rgb.r), g: Math.round(rgb.g), b: Math.round(rgb.b) };
}

/* ------------------------------- apply ------------------------------ */

const strings = () => getStrings() || {};
const shorten = (text, n) => {
  const list = chars(String(text || "").replace(/[\r\n\u0003]+/g, " ").trim());
  return list.length > n ? list.slice(0, n).join("") + "…" : list.join("");
};

function noteLayerName(note) {
  return (strings().rubyLayerPrefix || "Note: ") + shorten(note.text, 30);
}

function groupName(text) {
  return (strings().rubyGroupPrefix || "Ruby: ") + shorten(text, 12);
}

// The note layer's style for a size in px, measured: its length along the
// line (ink), in px
function noteStyler(info, measured, layerId, note) {
  const offsets = utf16Offsets(chars(measured.text));
  const at = offsets[note.start] || 0;
  const scale = transformScale(measured.layerText.transform);
  const scaleKey = measured.vertical ? "verticalScale" : "horizontalScale";
  const cache = {};
  const set = (text, size, tracking, k) => {
    const sizeUnit = pixelsToTypeUnit(size, measured.typeUnit, info.resolution) / scale;
    setJamText(layerId, noteLayerText(measured.layerText, at, { text, size: Math.round(sizeUnit * 1000) / 1000, tracking, scale: k, scaleKey }), measured.typeUnit);
  };
  const length = () => {
    const b = layerBounds(layerId);
    return b ? (measured.vertical ? b.bottom - b.top : b.right - b.left) : 0;
  };
  return {
    measure: (text, size, tracking = 0, k = 1) => {
      const key = [size.toFixed(3), Math.round(tracking), k.toFixed(4)].join("|");
      if (!(key in cache)) {
        set(text, size, tracking, k);
        cache[key] = length();
      }
      return cache[key];
    },
    set,
  };
}

// Moves the note layer so its ink lands on rect
function moveNote(layerId, rect, vertical) {
  const b = layerBounds(layerId);
  if (!b) return;
  const crossNow = vertical ? (b.left + b.right) / 2 : (b.top + b.bottom) / 2;
  const mainNow = vertical ? b.top : b.left;
  const dCross = rect.cross - crossNow;
  const dMain = rect.main0 - mainNow;
  selectLayer(layerId);
  host._moveLayer(vertical ? dCross : dMain, vertical ? dMain : dCross);
}

// Notes the editor sent, as Apply takes them: text and characters checked
function usableNotes(session, rawNotes, measured) {
  const lines = lineGeometry(measured.glyphs, measured.vertical);
  const normalized = (rawNotes || []).map((raw, i) => normalizeNote(raw, i));
  const overlapping = overlaps(normalized);
  return normalized.filter((note) => {
    if (!note.text.trim() || overlapping.has(note.id)) return false;
    const span = spanGeometry(measured.glyphs, lines, measured.ems, measured.vertical, note.start, note.end);
    return !span.error;
  });
}

// All notes written in one history state; any error leaves the document as
// it was. Old note layers are removed and made again from the base.
async function applyNotes(session, rawNotes) {
  const info = documentInfo();
  if (info.id !== session.docId) throw new RubyError("documentChanged");
  const baseId = session.baseId;
  if (!findLayer(info.doc, baseId)) throw new RubyError("sourceGone");
  const notes = usableNotes(session, rawNotes, session.measured);
  const historyName = strings().rubyHistoryName || "Ruby";
  const result = await modal(COMMAND, (context) => inHistory(context, info.id, historyName, async () => {
    const savedWorkPath = readWorkPath();
    // The base without the old notes' tracking
    const jam = jamTextOf(baseId);
    const clean = takeBackStyles(jam.layerText, session.takeBack);
    if (hasTakeBack(session.takeBack)) setJamText(baseId, clean, jam.typeUnit);
    session.noteLayerIds.forEach((id) => {
      if (findLayer(info.doc, id)) deleteLayer(id);
    });
    testFailure("afterDelete");
    let groupId = session.groupId && findLayer(info.doc, session.groupId) ? session.groupId : null;
    if (!notes.length) {
      // No notes left: the base leaves the group (and the group goes)
      if (groupId) {
        selectLayer(groupId);
        play({ _obj: "ungroupLayersEvent", _target: [layerRef(groupId)] });
      }
      restoreWorkPath(savedWorkPath);
      selectLayer(baseId);
      return { groupId: null, layerIds: [] };
    }
    if (!groupId) {
      selectLayer(baseId);
      play({ _obj: "make", _target: [{ _ref: "layerSection" }], from: { _ref: "layer", _enum: "ordinal", _value: "targetEnum" }, using: { _obj: "layerSection", name: groupName(clean.textKey) } });
      groupId = host._getActiveLayerId();
      if (!groupId || groupId === baseId) throw new RubyError("group");
    }
    testFailure("afterGroup");
    // First layout: each note's size, on the base as it is now
    let measured = await measureBase(info, baseId, []);
    let lines = lineGeometry(measured.glyphs, measured.vertical);
    const entries = notes.slice().reverse().map((note) => {
      const layerId = duplicateLayer(baseId);
      renameLayer(layerId, noteLayerName(note));
      return { note, layerId };
    }).reverse();
    entries.forEach((entry) => {
      entry.span = spanGeometry(measured.glyphs, lines, measured.ems, measured.vertical, entry.note.start, entry.note.end);
      if (entry.span.error) throw new RubyError("span", entry.note.text);
      entry.styler = noteStyler(info, measured, entry.layerId, entry.note);
      entry.plan = planNote(entry.span, entry.note, entry.styler.measure);
      entry.deltas = spreadDeltas(entry.span, entry.plan.baseExtra, measured.ems);
      entry.room = spreadRoom(entry.span, entry.plan.baseExtra);
    });
    testFailure("afterPlan");
    // Spread notes space the base characters out; lines too close to the
    // line before for their notes move away (leading). Then measured again.
    const deltas = mergeDeltas(entries.map((entry) => entry.deltas));
    const room = lineRoom(measured.glyphs, measured.ems, measured.vertical, entries.map((entry) => ({ note: entry.note, span: entry.span, plan: entry.plan })));
    const tracked = deltas.length ? addTracking(clean, deltas, 1) : clean;
    const offsets = utf16Offsets(chars(clean.textKey));
    const layerScale = transformScale(clean.transform);
    room.forEach((entry) => {
      entry.target = leadingTarget(entry, leadingTypeAt(clean, offsets[entry.indices[0]] || 0), measured.vertical);
      entry.value = Math.round((pixelsToTypeUnit(entry.required, jam.typeUnit, info.resolution) / layerScale) * 100) / 100;
    });
    const withLeading = () => room.reduce((text, entry) => setLeading(text, entry.target, entry.value), tracked);
    if (deltas.length || room.length) {
      setJamText(baseId, withLeading(), jam.typeUnit);
      measured = await measureBase(info, baseId, null);
      lines = lineGeometry(measured.glyphs, measured.vertical);
      // A Photoshop version that counts leading the other way: every line
      // flipped together (one line's leading moves the lines after it, so
      // flipping only the lines that missed can undo the room of another),
      // kept only if fewer lines miss
      const missedNow = () => room.filter((entry) => lines[entry.line] && lines[entry.line - 1] && Math.abs(lines[entry.line].cross - lines[entry.line - 1].cross) < entry.required - 1).length;
      const missed = missedNow();
      if (missed) {
        const flip = () => room.forEach((entry) => { entry.target = entry.target === entry.before ? entry.indices : entry.before; });
        const relayout = async () => {
          setJamText(baseId, withLeading(), jam.typeUnit);
          measured = await measureBase(info, baseId, null);
          lines = lineGeometry(measured.glyphs, measured.vertical);
        };
        flip();
        await relayout();
        if (missedNow() >= missed) {
          flip();
          await relayout();
        }
      }
    }
    // The leading each note's room replaced, kept with the note to put back
    const savedLeading = {};
    room.forEach((entry) => { savedLeading[entry.line] = leadingOf(clean, entry.target); });
    entries.forEach((entry) => {
      const glyphSpan = spanGeometry(measured.glyphs, lines, measured.ems, measured.vertical, entry.note.start, entry.note.end);
      if (glyphSpan.error) throw new RubyError("span", entry.note.text);
      const span = widenSpan(glyphSpan, entry.room);
      const { plan } = entry;
      entry.styler.set(entry.note.text, plan.size, plan.tracking, plan.scale);
      // The length Photoshop gives at the final settings
      const placed = Object.assign({}, plan, { length: entry.styler.measure(entry.note.text, plan.size, plan.tracking, plan.scale) });
      moveNote(entry.layerId, placeNote(span, placed, entry.note, measured.vertical), measured.vertical);
      writeNote(entry.layerId, JSON.stringify(buildPayload({ note: entry.note, baseId, baseText: clean.textKey, deltas: entry.deltas, leading: savedLeading[entry.span.line] || [] })));
    });
    testFailure("afterNotes");
    restoreWorkPath(savedWorkPath);
    selectLayer(baseId);
    return { groupId, layerIds: entries.map((entry) => entry.layerId), deltas, room };
  }));
  onDocumentChanged();
  return result;
}

/* ------------------------------ window ------------------------------ */

function editorInit(session, notices, state) {
  const m = session.measured;
  return {
    vertical: m.vertical,
    text: m.text,
    glyphs: m.glyphs.map((g) => ({ index: g.index, ch: g.ch, line: g.line, box: g.box, path: g.path || null, color: g.box ? rgbOf(styleAt(m.layerText, g.offset).color) : null })),
    look: session.look || null,
    ems: m.ems,
    notes: (state && Array.isArray(state.notes)) ? state.notes : session.notes,
    mode: session.groupId ? "update" : "new",
    baseName: session.baseName,
    font: session.font,
    preview: session.preview,
    document: (() => {
      const info = documentInfo();
      return { width: info.width, height: info.height, resolution: info.resolution };
    })(),
    view: (state && state.view) || null,
    notices,
    strings: rubyStrings(),
    theme: (() => {
      try {
        return document.theme.getCurrent();
      } catch (error) {
        return "darkest";
      }
    })(),
  };
}

// The editor window. Resolves with {action: "apply" | "cancel", state}
function showEditor(init) {
  return new Promise((resolve) => {
    const title = (init.strings && init.strings.rubyTitle) || "Ruby";
    // A WebView at height: 100% is 0 px tall in a UXP dialog (Photoshop 27):
    // the dialog is a flex column the WebView fills
    const dialog = document.createElement("dialog");
    dialog.style.padding = "0";
    dialog.style.margin = "0";
    dialog.style.display = "flex";
    dialog.style.flexDirection = "column";
    dialog.style.height = "100%";
    const view = document.createElement("webview");
    view.style.flex = "1";
    view.style.width = "100%";
    view.style.border = "0";
    dialog.appendChild(view);
    document.body.appendChild(dialog);
    let outcome = null;
    let closed = false;
    // Development builds: the live check drives the window (scripts/rubyLiveCheck.js)
    const devLog = typeof TYPER_DEV !== "undefined" && TYPER_DEV ? (globalThis.__rubyEditor = { dialog, view, log: [], finish: (result) => finish(result), post: (message) => send(message) }).log : null;
    const send = (message) => {
      try {
        view.postMessage(JSON.stringify(message));
      } catch (error) {
        console.error("Ruby: message to the editor", error);
      }
    };
    const finish = (result) => {
      if (outcome) return;
      outcome = result;
      try {
        dialog.close(result.action);
      } catch (error) {}
    };
    const onMessage = (event) => {
      let message = event.message !== undefined ? event.message : event.data;
      for (let depth = 0; typeof message === "string" && depth < 2; depth++) {
        try {
          message = JSON.parse(message);
        } catch (error) {
          return;
        }
      }
      if (!message || typeof message !== "object" || closed) return;
      if (devLog) devLog.push(message.type === "devResult" ? { op: message.op, result: message.result } : message.type);
      if (message.type === "ready") send({ type: "init", init });
      else if (message.type === "apply") finish({ action: "apply", state: message.state });
      else if (message.type === "cancel") finish({ action: "cancel" });
      else if (message.type === "log") console.log("Ruby editor:", message.text);
    };
    view.addEventListener("message", onMessage);
    const onWindowMessage = (event) => {
      if (event.source === view) onMessage(event);
    };
    window.addEventListener("message", onWindowMessage);
    view.src = EDITOR_URL;
    dialog.uxpShowModal({ title, resize: "both", size: { width: 1180, height: 780 } })
      .catch(() => null)
      .then(() => {
        closed = true;
        view.removeEventListener("message", onMessage);
        window.removeEventListener("message", onWindowMessage);
        try {
          dialog.remove();
        } catch (error) {}
        resolve(outcome || { action: "cancel" });
      });
  });
}

let busy = false;

function failure(error) {
  const code = error instanceof RubyError ? error.code : "failed";
  return answer({ ok: false, code, message: error instanceof RubyError ? error.detail : errorText(error) });
}

async function rubyOpen() {
  if (busy) return answer({ ok: false, code: "busy" });
  busy = true;
  try {
    if (!canShowWindow()) throw new RubyError("noPanel");
    if (!host.hasDocument()) throw new RubyError("noDocument");
    const session = await startSession();
    let notices = session.notices.slice();
    let state = null;
    for (;;) {
      const result = await showEditor(editorInit(session, notices, state));
      notices = [];
      if (result.action !== "apply") return answer({ ok: true, code: "cancel" });
      state = result.state || state;
      try {
        const done = await applyNotes(session, (state && state.notes) || []);
        return answer({ ok: true, code: "applied", groupId: done.groupId, layerIds: done.layerIds });
      } catch (error) {
        console.error("Ruby: apply", error);
        notices.push({ key: "rubyApplyFailed", detail: errorText(error) });
      }
    }
  } catch (error) {
    console.error("Ruby:", error);
    return failure(error);
  } finally {
    busy = false;
  }
}

module.exports = {
  setup,
  methods: { rubyOpen },
  // development builds and the live check (scripts/rubyLiveCheck.js)
  _internals: { startSession, applyNotes, editorInit, resolveSelection, checkBase, measureBase, readNote, layerBounds, noteLength },
};
