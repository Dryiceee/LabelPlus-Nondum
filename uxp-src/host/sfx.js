// SFX editor in the UXP host.
//
//   sfxOpen  - the panel's "SFX editor" button. The selected text layer (or
//              an SFX shape layer made earlier) opens in a large modal window
//              (uxp/sfx, a WebView); Apply writes one native shape layer.
//              With several layers selected, all of them open together
//              (one session each) and Apply writes each, in one undo step.
//
// Photoshop draws the glyphs itself: each character is typed into a copy of
// the source text layer and turned into a work path (Type > Create Work
// Path), inside a history suspension that is rolled back, so reading never
// changes the document. Apply replaces the text layer by a solid colour fill
// layer whose vector mask holds the whole SFX, in one history state; any
// error rolls the document back. The source text, the settings and the
// glyph outlines go into the shape layer's XMP metadata (saved in the PSD).

const ps = require("photoshop");
const photoshop = require("./photoshop");
const { normalizeGlyphs, matchScale, REFERENCE_CHAR } = require("../../app_src/sfx/glyphs");
const { buildPathContents, parsePathContents, bounds, unitFactor, UNIT_DISTANCE } = require("../../app_src/sfx/outline");
const { initialModel, normalizeModel, composeShape, chars, translatePath } = require("../../app_src/sfx/layout");
const { buildPayload, parsePayload, readXmpData, writeXmpData, shapeSignature, layerProperty: documentProperty } = require("../../app_src/sfx/payload");
const { isSkippable, selectionOrder, skipNotice, layerNotices, stateModels, clampIndex } = require("../../app_src/sfx/group");

const host = photoshop._internals;
const { play, get, modal } = host;

const EDITOR_URL = "plugin:/sfx/index.html";
const COMMAND = "LabelPlus-Nondum SFX";
const TARGET_DOCUMENT = { _ref: "document", _enum: "ordinal", _value: "targetEnum" };
const TARGET_TEXT_LAYER = { _ref: "textLayer", _enum: "ordinal", _value: "targetEnum" };
const WORK_PATH = { _ref: "path", _property: "workPath" };
const VECTOR_MASK = { _ref: "path", _enum: "path", _value: "vectorMask" };
const layerRef = (id) => ({ _ref: "layer", _id: id });
const unitValue = (value) => (value !== null && typeof value === "object" && "_value" in value ? value._value : value);
const answer = (value) => JSON.stringify(value);
const errorText = (error) => String((error && error.message) || error || "");
const isModalError = (error) => /modal|busy|another plugin|executeAsModal/i.test(errorText(error));

let getStrings = () => ({});
let onDocumentChanged = () => {};
// The window is a dialog of the panel's page: never shown without the panel
let canShowWindow = () => typeof document !== "undefined" && !!document.body;

function setup(options) {
  if (options && options.getStrings) getStrings = options.getStrings;
  if (options && options.onDocumentChanged) onDocumentChanged = options.onDocumentChanged;
  if (options && options.canShowWindow) canShowWindow = options.canShowWindow;
}

function sfxStrings() {
  const all = getStrings() || {};
  const result = {};
  Object.keys(all).forEach((key) => { if (/^sfx/.test(key) || key === "ok" || key === "cancel") result[key] = all[key]; });
  return result;
}

class SfxError extends Error {
  constructor(code, detail) {
    super(detail ? code + ": " + detail : code);
    this.code = code;
    this.detail = detail || "";
  }
}

// Development builds: make a step fail on purpose, to check the rollback
function testFailure(step) {
  if (typeof TYPER_DEV !== "undefined" && TYPER_DEV && globalThis.__sfxFailAt === step) throw new Error("test failure at " + step);
}

/* ------------------------------ layers ------------------------------ */

