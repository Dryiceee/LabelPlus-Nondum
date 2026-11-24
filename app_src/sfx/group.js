// Several layers open in the SFX editor at once: the bookkeeping shared by
// the host (uxp-src/host/sfx.js) and the editor window, kept free of
// Photoshop so the tests can run it.

import { chars } from "./layout";

// Reasons a layer of a multi-layer selection is left out instead of
// refusing the whole selection (any other failure stops the editor)
export const SKIPPABLE = ["notText", "emptyText", "noOutlines", "badPayload"];

export const isSkippable = (code) => SKIPPABLE.indexOf(code) >= 0;

// Photoshop lists targetLayersIDs bottom to top; the editor lists them as
// the Layers panel does, top first. Duplicates (a stale reference) go.
export function selectionOrder(ids) {
  const seen = {};
  return (ids || []).map(Number).filter((id) => {
    if (!isFinite(id) || id <= 0 || seen[id]) return false;
    seen[id] = true;
    return true;
  }).reverse();
}

// The editor notice for a layer that was left out
export const skipNotice = (layer, code) => ({ key: "sfxLayerSkipped", layer: String(layer || ""), reason: code });

// A layer's own notices, labelled with its name when several layers are open
export function layerNotices(notices, layerName, labelled) {
  return (notices || []).map((notice) => {
    const entry = typeof notice === "string" ? { key: notice } : Object.assign({}, notice);
    if (labelled) entry.layer = String(layerName || "");
    return entry;
  });
}

// The models the editor sent back, one per layer: {models: [...]}, or the
// single-layer {model} of earlier builds; a missing one stays as it was
export function stateModels(state, fallback) {
  const list = fallback || [];
  if (!state) return list.slice();
  if (Array.isArray(state.models)) return list.map((model, i) => state.models[i] || model);
  if (state.model && list.length === 1) return [state.model];
  return list.slice();
}

export const clampIndex = (index, count) => Math.max(0, Math.min(Math.max(0, count - 1), Math.trunc(Number(index)) || 0));

// The first layer whose text is empty, or -1 (Apply refuses it)
export function firstEmpty(models) {
  for (let i = 0; i < (models || []).length; i++) {
    if (!models[i] || !chars(models[i].text || "").length) return i;
  }
  return -1;
}
