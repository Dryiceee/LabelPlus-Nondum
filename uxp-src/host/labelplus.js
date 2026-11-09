// LabelPlus in the UXP host.
//   lpImportPage  - raw page + labels -> PSD with vertical point text, one
//                   layer group per LabelPlus group
//   lpProcessPage - an imported PSD: applies the styles of its groups, centres
//                   the text of the groups that ask for it, saves
// Each call handles one page and answers a JSON string, so the panel can show
// progress and stop between pages. Problems on a layer never stop the page:
// they come back in `issues`, the checklist the user reads at the end.

const ps = require("photoshop");
const uxp = require("uxp");
const files = require("./files");
const photoshop = require("./photoshop");
const { toLuma, createPage, findBubble } = require("../../app_src/labelplus/bubbleFinder");
const { openedBox, placeShared, cleanOutline } = require("../../app_src/labelplus/bubbleShape");
const { labelPointOffset } = require("../../app_src/labelplus/importPlan");
const { lookOnlyStyle, newLayerProps } = require("../../app_src/labelplus/stylePayload");

const host = photoshop._internals;
const { play, get, modal, suspendHistory } = host;

const DEFAULT_ORIENTATION = "vertical";
const TARGET_TEXT_LAYER = { _ref: "textLayer", _enum: "ordinal", _value: "targetEnum" };
const answer = (value) => JSON.stringify(value);
const failure = (code, error) => answer({ ok: false, code, message: error ? String(error.message || error) : "" });
const excerpt = (text) => String(text || "").replace(/[\r\n]+/g, " ").slice(0, 24);
const SELECTION = { _ref: "channel", _property: "selection" };
const px = (value) => ({ _unit: "pixelsUnit", _value: value });
// The whitening of a page, on a layer of its own over the image: hidden or
// deleted, the original lettering is back. Rebuilt on each run.
const CLEAN_LAYER_NAME = "LabelPlus Clean";

/* ------------------------------ files ------------------------------ */

async function lpReadText(path) {
  try {
    return answer({ ok: true, text: await files.readText(path) });
  } catch (error) {
    return failure("read", error);
  }
}

async function lpWriteText(path, text) {
  try {
    await files.writeText(path, text);
    return answer({ ok: true });
  } catch (error) {
    return failure("write", error);
  }
}

function lpActiveDocumentName() {
  try {
    return answer({ ok: true, name: ps.app.activeDocument.name });
  } catch (error) {
    return failure("noDocument", error);
  }
}

async function lpListFolder(path) {
  try {
    return answer({ ok: true, entries: await files.listFolder(path) });
  } catch (error) {
    return failure("list", error);
  }
}

/* ------------------------------ layers ----------------------------- */

const currentOrientation = () => {
  const shape = host._getLayerText().layerText.textShape;
  return shape && shape[0] ? shape[0].orientation : null;
};

// True when the active text layer ends up in `orientation`
function ensureOrientation(orientation) {
  if (currentOrientation() === orientation) return true;
  try {
    play({
      _obj: "set",
      _target: [{ _ref: "property", _property: "orientation" }, TARGET_TEXT_LAYER],
      to: { _enum: "orientation", _value: orientation },
    });
  } catch (setError) {}
  if (currentOrientation() === orientation) return true;
  try {
    const layer = ps.app.activeDocument.activeLayers[0];
    layer.textItem.orientation = orientation === "vertical" ? ps.constants.Orientation.VERTICAL : ps.constants.Orientation.HORIZONTAL;
  } catch (domError) {}
  return currentOrientation() === orientation;
}

// Text layers cannot live in Indexed or Bitmap pages, and a grey page would
// drop the colour of a style: the PS script always built RGB documents too.
async function ensureRgb(doc) {
  if (doc.mode === ps.constants.DocumentMode.RGB) return;
  await doc.changeMode(ps.constants.ChangeMode.RGB);
}

// One group per name, above the page, in the order of the text file
async function createGroups(doc, names) {
  const groups = {};
  for (let i = 0; i < names.length; i++) {
    const group = await doc.createLayerGroup({ name: names[i] });
    const top = doc.layers[0];
    if (top && top.id !== group.id) await group.move(top, ps.constants.ElementPlacement.PLACEBEFORE);
    groups[names[i]] = group;
  }
  return groups;
}