function documentInfo() {
  const doc = ps.app.activeDocument;
  if (!doc) throw new SfxError("noDocument");
  return { doc, id: doc.id, width: Number(doc.width), height: Number(doc.height), resolution: Number(doc.resolution) || 72 };
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

function layerProperty(id, property) {
  try {
    return get([{ _property: property }, layerRef(id)])[property];
  } catch (error) {
    return undefined;
  }
}

function selectLayer(id) {
  play({ _obj: "select", _target: [layerRef(id)], makeVisible: false });
}

function textKeyOf(id) {
  const result = get([{ _property: "textKey" }, layerRef(id)]);
  return result.textKey || null;
}

// 0-255 integers (Photoshop reports e.g. 200.0000033)
function rgbOf(color) {
  const rgb = rawRgbOf(color);
  if (!rgb) return null;
  const channel = (v) => Math.max(0, Math.min(255, Math.round(Number(v) || 0)));
  return { r: channel(rgb.r), g: channel(rgb.g), b: channel(rgb.b) };
}

function rawRgbOf(color) {
  if (!color || typeof color !== "object") return null;
  const value = (key) => Number(unitValue(color[key]));
  if ("red" in color && ("green" in color || "grain" in color) && "blue" in color) {
    return { r: value("red"), g: Number(unitValue("green" in color ? color.green : color.grain)), b: value("blue") };
  }
  if ("redFloat" in color) return { r: value("redFloat") * 255, g: value("greenFloat") * 255, b: value("blueFloat") * 255 };
  return null;
}

// The text colour: the descriptor's RGB, else the DOM's conversion
function textColor(layer, textStyle) {
  const fromStyle = rgbOf(textStyle && textStyle.color);
  if (fromStyle) return fromStyle;
  try {
    const rgb = layer.textItem.characterStyle.color.rgb;
    return { r: rgb.red, g: rgb.green, b: rgb.blue };
  } catch (error) {
    return { r: 0, g: 0, b: 0 };
  }
}

// The fill colour of a solid colour (shape) layer
function fillColor(id) {
  try {
    const adjustment = layerProperty(id, "adjustment");
    const entry = Array.isArray(adjustment) ? adjustment[0] : adjustment;
    return rgbOf(entry && entry.color);
  } catch (error) {
    return null;
  }
}

const colorDescriptor = (color) => ({ _obj: "RGBColor", red: color.r, grain: color.g, blue: color.b });

/* ------------------------------ paths ------------------------------- */

function readPathContents(targets) {
  for (const target of targets) {
    try {
      const result = get(target);
      if (result && result.pathContents && result.pathContents.pathComponents) return result.pathContents;
    } catch (error) {}
  }
  return null;
}

const readWorkPath = () => readPathContents([[{ _property: "pathContents" }, WORK_PATH], [WORK_PATH]]);
const readVectorMask = (id) => readPathContents([[{ _property: "pathContents" }, VECTOR_MASK, layerRef(id)], [VECTOR_MASK, layerRef(id)]]);

async function makeWorkPathFromText(layer) {
  try {
    play({ _obj: "make", _target: [{ _ref: "path" }], from: TARGET_TEXT_LAYER });
    return;
  } catch (playError) {
    if (layer && layer.textItem && typeof layer.textItem.createWorkPath === "function") {
      await layer.textItem.createWorkPath();
      return;
    }
    throw playError;
  }
}

function setWorkPath(pathContents) {
  play({ _obj: "set", _target: [WORK_PATH], to: pathContents });
  try {
    play({ _obj: "select", _target: [WORK_PATH] });
  } catch (error) {}
}

function deleteWorkPath() {
  try {
    play({ _obj: "delete", _target: [WORK_PATH] });
  } catch (error) {}
}

// The user's own work path survives an apply
function restoreWorkPath(saved) {
  if (saved) {
    try {
      play({ _obj: "set", _target: [WORK_PATH], to: saved });
      play({ _obj: "deselect", _target: [{ _ref: "path", _enum: "ordinal", _value: "targetEnum" }] });
    } catch (error) {}
  } else deleteWorkPath();
}

function hasVectorMask(id) {
  return !!layerProperty(id, "hasVectorMask");
}

/* ------------------------------- XMP -------------------------------- */

function readLayerXmp(id) {
  const metadata = layerProperty(id, "metadata");
  return metadata && typeof metadata.layerXMP === "string" ? metadata.layerXMP : "";
}

function readDocumentXmp() {
  try {
    return get([{ _property: "XMPMetadataAsUTF8" }, TARGET_DOCUMENT]).XMPMetadataAsUTF8 || "";
  } catch (error) {
    return "";
  }
}

// Layer XMP first; the document's XMP (one property per layer ID) when a
// Photoshop version refuses layer metadata
function readPayloadText(id) {
  const own = readXmpData(readLayerXmp(id));
  if (own) return { text: own, where: "layer" };
  const shared = readXmpData(readDocumentXmp(), documentProperty(id));
  return shared ? { text: shared, where: "document" } : null;
}

function writePayloadText(id, text) {
  const xmp = writeXmpData(readLayerXmp(id), text);
  const attempts = [
    () => play({ _obj: "set", _target: [{ _ref: "property", _property: "metadata" }, layerRef(id)], to: { _obj: "metadata", layerXMP: xmp } }),
    () => play({ _obj: "set", _target: [layerRef(id)], to: { _obj: "layer", metadata: { _obj: "metadata", layerXMP: xmp } } }),
  ];
  for (const attempt of attempts) {
    try {
      attempt();
      if (readXmpData(readLayerXmp(id)) === text) {
        clearDocumentPayload(id);
        return "layer";
      }
    } catch (error) {}
  }
  const documentXmp = writeXmpData(readDocumentXmp(), text, documentProperty(id));
  play({ _obj: "set", _target: [{ _ref: "property", _property: "XMPMetadataAsUTF8" }, TARGET_DOCUMENT], to: { _obj: "document", XMPMetadataAsUTF8: documentXmp } });
  if (readXmpData(readDocumentXmp(), documentProperty(id)) !== text) throw new SfxError("metadata");
  return "document";
}

function clearDocumentPayload(id) {
  const current = readDocumentXmp();
  if (!readXmpData(current, documentProperty(id))) return;
  try {
    play({ _obj: "set", _target: [{ _ref: "property", _property: "XMPMetadataAsUTF8" }, TARGET_DOCUMENT], to: { _obj: "document", XMPMetadataAsUTF8: writeXmpData(current, null, documentProperty(id)) } });
  } catch (error) {}
}

/* ----------------------------- history ------------------------------ */

// One history state; any error rolls the document back to where it was
async function inHistory(context, documentID, name, fn, { rollback = false } = {}) {
  const suspensionID = await context.hostControl.suspendHistory({ documentID, name });
  let result;
  try {
    result = await fn();
  } catch (error) {
    try {
      await context.hostControl.resumeHistory(suspensionID, false);
    } catch (resumeError) {
      console.error("SFX: rollback failed", resumeError);
    }
    throw error;
  }
  await context.hostControl.resumeHistory(suspensionID, !rollback);
  return result;
}

/* ------------------------------ preview ----------------------------- */

const PREVIEW_MAX = 2400;

// The page without the SFX's own layers, as a JPEG data URL. Runs in a
// rolled back history suspension. The layer is taken out by opacity, not
// hidden: a visibility change is no history step, so Photoshop writes it
// into the current history state, and undo/redo brought the layer back
// hidden (the text layer after undoing an Apply, the SFX after a redo)
async function capturePreview(info, hideIds) {
  [].concat(hideIds || []).forEach((id) => {
    try {
      play({ _obj: "set", _target: [layerRef(id)], to: { _obj: "layer", opacity: { _unit: "percentUnit", _value: 0 } } });
    } catch (error) {}
  });
  const k = Math.min(1, PREVIEW_MAX / Math.max(info.width, info.height));
  const options = { documentID: info.id, componentSize: 8, applyAlpha: true, colorSpace: "RGB" };
  if (k < 1) options.targetSize = { width: Math.max(1, Math.round(info.width * k)), height: Math.max(1, Math.round(info.height * k)) };
  let pixels;
  try {
    pixels = await ps.imaging.getPixels(options);
  } catch (error) {
    delete options.applyAlpha;
    pixels = await ps.imaging.getPixels(options);
  }
  try {
    const jpeg = await ps.imaging.encodeImageData({ imageData: pixels.imageData, base64: true });
    return { src: "data:image/jpeg;base64," + jpeg, width: pixels.imageData.width, height: pixels.imageData.height };
  } finally {
    try {
      pixels.imageData.dispose();
    } catch (error) {}
  }
}

/* ------------------------------ glyphs ------------------------------ */

// Each wanted character (and the reference) typed alone into the layer
// currently selected, then turned into a work path. Runs inside a rolled
// back history suspension.
// One character in the selected text layer, in the style of its first
// character with `override` on top (as _setTextContentsOnly, plus override)
function typeChar(ch, override) {
  const textKey = get([{ _property: "textKey" }, { _ref: "layer", _enum: "ordinal", _value: "targetEnum" }]).textKey;
  if (!textKey) return;
  const first = Array.isArray(textKey.textStyleRange) && textKey.textStyleRange[0];
  const to = { _obj: "textLayer", textKey: ch };
  if (first) {
    const range = Object.assign({}, first, { from: 0, to: ch.length });
    range.textStyle = Object.assign({}, first.textStyle, override || {});
    to.textStyleRange = [range];
  }
  const paragraph = Array.isArray(textKey.paragraphStyleRange) && textKey.paragraphStyleRange[0];
  if (paragraph) to.paragraphStyleRange = [Object.assign({}, paragraph, { from: 0, to: ch.length })];
  // A set without antiAlias resets the layer to Sharp
  if (textKey.antiAlias) to.antiAlias = textKey.antiAlias;
  play({ _obj: "set", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }], to });
}

