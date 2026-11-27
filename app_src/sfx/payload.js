// What an SFX shape layer carries in its XMP metadata, so a saved PSD opens
// again in the editor: the source text and font, the editor settings, and the
// glyph outlines Photoshop drew for that font (the font need not be installed
// to adjust the layout later).

import { normalizeModel, chars } from "./layout";
import { roundComponents, bounds, countPoints } from "./outline";
import { xmpStore } from "../xmpStore";

export const PAYLOAD_VERSION = 1;
export const XMP_NS = "http://ns.dryiceee.com/labelplus-nondum/sfx/1.0/";
export const XMP_PREFIX = "lpsfx";
const PROPERTY = "data";

/* ----------------------------- payload ----------------------------- */

// shape: the written path's box and point count, in document pixels. A
// different count on the layer later means the anchors were edited by hand;
// the same shape moved means the layer was moved.
export function shapeSignature(components) {
  const box = bounds(components, true);
  return box ? { points: countPoints(components), left: box.left, top: box.top, width: box.width, height: box.height } : null;
}

export function buildPayload({ model, outlines, font, shape, layerName }) {
  const used = {};
  chars(model.text).forEach((ch) => {
    if (outlines && outlines[ch]) used[ch] = roundComponents(outlines[ch], 2);
  });
  return {
    v: PAYLOAD_VERSION,
    model,
    outlines: used,
    font: font || null,
    shape: shape || null,
    layerName: layerName || "",
  };
}

export function parsePayload(text) {
  let raw = text;
  if (typeof text === "string") {
    try {
      raw = JSON.parse(text);
    } catch (error) {
      return null;
    }
  }
  if (!raw || typeof raw !== "object" || typeof raw.v !== "number" || raw.v > PAYLOAD_VERSION) return null;
  if (!raw.model || typeof raw.model !== "object") return null;
  const model = normalizeModel(raw.model);
  const outlines = {};
  if (raw.outlines && typeof raw.outlines === "object") {
    Object.keys(raw.outlines).forEach((ch) => {
      if (Array.isArray(raw.outlines[ch])) outlines[ch] = raw.outlines[ch];
    });
  }
  return {
    v: raw.v,
    model,
    outlines,
    font: raw.font && typeof raw.font === "object" ? raw.font : null,
    shape: raw.shape && typeof raw.shape === "object" ? raw.shape : null,
    layerName: typeof raw.layerName === "string" ? raw.layerName : "",
  };
}

/* ------------------------------- XMP ------------------------------- */

const store = xmpStore(XMP_NS, XMP_PREFIX);

// Our property, written as an element or (compact form) as an attribute
export const readXmpData = (xmp, property = PROPERTY) => store.read(xmp, property);

// The layer's XMP with our property set to `value` (null removes it); other
// metadata in the packet stays as it was
export const writeXmpData = (xmp, value, property = PROPERTY) => store.write(xmp, value, property);

// Document-level fallback: one property per layer ID
export const layerProperty = (layerId) => "layer" + String(Math.trunc(Number(layerId)) || 0);