// A vertical point text with its start on the label point
function makeLabelLayer(label, style, orientation, size) {
  const text = host._normalizeTextKey(label.text);
  const prepared = host._scaleStyleForPunctuationOnlyText(host._resolveStyleSizeForDocument(host._ensureStyle(style)), text);
  const props = newLayerProps(
    prepared,
    text,
    orientation,
    host._convertPixelToPoint(size.width),
    host._convertPixelToPoint(size.height)
  );
  play({ _obj: "make", _target: [{ _ref: "textLayer" }], using: host.jamText.toLayerTextObject(props) });
  host._applyMiddleEast(props.layerText.textStyleRange[0].textStyle);
  host._applyStyleEffects(prepared);
  host._changeToPointText();
  const oriented = ensureOrientation(orientation);
  const box = host._currentLayerBox();
  if (box) {
    const point = { x: label.x * size.width, y: label.y * size.height };
    const offset = labelPointOffset(box, point, orientation, host._currentDisplayedTextPixels());
    if (offset.x || offset.y) host._moveLayer(offset.x, offset.y);
  }
  return { id: host._getActiveLayerId(), oriented };
}

/* ------------------------------ import ----------------------------- */

// data: { source, output, orientation, groups: [names],
//         labels: [{ index, x, y, group, text, style, center, clean }] }
// A label with center goes to its bubble, and the bubble of a label with clean
// is whitened, before the page is saved, so each page opens once.
// answers { ok, layers: [{ layerId, index, x, y, group }], wanted, centred, cleaned, trace, issues }
async function lpImportPage(data) {
  const orientation = data.orientation || DEFAULT_ORIENTATION;
  if (!(await host._fileExists(data.source))) return failure("imageMissing");
  if (host._findOpenDocumentByPath(data.source) || host._findOpenDocumentByPath(data.output)) return failure("documentOpen");
  const layers = [];
  const issues = [];
  const outcome = { wanted: 0, centred: 0, cleaned: 0, trace: [], issues };
  try {
    await files.ensureFolder(files.dirname(data.output));
    await modal("LabelPlus Import", async () => {
      const doc = await host._openDocument(data.source);
      try {
        await ensureRgb(doc);
        const size = host._bubbleDocumentSize();
        const names = data.groups.filter((name) => data.labels.some((label) => label.group === name));
        const groups = await createGroups(doc, names);
        const toPlan = [];
        for (let i = 0; i < data.labels.length; i++) {
          const label = data.labels[i];
          try {
            const made = makeLabelLayer(label, label.style, orientation, size);
            if (!made.oriented) issues.push({ code: "orientation", index: label.index, text: excerpt(label.text) });
            const group = groups[label.group];
            if (group) await doc.activeLayers[0].move(group, ps.constants.ElementPlacement.PLACEINSIDE);
            else issues.push({ code: "noGroup", index: label.index, text: excerpt(label.text) });
            layers.push({ layerId: made.id, index: label.index, x: label.x, y: label.y, group: label.group });
            if (label.center || label.clean) {
              toPlan.push({
                id: made.id,
                index: label.index,
                text: excerpt(label.text),
                point: { x: label.x * size.width, y: label.y * size.height },
                fontPixels: host._currentDisplayedTextPixels(),
                center: !!label.center,
                clean: !!label.clean,
              });
            }
          } catch (layerError) {
            issues.push({ code: "layerFailed", index: label.index, text: excerpt(label.text), message: String(layerError.message || layerError) });
          }
        }
        outcome.wanted = toPlan.filter((text) => text.center).length;
        if (toPlan.length) {
          const planned = await planPage(doc, toPlan, size);
          paintCleans(doc, planned.cleans, outcome);
          moveToPlaces(toPlan.filter((text) => text.center), planned, outcome);
        }
        // Only now: creating the entry empties a PSD already there
        const outputEntry = await uxp.storage.localFileSystem.createEntryWithUrl(files.toUrl(data.output), { overwrite: true });
        await doc.saveAs.psd(outputEntry, { embedColorProfile: true }, false);
      } finally {
        await doc.closeWithoutSaving();
      }
    });
    return answer({ ok: true, layers, wanted: outcome.wanted, centred: outcome.centred, cleaned: outcome.cleaned, trace: outcome.trace, issues });
  } catch (error) {
    return failure("import", error);
  }
}

/* ----------------------------- process ----------------------------- */