// Photoshop refuses Create Work Path for faux bold (and, in some versions,
// faux italic) text: the copy is typed without them
function fauxStyles(textKey) {
  const ranges = (textKey && textKey.textStyleRange) || [];
  const any = (key) => ranges.some((range) => range && range.textStyle && range.textStyle[key] === true);
  return { bold: any("syntheticBold"), italic: any("syntheticItalic") };
}

const inked = (samples) => samples.filter((sample) => !sample.reference || sample.alsoText).some((sample) => sample.pathContents);

// Samples with the faux styles dropped as needed; notes what was dropped
async function sampleWithoutFaux(layer, wanted, faux, notices) {
  const override = {};
  if (faux.bold) {
    override.syntheticBold = false;
    notices.push("sfxFauxBoldIgnored");
  }
  let result = await sampleGlyphs(layer, wanted, override);
  if (!inked(result.samples) && faux.italic) {
    override.syntheticItalic = false;
    notices.push("sfxFauxItalicIgnored");
    result = await sampleGlyphs(layer, wanted, override);
  }
  if (!inked(result.samples)) throw new SfxError("noOutlines", result.lastError);
  return result.samples;
}

async function sampleGlyphs(layer, wanted, override) {
  const samples = [];
  let lastError = "";
  const list = [REFERENCE_CHAR].concat(wanted.filter((ch) => ch !== REFERENCE_CHAR));
  const textHasReference = wanted.indexOf(REFERENCE_CHAR) >= 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    const sample = { ch, reference: i === 0, alsoText: i === 0 && textHasReference, pathContents: null, layerBounds: null };
    samples.push(sample);
    if (!ch.trim()) continue;
    try {
      typeChar(ch, override);
      await makeWorkPathFromText(layer);
      sample.pathContents = readWorkPath();
      sample.layerBounds = layerBounds(layer.id);
    } catch (error) {
      // A character the font cannot draw: it keeps its room, without ink
      lastError = errorText(error);
    }
  }
  return { samples, lastError };
}

