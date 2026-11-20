// What an SFX shape layer carries in its XMP metadata, so a saved PSD opens
// again in the editor: the source text and font, the editor settings, and the
// glyph outlines Photoshop drew for that font (the font need not be installed
// to adjust the layout later).

import { normalizeModel, chars } from "./layout";
import { roundComponents, bounds, countPoints } from "./outline";

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

const escapeXml = (text) => String(text)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const unescapeXml = (text) => String(text)
  .replace(/&#x([0-9a-f]+);/gi, (m, hex) => String.fromCodePoint(parseInt(hex, 16)))
  .replace(/&#(\d+);/g, (m, dec) => String.fromCodePoint(parseInt(dec, 10)))
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The prefix the packet binds to our namespace (an XMP toolkit may rename it)
function prefixesOf(xmp) {
  const found = [];
  const re = new RegExp("xmlns:([A-Za-z_][\\w.-]*)\\s*=\\s*[\"']" + escapeRegExp(XMP_NS) + "[\"']", "g");
  let match;
  while ((match = re.exec(xmp))) if (found.indexOf(match[1]) < 0) found.push(match[1]);
  return found;
}

// Our property, written as an element or (compact form) as an attribute
export function readXmpData(xmp, property = PROPERTY) {
  const text = String(xmp || "");
  if (!text) return null;
  const prefixes = prefixesOf(text);
  for (const prefix of prefixes) {
    const name = escapeRegExp(prefix + ":" + property);
    const element = new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + name + ">").exec(text);
    if (element) return unescapeXml(element[1].trim());
    const attribute = new RegExp("\\s" + name + "\\s*=\\s*\"([^\"]*)\"").exec(text) || new RegExp("\\s" + name + "\\s*=\\s*'([^']*)'").exec(text);
    if (attribute) return unescapeXml(attribute[1]);
  }
  return null;
}

const ownDescription = (property, value) =>
  "<rdf:Description rdf:about=\"\" xmlns:" + XMP_PREFIX + "=\"" + XMP_NS + "\">" +
  "<" + XMP_PREFIX + ":" + property + ">" + escapeXml(value) + "</" + XMP_PREFIX + ":" + property + ">" +
  "</rdf:Description>";

const EMPTY_PACKET = (body) =>
  "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">" + body + "</rdf:RDF></x:xmpmeta>";

// Drop our property wherever the packet holds it
function removeProperty(xmp, property) {
  let text = xmp;
  prefixesOf(text).forEach((prefix) => {
    const name = escapeRegExp(prefix + ":" + property);
    text = text.replace(new RegExp("<" + name + "(?:\\s[^>]*)?>[\\s\\S]*?</" + name + ">", "g"), "");
    text = text.replace(new RegExp("<" + name + "\\s*/>", "g"), "");
    text = text.replace(new RegExp("\\s" + name + "\\s*=\\s*(\"[^\"]*\"|'[^']*')", "g"), "");
  });
  return text;
}

// The layer's XMP with our property set to `value` (null removes it); other
// metadata in the packet stays as it was
export function writeXmpData(xmp, value, property = PROPERTY) {
  const text = removeProperty(String(xmp || ""), property);
  if (value === null || value === undefined) return text;
  const own = ownDescription(property, value);
  if (/<\/rdf:RDF>/.test(text)) return text.replace(/<\/rdf:RDF>/, own + "</rdf:RDF>");
  return EMPTY_PACKET(own);
}

// Document-level fallback: one property per layer ID
export const layerProperty = (layerId) => "layer" + String(Math.trunc(Number(layerId)) || 0);