function collectTextLayers(container, parentName, found) {
  const layers = container.layers || [];
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    if (layer.kind === "group") collectTextLayers(layer, layer.name, found);
    else if (layer.kind === "text") found.push({ id: layer.id, group: parentName, text: excerpt(layer.name) });
  }
  return found;
}

async function readPageLuma(doc, size) {
  const bounds = { left: 0, top: 0, right: size.width, bottom: size.height };
  const result = await ps.imaging.getPixels({ documentID: doc.id, sourceBounds: bounds, componentSize: 8, colorSpace: "RGB" });
  try {
    const bytes = new Uint8Array(await result.imageData.getData({ chunky: true }));
    const page = createPage(toLuma(bytes, result.imageData.components, result.imageData.width, result.imageData.height), result.imageData.width, result.imageData.height);
    // The colour, for whitening with the bubble's own
    page.rgb = bytes;
    page.components = result.imageData.components;
    return page;
  } finally {
    result.imageData.dispose();
  }
}

const pointBox = (point) => ({
  left: point.x - 1,
  top: point.y - 1,
  right: point.x + 1,
  bottom: point.y + 1,
  width: 2,
  height: 2,
  xMid: point.x,
  yMid: point.y,
});

// Reads the page once, without its lettering (the text layers are hidden for
// the read and shown again), and plans both jobs: where each text with center
// goes, and the whitening of each bubble holding a text with clean.
// texts: [{ id, index, text, point, fontPixels, center, clean }]
// Returns { placements: { layerId: rect }, cleans: [{ polygon, inset, color, index }], issues }.
async function planPage(doc, texts, size) {
  const placements = {};
  const cleans = [];
  const issues = [];
  const allIds = collectTextLayers(doc, "", []).map((text) => text.id);
  let hidden = false;
  try {
    host._setLayerVisibilityByIds(allIds, false);
    hidden = true;
  } catch (hideError) {}
  let page;
  try {
    page = await readPageLuma(doc, size);
  } finally {
    if (hidden) {
      try {
        host._setLayerVisibilityByIds(allIds, true);
      } catch (showError) {}
    }
  }
  const bubbles = [];
  texts.forEach((text) => {
    const found = findBubble(page, text.point, { fontPixels: text.fontPixels });
    if (!found) {
      issues.push({ code: text.center ? "noBubble" : "cleanNoBubble", index: text.index, text: text.text });
      return;
    }
    let bubble = bubbles.find((known) => known.found.key === found.key);
    if (!bubble) {
      bubble = { found, texts: [], clean: false, first: text };
      bubbles.push(bubble);
    }
    if (text.center) bubble.texts.push(text);
    if (text.clean) bubble.clean = true;
  });
  // A connected double bubble is whitened whole, once
  bubbles.forEach((bubble) => {
    if (!bubble.clean) return;
    const planned = cleanOutline(page, bubble.found, { fontPixels: bubble.first.fontPixels });
    if (planned.skip) issues.push({ code: planned.skip, index: bubble.first.index, text: bubble.first.text });
    else cleans.push(Object.assign(planned, { index: bubble.first.index }));
  });
  // A chamber's middle is TypeR's, which is not always the middle of its box
  const rectOf = (box) => {
    const rect = host._rectFrom(box.left, box.top, box.right, box.bottom);
    if (isFinite(box.xMid) && isFinite(box.yMid)) {
      rect.xMid = box.xMid;
      rect.yMid = box.yMid;
    }
    return rect;
  };
  bubbles.forEach((bubble) => {
    if (!bubble.texts.length) return;
    if (bubble.texts.length === 1) {
      placements[bubble.texts[0].id] = rectOf(openedBox(page, bubble.found, bubble.texts[0].point));
      return;
    }
    // Several labels in one outline: a double bubble, each text to its chamber.
    // The label points decide, not where the layers happen to sit.
    const parts = placeShared(page, bubble.found, bubble.texts.map((text) => text.point), host._bubbleDocumentResolution());
    bubble.texts.forEach((text, order) => {
      if (parts) placements[text.id] = rectOf(parts[order]);
      else issues.push({ code: "sharedBubble", index: text.index, text: text.text });
    });
  });
  return { placements, cleans, issues };
}

// The centring alone (the panel's Align)
const planCentres = (doc, texts, size) => planPage(doc, texts.map((text) => Object.assign({}, text, { center: true, clean: false })), size);