function rawSize(textStyle) {
  const size = textStyle && textStyle.size;
  return Number(unitValue(size));
}

// A copy of the source text layer, horizontal and unwarped, measures the
// characters of a new SFX
async function readFromTextLayer(info, layer, wanted) {
  const id = layer.id;
  const textKey = textKeyOf(id);
  if (!textKey) throw new SfxError("notText");
  selectLayer(id);
  play({ _obj: "duplicate", _target: [layerRef(id)], version: 5 });
  const copyId = host._getActiveLayerId();
  if (!copyId || copyId === id) throw new SfxError("duplicate");
  const copy = ps.app.activeDocument.activeLayers[0];
  // A hidden text layer gives a hidden copy (see capturePreview on why
  // nothing else is hidden or shown here)
  if (layerProperty(copyId, "visible") === false) {
    try {
      play({ _obj: "show", _target: [layerRef(copyId)] });
    } catch (error) {}
  }
  const shape = textKey.textShape && textKey.textShape[0];
  const vertical = !!(shape && unitValue(shape.orientation) === "vertical");
  if (vertical) {
    try {
      play({ _obj: "set", _target: [{ _ref: "property", _property: "orientation" }, TARGET_TEXT_LAYER], to: { _enum: "orientation", _value: "horizontal" } });
    } catch (error) {}
  }
  const warp = textKey.warp && unitValue(textKey.warp.warpStyle);
  if (warp && warp !== "warpNone") {
    try {
      play({ _obj: "set", _target: [TARGET_TEXT_LAYER], to: { _obj: "textLayer", warp: { _obj: "warp", warpStyle: { _enum: "warpStyle", _value: "warpNone" }, warpValue: 0, warpPerspective: 0, warpPerspectiveOther: 0, warpRotate: { _enum: "orientation", _value: "horizontal" } } } });
    } catch (error) {}
  }
  const notices = [];
  const samples = await sampleWithoutFaux(copy, wanted, fauxStyles(textKey), notices);
  const range = textKey.textStyleRange && textKey.textStyleRange[0];
  const textStyle = range && range.textStyle;
  const sizePt = rawSize(textStyle);
  const normalized = normalizeGlyphs({
    samples,
    resolution: info.resolution,
    // The layer's transform; textShape's own is the frame of box text
    transform: textKey.transform || (shape && shape.transform),
    sizePx: (sizePt * info.resolution) / 72,
  });
  // jamText's simplified style: what a later edit types new characters with
  let simpleStyle = null;
  let typeUnit;
  try {
    selectLayer(id);
    const simple = host._getLayerText();
    typeUnit = simple && simple.typeUnit;
    simpleStyle = simple && simple.layerText.textStyleRange && simple.layerText.textStyleRange[0].textStyle;
  } catch (error) {}
  return { textKey, textStyle, simpleStyle, typeUnit, vertical, normalized, sizePt, notices, warped: !!(warp && warp !== "warpNone") };
}

// A later edit: new characters typed in a temporary layer with the stored
// font, scaled to match the outlines already stored
async function readWithStoredFont(info, font, wanted) {
  if (!font || !font.textStyle) throw new SfxError("noFont");
  const style = Object.assign({}, font.textStyle, { syntheticBold: false, syntheticItalic: false });
  const layerText = {
    textKey: REFERENCE_CHAR,
    textClickPoint: { horizontal: 50, vertical: 50 },
    textStyleRange: [{ from: 0, to: 1, textStyle: style }],
    textShape: [{ textType: "point", orientation: "horizontal" }],
  };
  play({ _obj: "make", _target: [{ _ref: "textLayer" }], using: host.jamText.toLayerTextObject({ layerText, typeUnit: font.typeUnit }) });
  const layer = ps.app.activeDocument.activeLayers[0];
  const { samples } = await sampleGlyphs(layer, wanted);
  const sizePt = Number(style.size);
  const normalized = normalizeGlyphs({ samples, resolution: info.resolution, sizePx: (sizePt * info.resolution) / 72 });
  return Object.assign({}, normalized, { outlines: matchScale(normalized.outlines, normalized.referenceWidth, font.referenceWidth) });
}

/* ------------------------------ session ----------------------------- */

// The selected layers' IDs, top first. ActionManager: the DOM's activeLayers
// collapses a multi-layer selection.
function selectedLayerIds(info) {
  try {
    const result = get([{ _property: "targetLayersIDs" }, TARGET_DOCUMENT]);
    if (Array.isArray(result.targetLayersIDs)) return selectionOrder(result.targetLayersIDs.map((reference) => reference._id));
  } catch (error) {}
  return selectionOrder((info.doc.activeLayers || []).map((layer) => layer.id).reverse());
}

// One layer's session: a text layer (new SFX) or an SFX shape layer (update)
async function startLayerSession(info, id) {
  const layer = findLayer(info.doc, id);
  if (!layer) throw new SfxError("notText");
  const stored = readPayloadText(layer.id);
  const payload = stored ? parsePayload(stored.text) : null;
  if (stored && !payload) throw new SfxError("badPayload");
  if (payload) return startUpdateSession(info, layer, payload);
  if (layer.kind !== "text" && layer.kind !== ps.constants.LayerKind.TEXT) throw new SfxError("notText");
  return startNewSession(info, layer);
}

// The page without the layers being edited, for the editor's backdrop
async function readPreview(info, ids) {
  try {
    return await modal(COMMAND, (context) => inHistory(context, info.id, "SFX preview", () => capturePreview(info, ids), { rollback: true }));
  } catch (error) {
    console.error("SFX: preview", error);
    return null;
  }
}

// Everything the editor and Apply need, read once when the window opens:
// one session per selected layer. In a selection of several layers, the
// ones that are no text (or SFX) layer are left out with a notice.
async function startGroup() {
  const info = documentInfo();
  const ids = selectedLayerIds(info);
  if (!ids.length) throw new SfxError("selectOne");
  const sessions = [];
  const skipped = [];
  for (const id of ids) {
    try {
      sessions.push(await startLayerSession(info, id));
    } catch (error) {
      if (ids.length === 1 || !(error instanceof SfxError) || !isSkippable(error.code)) throw error;
      const layer = findLayer(info.doc, id);
      skipped.push({ id, name: layer ? layer.name : String(id), code: error.code });
    }
  }
  if (!sessions.length) throw new SfxError(skipped.every((entry) => entry.code === skipped[0].code) ? skipped[0].code : "notText");
  const preview = await readPreview(info, sessions.map((session) => session.layerId));
  const labelled = sessions.length > 1;
  const notices = skipped.map((entry) => skipNotice(entry.name, entry.code));
  sessions.forEach((session) => layerNotices(session.notices, session.layerName, labelled).forEach((notice) => notices.push(notice)));
  return { docId: info.id, sessions, preview, skipped, notices };
}

// The selected layer alone (development builds and the live check)
async function startSession() {
  const info = documentInfo();
  const ids = selectedLayerIds(info);
  if (ids.length !== 1) throw new SfxError("selectOne");
  const session = await startLayerSession(info, ids[0]);
  session.preview = await readPreview(info, [session.layerId]);
  return session;
}

async function startNewSession(info, layer) {
  const box = layerBounds(layer.id);
  const read = await modal(COMMAND, (context) => inHistory(context, info.id, "SFX read", async () => {
    const textKey = textKeyOf(layer.id);
    const text = String((textKey && textKey.textKey) || "");
    const wanted = uniqueChars(text);
    if (!wanted.length) throw new SfxError("emptyText");
    const result = await readFromTextLayer(info, layer, wanted);
    result.text = text;
    return result;
  }, { rollback: true }));
  const color = textColor(layer, read.textStyle);
  const em = read.normalized.em;
  // Spaces at either end would only push the text off its centre
  const text = read.text.replace(/[\r\n\u0003]+/g, "").replace(/^\s+|\s+$/g, "");
  const model = initialModel({ text, em, color, box, vertical: read.vertical });
  const notices = [];
  if (read.warped) notices.push("sfxWarpIgnored");
  read.notices.forEach((key) => notices.push(key));
  return {
    mode: "new",
    docId: info.id,
    layerId: layer.id,
    layerName: layer.name,
    model,
    outlines: read.normalized.outlines,
    unit: { unit: read.normalized.unit, factor: read.normalized.factor, resolution: info.resolution },
    font: {
      postScriptName: read.textStyle && read.textStyle.fontPostScriptName,
      name: read.textStyle && read.textStyle.fontName,
      style: read.textStyle && read.textStyle.fontStyleName,
      textStyle: read.simpleStyle,
      typeUnit: read.typeUnit,
      referenceWidth: read.normalized.referenceWidth,
      em,
    },
    notices,
    debug: { unitCheck: read.normalized.unitCheck, factor: read.normalized.factor, unit: read.normalized.unit },
  };
}