function removeCleanLayers(doc) {
  const ids = Array.from(doc.layers || []).filter((layer) => layer.name === CLEAN_LAYER_NAME && layer.kind === "pixel").map((layer) => layer.id);
  if (ids.length) play({ _obj: "delete", _target: ids.map((id) => ({ _ref: "layer", _id: id })) });
}

// Over the topmost image layer, under every text, as TypeR's clean layer
function makeCleanLayer(doc) {
  const anchor = Array.from(doc.layers || []).find((layer) => layer.kind !== "text" && layer.kind !== "group");
  if (anchor) play({ _obj: "select", _target: [{ _ref: "layer", _id: anchor.id }], makeVisible: false });
  play({ _obj: "make", _target: [{ _ref: "layer" }], using: { _obj: "layer", name: CLEAN_LAYER_NAME } });
  return host._getActiveLayerId();
}

// Fills each planned bubble on the clean layer, as TypeR's Auto clean: the
// outline as a selection, contracted, filled with the bubble's colour.
// Fills outcome: cleaned, issues.
function paintCleans(doc, cleans, outcome) {
  if (!cleans.length) return;
  let layerId;
  try {
    layerId = makeCleanLayer(doc);
  } catch (layerError) {
    outcome.issues.push({ code: "cleanFailed", message: String(layerError.message || layerError) });
    return;
  }
  cleans.forEach((clean) => {
    try {
      play({ _obj: "select", _target: [{ _ref: "layer", _id: layerId }], makeVisible: false });
      play({
        _obj: "set",
        _target: [SELECTION],
        to: { _obj: "polygon", points: clean.polygon.map((point) => ({ _obj: "paint", horizontal: px(point[0]), vertical: px(point[1]) })) },
      });
      if (clean.inset > 0) play({ _obj: "contract", by: px(clean.inset) });
      play({
        _obj: "fill",
        using: { _enum: "fillContents", _value: "color" },
        color: { _obj: "RGBColor", red: clean.color.red, grain: clean.color.green, blue: clean.color.blue },
        opacity: { _unit: "percentUnit", _value: 100 },
        mode: { _enum: "blendMode", _value: "normal" },
      });
      outcome.cleaned++;
    } catch (fillError) {
      outcome.issues.push({ code: "cleanFailed", index: clean.index, message: String(fillError.message || fillError) });
    }
  });
  try {
    play({ _obj: "set", _target: [SELECTION], to: { _enum: "ordinal", _value: "none" } });
  } catch (deselectError) {}
}

// Moves each text to its place. Fills outcome: centred, trace, issues.
function moveToPlaces(texts, planned, outcome) {
  outcome.issues.push(...planned.issues);
  texts.forEach((text) => {
    const rect = planned.placements[text.id];
    if (!rect) return;
    try {
      host._selectLayerById(text.id);
      const before = host._currentLayerBox();
      const placed = host._placeLayerInRect(rect, false);
      const after = host._currentLayerBox();
      outcome.trace.push("#" + text.index + " point " + Math.round(text.point.x) + "," + Math.round(text.point.y) +
        " bubble " + [rect.left, rect.top, rect.right, rect.bottom].map(Math.round).join(",") +
        " text " + (before ? Math.round(before.xMid) + "," + Math.round(before.yMid) : "?") +
        " -> " + (after ? Math.round(after.xMid) + "," + Math.round(after.yMid) : "?"));
      if (placed) outcome.centred++;
      else outcome.issues.push({ code: "emptyLayer", index: text.index, text: text.text });
    } catch (moveError) {
      outcome.issues.push({ code: "layerFailed", index: text.index, text: text.text, message: String(moveError.message || moveError) });
    }
  });
}