async function startUpdateSession(info, layer, payload) {
  let model = payload.model;
  const notices = [];
  const color = fillColor(layer.id);
  if (color) model = Object.assign({}, model, { color: { r: Math.round(color.r), g: Math.round(color.g), b: Math.round(color.b) } });
  const unit = currentUnit(payload.font, info);
  // Moved in Photoshop: follow. Anchors edited by hand: Apply overwrites them.
  const mask = readVectorMask(layer.id);
  if (mask && payload.shape) {
    const now = shapeSignature(parsePathContents(mask, unit.factor));
    const was = payload.shape;
    if (now) {
      const sameShape = now.points === was.points && Math.abs(now.width - was.width) < 0.75 && Math.abs(now.height - was.height) < 0.75;
      if (sameShape) {
        const dx = now.left - was.left;
        const dy = now.top - was.top;
        if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) model = Object.assign({}, model, { path: translatePath(model.path, dx, dy) });
      } else notices.push("sfxPathEdited");
    }
  } else if (!mask) notices.push("sfxNoVectorMask");
  return {
    mode: "update",
    docId: info.id,
    layerId: layer.id,
    layerName: layer.name,
    autoName: payload.layerName,
    model,
    outlines: Object.assign({}, payload.outlines),
    unit,
    font: payload.font || {},
    notices,
  };
}

function currentUnit(font, info) {
  const stored = (font && font.unit) || {};
  const unit = stored.unit || UNIT_DISTANCE;
  const factor = unit === UNIT_DISTANCE ? unitFactor(unit, info.resolution) : Number(stored.factor) || 1;
  return { unit, factor, resolution: info.resolution };
}

function uniqueChars(text) {
  const seen = {};
  return chars(text).filter((ch) => {
    if (seen[ch]) return false;
    seen[ch] = true;
    return true;
  });
}

// Characters typed in the editor that have no outline yet
async function addGlyphs(session, wanted) {
  const missing = uniqueChars(wanted.join("")).filter((ch) => !session.outlines[ch]);
  if (!missing.length) return {};
  const info = documentInfo();
  if (info.id !== session.docId) throw new SfxError("documentChanged");
  const read = await modal(COMMAND, (context) => inHistory(context, info.id, "SFX read", async () => {
    if (session.mode === "new") {
      const layer = info.doc.layers && findLayer(info.doc, session.layerId);
      if (!layer) throw new SfxError("sourceGone");
      const result = await readFromTextLayer(info, layer, missing);
      return result.normalized;
    }
    return readWithStoredFont(info, session.font, missing);
  }, { rollback: true }));
  // A new SFX keeps the em of its first reading
  const outlines = session.mode === "new" ? matchScale(read.outlines, read.referenceWidth, session.font.referenceWidth) : read.outlines;
  const added = {};
  missing.forEach((ch) => {
    session.outlines[ch] = outlines[ch] || [];
    added[ch] = session.outlines[ch];
  });
  return added;
}

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

/* ------------------------------- apply ------------------------------ */

function autoLayerName(model) {
  const text = model.text.trim();
  return text ? text.slice(0, 60) : "SFX";
}

// Photoshop reports a layer's opacity as 0-255 (a bare number), and takes it
// back as a percentage: 255 sent as "255%" came out as 54%
function opacityPercent(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "object" && value._unit === "percentUnit") return Math.max(0, Math.min(100, Number(value._value)));
  const raw = Number(unitValue(value));
  return isFinite(raw) ? Math.max(0, Math.min(100, (raw / 255) * 100)) : null;
}

function copyLayerLook(fromId, toId) {
  const opacity = layerProperty(fromId, "opacity");
  const mode = layerProperty(fromId, "mode");
  const to = { _obj: "layer" };
  const percent = opacityPercent(opacity);
  if (percent !== null) to.opacity = { _unit: "percentUnit", _value: percent };
  if (mode && mode._value && mode._value !== "passThrough") to.mode = { _enum: "blendMode", _value: mode._value };
  if (Object.keys(to).length > 1) {
    try {
      play({ _obj: "set", _target: [layerRef(toId)], to });
    } catch (error) {}
  }
  if (layerProperty(fromId, "visible") === false) {
    try {
      play({ _obj: "hide", _target: [layerRef(toId)] });
    } catch (error) {}
  }
}

function renameLayer(id, name) {
  play({ _obj: "set", _target: [layerRef(id)], to: { _obj: "layer", name } });
}

// A solid colour layer shaped by the work path, above the selected layer
function makeShapeLayer(color) {
  play({ _obj: "make", _target: [{ _ref: "contentLayer" }], using: { _obj: "contentLayer", type: { _obj: "solidColorLayer", color: colorDescriptor(color) } } });
  const id = host._getActiveLayerId();
  if (!hasVectorMask(id)) throw new SfxError("noVectorMask");
  return id;
}

// px per path unit now (distanceUnit follows the document resolution)
function writeFactor(unit, resolution) {
  return unit.unit === UNIT_DISTANCE ? unitFactor(UNIT_DISTANCE, resolution) : Number(unit.factor) || 1;
}

// The shape as Photoshop stored it (it may tidy the points), so that a
// later edit tells a hand edit from Photoshop's own bookkeeping
function storedSignature(id, session, components) {
  const mask = readVectorMask(id);
  const parsed = mask ? parsePathContents(mask, writeFactor(session.unit, documentInfo().resolution)) : null;
  return (parsed && parsed.length && shapeSignature(parsed)) || shapeSignature(components);
}

function payloadFor(session, model, id, components, layerName) {
  const font = Object.assign({}, session.font, { unit: { unit: session.unit.unit, factor: session.unit.factor } });
  return JSON.stringify(buildPayload({ model, outlines: session.outlines, font, shape: storedSignature(id, session, components), layerName }));
}

// The SFX layers selected after Apply, as the source layers were
function selectLayers(ids) {
  selectLayer(ids[0]);
  ids.slice(1).forEach((id) => {
    try {
      play({ _obj: "select", _target: [layerRef(id)], selectionModifier: { _enum: "selectionModifierType", _value: "addToSelection" }, makeVisible: false });
    } catch (error) {}
  });
}

// Every layer of the group written in one history state: one undo brings
// all of them back, and any error leaves the document as it was
async function applyGroup(group, rawModels) {
  const info = documentInfo();
  if (info.id !== group.docId) throw new SfxError("documentChanged");
  const wanted = stateModels({ models: rawModels }, group.sessions.map((session) => session.model));
  const plans = group.sessions.map((session, i) => {
    if (info.id !== session.docId) throw new SfxError("documentChanged");
    const model = normalizeModel(wanted[i], session.model);
    const components = composeShape(model, session.outlines);
    if (!components.length) throw new SfxError("emptyShape", session.layerName);
    const pathContents = buildPathContents(components, session.unit.unit, writeFactor(session.unit, info.resolution));
    return { session, model, components, pathContents, name: autoLayerName(model), resultId: null };
  });
  await modal(COMMAND, (context) => inHistory(context, info.id, (getStrings().sfxHistoryName || "SFX"), async () => {
    const savedWorkPath = readWorkPath();
    plans.forEach((plan, i) => {
      const { session, model, components, pathContents, name } = plan;
      selectLayer(session.layerId);
      setWorkPath(pathContents);
      testFailure("afterWorkPath");
      if (session.mode === "new") plan.resultId = applyNew(session, model, components, name);
      else plan.resultId = applyUpdate(session, model, components, name, pathContents);
      if (i === 0 && plans.length > 1) testFailure("betweenLayers");
    });
    testFailure("beforeRestore");
    restoreWorkPath(savedWorkPath);
    selectLayers(plans.map((plan) => plan.resultId));
  }));
  // Applied: the editor's next round (an apply failure reopens it) edits the SFX layers
  plans.forEach(({ session, model, name, resultId }) => {
    session.layerId = resultId;
    session.mode = "update";
    session.autoName = name;
    session.model = model;
  });
  onDocumentChanged();
  return plans.map((plan) => ({ layerId: plan.resultId, bounds: bounds(plan.components, true) }));
}

async function applySession(session, rawModel) {
  const [done] = await applyGroup({ docId: session.docId, sessions: [session] }, [rawModel]);
  return done;
}

function applyNew(session, model, components, name) {
  const id = makeShapeLayer(model.color);
  testFailure("afterShapeLayer");
  copyLayerLook(session.layerId, id);
  renameLayer(id, name);
  writePayloadText(id, payloadFor(session, model, id, components, name));
  testFailure("afterMetadata");
  play({ _obj: "delete", _target: [layerRef(session.layerId)] });
  return id;
}

function applyUpdate(session, model, components, name, pathContents) {
  const id = session.layerId;
  let target = id;
  try {
    if (hasVectorMask(id)) play({ _obj: "delete", _target: [VECTOR_MASK, layerRef(id)] });
    // Photoshop 27 refuses `using: workPath`; the selected path works
    play({ _obj: "select", _target: [WORK_PATH] });
    play({ _obj: "make", _target: [{ _ref: "path" }], at: VECTOR_MASK, using: { _ref: "path", _enum: "ordinal", _value: "targetEnum" } });
    if (!hasVectorMask(id)) throw new SfxError("noVectorMask");
    play({ _obj: "set", _target: [{ _ref: "contentLayer", _enum: "ordinal", _value: "targetEnum" }], to: { _obj: "solidColorLayer", color: colorDescriptor(model.color) } });
  } catch (maskError) {
    // A new layer in its place (same stack position, settings and name)
    console.error("SFX: vector mask update failed, replacing the layer", maskError);
    selectLayer(id);
    setWorkPath(pathContents);
    target = makeShapeLayer(model.color);
    copyLayerLook(id, target);
    renameLayer(target, String(layerProperty(id, "name") || name));
    play({ _obj: "delete", _target: [layerRef(id)] });
  }
  testFailure("afterShapeUpdate");
  // Renamed only while it still has the name SFX gave it
  const current = String(layerProperty(target, "name") || "");
  const layerName = !current || current === session.autoName ? name : current;
  if (layerName !== current) renameLayer(target, layerName);
  writePayloadText(target, payloadFor(session, model, target, components, layerName === name ? name : session.autoName));
  return target;
}

/* ------------------------------ window ------------------------------ */