// data: { path (empty: the active document, left open and unsaved),
//         rules: { group: { style, center, clean } },
//         labels: [{ layerId, index, x, y, group }] (from the import, optional),
//         applyStyle, center }
// answers { ok, styled, centred, cleaned, total, issues }
async function lpProcessPage(data) {
  const outcome = { ok: true, styled: 0, centred: 0, cleaned: 0, total: 0, wanted: 0, trace: [], issues: [] };
  const opened = !!data.path;
  if (opened && !(await host._fileExists(data.path))) return failure("psdMissing");
  if (opened && host._findOpenDocumentByPath(data.path)) return failure("documentOpen");
  if (!opened && !ps.app.activeDocument) return failure("noDocument");
  const known = new Map((data.labels || []).map((label) => [label.layerId, label]));
  const rules = data.rules || {};
  try {
    await modal("LabelPlus Process", async (context) => {
      const doc = opened ? await host._openDocument(data.path) : ps.app.activeDocument;
      try {
        const size = host._bubbleDocumentSize();
        const layers = collectTextLayers(doc, "", []);
        outcome.total = layers.length;
        const toPlan = [];
        layers.forEach((layer) => {
          const label = known.get(layer.id);
          const group = label ? label.group : layer.group;
          const rule = rules[group] || {};
          const index = label ? label.index : 0;
          try {
            host._selectLayerById(layer.id);
            if (data.applyStyle && rule.style) {
              const orientation = currentOrientation();
              const styleError = host._setActiveLayerText({ style: lookOnlyStyle(rule.style) });
              if (styleError) throw new Error(styleError);
              if (orientation && !ensureOrientation(orientation)) outcome.issues.push({ code: "orientation", index, text: layer.text });
              outcome.styled++;
            }
            const center = !!(data.center && rule.center);
            const clean = !!(data.center && rule.clean);
            if (center || clean) {
              const box = host._currentLayerBox();
              if (!box) {
                outcome.issues.push({ code: "emptyLayer", index, text: layer.text });
                return;
              }
              // Without import data the layer itself is the best guess
              const point = label ? { x: label.x * size.width, y: label.y * size.height } : { x: box.xMid, y: box.yMid };
              toPlan.push({ id: layer.id, index, text: layer.text, point, fontPixels: host._currentDisplayedTextPixels(), center, clean });
            }
          } catch (layerError) {
            outcome.issues.push({ code: "layerFailed", index, text: layer.text, message: String(layerError.message || layerError) });
          }
        });
        outcome.wanted = toPlan.filter((text) => text.center).length;
        // A trial run again replaces its whitening instead of stacking it
        if (toPlan.some((text) => text.clean)) removeCleanLayers(doc);
        if (toPlan.length) {
          const planned = await suspendHistory(context, "LabelPlus Read Bubbles", () => planPage(doc, toPlan, size), { rollback: true });
          paintCleans(doc, planned.cleans, outcome);
          moveToPlaces(toPlan.filter((text) => text.center), planned, outcome);
        }
        if (opened) await doc.save();
      } finally {
        if (opened) await doc.closeWithoutSaving();
      }
    });
    return answer(outcome);
  } catch (error) {
    return failure("process", error);
  }
}

/* ------------------------------ align ------------------------------ */

const layerName = (id) => {
  try {
    return excerpt(get([{ _property: "name" }, { _ref: "layer", _id: id }]).name);
  } catch (nameError) {
    return "";
  }
};

// The panel's Align: each selected text layer goes to the bubble found from its
// own middle, one after the other; texts sharing a double bubble get its
// chambers. One history state. A live selection is refused with code
// "selection": the panel asks the user to clear it.
async function lpAlignSelected() {
  if (!host.hasDocument()) return failure("noDocument");
  if (host._liveSelectionBounds()) return failure("selection");
  const outcome = { ok: true, wanted: 0, centred: 0, trace: [], issues: [] };
  try {
    await modal("LabelPlus-Nondum", (context) => suspendHistory(context, "LabelPlus-Nondum Align", async () => {
      const doc = ps.app.activeDocument;
      const size = host._bubbleDocumentSize();
      const entries = host._targetLayerEntries();
      const texts = [];
      entries.forEach((entry, order) => {
        if (!entry.text) return;
        host._selectLayerById(entry.id);
        const box = host._currentLayerBox();
        if (!box) {
          outcome.issues.push({ code: "emptyLayer", index: order + 1, text: layerName(entry.id) });
          return;
        }
        texts.push({ id: entry.id, index: order + 1, text: layerName(entry.id), point: { x: box.xMid, y: box.yMid }, fontPixels: host._currentDisplayedTextPixels() });
      });
      outcome.wanted = texts.length;
      if (texts.length) moveToPlaces(texts, await planCentres(doc, texts, size), outcome);
      const ids = entries.map((entry) => entry.id);
      if (ids.length > 1) host._selectLayersById(ids);
      else if (ids.length) host._selectLayerById(ids[0]);
    }));
    return answer(outcome);
  } catch (error) {
    return failure("align", error);
  }
}

module.exports = {
  methods: { lpReadText, lpWriteText, lpListFolder, lpActiveDocumentName, lpImportPage, lpProcessPage, lpAlignSelected },
  _internals: { collectTextLayers, pointBox },
};