// One entry per layer (`start`: the model the layer opened with, for the
// editor's reset); `state` is where the editor was when it closed
function editorInit(group, notices, state) {
  const models = stateModels(state, group.sessions.map((session) => session.model));
  return {
    items: group.sessions.map((session, i) => ({
      mode: session.mode,
      model: models[i],
      start: session.model,
      outlines: session.outlines,
      layerName: session.layerName || "",
      font: { name: session.font.name || session.font.postScriptName || "", style: session.font.style || "" },
    })),
    active: clampIndex(state && state.active, group.sessions.length),
    view: (state && state.view) || null,
    preview: group.preview,
    document: (() => {
      const info = documentInfo();
      return { width: info.width, height: info.height, resolution: info.resolution };
    })(),
    notices,
    strings: sfxStrings(),
    theme: (() => {
      try {
        return document.theme.getCurrent();
      } catch (error) {
        return "darkest";
      }
    })(),
  };
}

// The editor window. Resolves with {action: "apply" | "cancel" | "reopen", ...}
function showEditor(init, handlers) {
  return new Promise((resolve) => {
    const strings = init.strings || {};
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
    const seen = new Set();
    // Development builds: the live check watches the window (scripts/sfxLiveCheck.js)
    const devLog = typeof TYPER_DEV !== "undefined" && TYPER_DEV ? (globalThis.__sfxEditor = { dialog, view, log: [], finish: (result) => finish(result), post: (message) => send(message) }).log : null;
    const send = (message) => {
      try {
        view.postMessage(JSON.stringify(message));
      } catch (error) {
        console.error("SFX: message to the editor", error);
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
      if (devLog) devLog.push(message.type === "devResult" ? { op: message.op, result: message.result } : message.type + (message.method ? ":" + message.method : ""));
      if (message.type === "ready") send({ type: "init", init });
      else if (message.type === "apply") finish({ action: "apply", state: message.state });
      else if (message.type === "cancel") finish({ action: "cancel" });
      else if (message.type === "reopen") finish({ action: "reopen", state: message.state, chars: message.chars || [], index: message.index });
      else if (message.type === "log") console.log("SFX editor:", message.text);
      else if (message.type === "request" && typeof message.id === "number" && !seen.has(message.id)) {
        seen.add(message.id);
        const handler = handlers[message.method];
        Promise.resolve()
          .then(() => (handler ? handler(...(message.args || [])) : Promise.reject(new Error("unknown request " + message.method))))
          .then((result) => send({ type: "reply", id: message.id, result }),
            (error) => send({ type: "reply", id: message.id, error: errorText(error), modal: !!error.reopen || isModalError(error) }));
      }
    };
    view.addEventListener("message", onMessage);
    const onWindowMessage = (event) => {
      if (event.source === view) onMessage(event);
    };
    window.addEventListener("message", onWindowMessage);
    view.src = EDITOR_URL;
    dialog.uxpShowModal({ title: strings.sfxTitle || "SFX", resize: "both", size: { width: 1240, height: 820 } })
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
  const code = error instanceof SfxError ? error.code : "failed";
  return answer({ ok: false, code, message: error instanceof SfxError ? error.detail : errorText(error) });
}

async function sfxOpen() {
  if (busy) return answer({ ok: false, code: "busy" });
  busy = true;
  try {
    if (!canShowWindow()) throw new SfxError("noPanel");
    if (!host.hasDocument()) throw new SfxError("noDocument");
    const group = await startGroup();
    const sessionAt = (index) => group.sessions[clampIndex(index, group.sessions.length)];
    let notices = group.notices.slice();
    let state = null;
    for (;;) {
      const result = await showEditor(editorInit(group, notices, state), {
        // Photoshop may refuse commands while the window is up: any failure
        // here closes it, reads the characters, and opens it again
        glyphs: (wanted, index) => addGlyphs(sessionAt(index), Array.isArray(wanted) ? wanted : []).catch((error) => {
          const reopen = new Error(errorText(error));
          reopen.reopen = true;
          throw reopen;
        }),
      });
      notices = [];
      if (result.action === "cancel") return answer({ ok: true, code: "cancel" });
      state = result.state || state;
      if (result.action === "reopen") {
        try {
          await addGlyphs(sessionAt(result.index), result.chars);
        } catch (error) {
          notices.push({ key: "sfxGlyphsFailed", detail: errorText(error) });
        }
        continue;
      }
      if (result.action === "apply") {
        try {
          const done = await applyGroup(group, stateModels(state, group.sessions.map((session) => session.model)));
          return answer({ ok: true, code: "applied", layerId: done[0].layerId, layerIds: done.map((entry) => entry.layerId) });
        } catch (error) {
          console.error("SFX: apply", error);
          notices.push({ key: "sfxApplyFailed", detail: errorText(error) });
        }
      }
    }
  } catch (error) {
    console.error("SFX:", error);
    return failure(error);
  } finally {
    busy = false;
  }
}

module.exports = {
  setup,
  methods: { sfxOpen },
  // development builds and tests (scripts/sfxLiveCheck.js)
  _internals: { opacityPercent, startSession, startGroup, applySession, applyGroup, editorInit, addGlyphs, readPayloadText, readLayerXmp, readDocumentXmp, readVectorMask, readWorkPath, layerBounds, capturePreview, fillColor },
};
