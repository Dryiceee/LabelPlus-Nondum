// SFX editor window (uxp/sfx, a WebView in a modal Photoshop dialog).
// Everything is edited in document pixels; the page preview is drawn at the
// document's size, so the zoom never moves the result.
//
// Several layers can be open at once (init.items, one per layer): all of
// them are drawn on the page, the active one has the handles and the
// controls, and a click on another (or the layer list) makes it active.
// Each layer keeps its own model, glyph outlines and undo history.
import React from "react";
import {
  chars, layoutGlyphs, glyphMatrix, samplePath, pathEnds, moveEnd, bendTo, bendHandle,
  translatePath, scalePath, pathMidpoint, smoothStroke, trackingOf, withTracking, withText, normalizeModel,
  defaultGlyph, LIMITS, transformSelection, updateGlyphs, removeGlyphs, resetLayout, selectionCenter, turnEach, rampSize, bendAtSelection,
  bendWhole, bendStretch, stretchHandle, pathAnchors, moveHandle, moveAnchor, handleSegments, handlePoint,
  glyphMapper, placedOutline, freeTransformGlyph, emSquare, frameHandles,
} from "../layout";
import { toSvgPath, bounds as outlineBounds } from "../outline";
import { clampIndex, firstEmpty } from "../group";

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = (value, digits = 0) => {
  const k = Math.pow(10, digits);
  return Math.round(value * k) / k;
};
const toHex = (c) => "#" + [c.r, c.g, c.b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join("");
const fromHex = (hex) => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : null;
};
const DEG = 180 / Math.PI;
const HANDLE = 9;
const UNDO_LIMIT = 120;

// English fallbacks; the host sends the interface language's strings
const FALLBACK = {
  sfxTitle: "SFX editor",
  sfxApply: "Apply",
  sfxCancel: "Cancel",
  sfxText: "Text",
  sfxColor: "Fill",
  sfxPath: "Path",
  sfxTracking: "Spacing",
  sfxSize: "Size",
  sfxStartSize: "First character",
  sfxEndSize: "Last character",
  sfxRotation: "Character rotation",
  sfxOrientation: "Characters",
  sfxAlongPath: "Follow the path",
  sfxUpright: "Upright",
  sfxSelected: "Selected character",
  sfxNoSelection: "Click a character to adjust it on its own.",
  sfxOffsetX: "Offset X",
  sfxOffsetY: "Offset Y",
  sfxGlyphRotation: "Rotation",
  sfxGlyphSize: "Size",
  sfxResetGlyph: "Reset character",
  sfxResetAll: "Reset all characters",
  sfxResetSelected: "Reset these characters",
  sfxSelectedMany: "{count} characters selected",
  sfxResetEverything: "Reset all adjustments",
  sfxResetEverythingHint: "Back to a straight line where the SFX started, characters side by side, every setting at its default",
  sfxFitPage: "Fit page",
  sfxFitSfx: "Fit SFX",
  sfxUndo: "Undo",
  sfxRedo: "Redo",
  sfxFont: "Font",
  sfxLoadingGlyphs: "Reading characters…",
  sfxHelpCanvasTitle: "Page",
  sfxHelpCanvas: "Drag on empty=Select characters|Shift+Drag=Add to selection|Click a character=Select it|Alt+Drag on empty=Draw a new path|Space+Drag=Pan|Wheel=Scroll up/down|Ctrl+Wheel=Scroll left/right|Alt+Wheel=Zoom|Drag the dashed line=Move the whole SFX",
  sfxHelpPathTitle: "Path",
  sfxHelpPath: "Drag an end=Turn and stretch|Drag ●=Bend|Shift+End=Grow/shrink that end|Ctrl+End=Spacing|Ctrl+Shift+End=All sizes|Alt+End=Turn each character",
  sfxHelpCurveTitle: "Curve",
  sfxHelpCurve: "Click a small square=Show its handles|Drag a small square=Move the anchor|Drag a handle=Shape the curve|Alt+Handle=One side only",
  sfxHelpSelectionTitle: "Selected",
  sfxHelpSelection: "Drag=Move|Drag a corner or side=Stretch|Shift+Corner=Scale from the middle|Ctrl+Corner=Distort|Ctrl+Side=Skew|Outside a corner / ●=Rotate|Shift+Click=Add/remove|Drag ◆=Bend just this stretch|Drag an end=Bend the path at the selection|Ctrl / Alt / Shift+End=Only the selected characters",
  sfxHelpKeysTitle: "Keys",
  sfxHelpKeys: "Arrows=Move (Shift: 10 px)|[ ]=Rotate (Shift: 15°)|+ −=Size|Tab=Next character|Ctrl+A=All|Delete=Remove|Esc=Deselect",
  sfxHelpDrawTitle: "Freehand",
  sfxHelpDraw: "Drag=Draw the path|Esc=Back",
  sfxEmptyText: "Type the SFX text first.",
  sfxPathEdited: "The path of this layer was edited in Photoshop. Apply rebuilds it from these settings.",
  sfxNoVectorMask: "This layer has lost its vector mask. Apply rebuilds it.",
  sfxWarpIgnored: "The text warp of the source layer is not used.",
  sfxFauxBoldIgnored: "Photoshop cannot make paths from faux bold text: the SFX uses the regular weight of the font.",
  sfxFauxItalicIgnored: "Photoshop cannot make paths from faux italic text: the SFX is upright.",
  sfxApplyFailed: "Photoshop could not apply the SFX. The document was left as it was.",
  sfxGlyphsFailed: "Photoshop could not read the new characters.",
  sfxModeNew: "New SFX from the text layer",
  sfxModeUpdate: "Editing an SFX layer",
  sfxLayers: "Layers ({count})",
  sfxLayerSkipped: "{layer} was left out: {reason}",
  sfxSkipNotText: "not a text layer or an SFX layer",
  sfxSkipEmptyText: "the text layer is empty",
  sfxSkipNoOutlines: "Photoshop cannot turn its text into paths",
  sfxSkipBadPayload: "its SFX settings are damaged or from a newer version",
};

// init.items, or the single layer of an older init
const editorItems = (init) => (Array.isArray(init.items) && init.items.length ? init.items
  : [{ mode: init.mode, model: init.model, start: init.model, outlines: init.outlines, font: init.font, layerName: "" }]);

// One cached value per object (a model, an outline set): layers that are not
// being edited are not laid out again on every frame
function useObjectCache(compute) {
  const cache = React.useRef(null);
  if (!cache.current) cache.current = new WeakMap();
  return React.useCallback((key) => {
    let value = cache.current.get(key);
    if (value === undefined) {
      value = compute(key);
      cache.current.set(key, value);
    }
    return value;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}

function useStrings(strings) {
  return React.useCallback((key) => (strings && strings[key]) || FALLBACK[key] || key, [strings]);
}

// Slider + number, for the settings column
function Field({ label, value, min, max, step = 1, unit, onChange, onStart }) {
  const shown = round(value, step < 1 ? 2 : 0);
  return (
    <label className="sfx-field">
      <span className="sfx-field-label">{label}</span>
      <input
        type="range" min={min} max={max} step={step} value={clamp(value, min, max)}
        onPointerDown={onStart}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="sfx-field-number">
        <input
          type="number" step={step} value={shown}
          onFocus={onStart}
          onChange={(event) => {
            const v = Number(event.target.value);
            if (event.target.value !== "" && isFinite(v)) onChange(v);
          }}
        />
        {unit ? <span className="sfx-unit">{unit}</span> : null}
      </span>
    </label>
  );
}

// "Ctrl+Shift+端点" -> separate keys; "+ −" stays one key
function KeyChips({ keys }) {
  const parts = keys.split("+");
  const list = parts.every((part) => part.trim()) ? parts.map((part) => part.trim()) : [keys.trim()];
  return (
    <span className="sfx-keys">
      {list.map((key, i) => (
        <React.Fragment key={i}>
          {i ? <span className="sfx-plus">+</span> : null}
          <kbd>{key}</kbd>
        </React.Fragment>
      ))}
    </span>
  );
}

// Shortcut hints for what is on screen: rows of "key = what it does",
// from strings shaped "keys=action|keys=action"
function ShortcutHelp({ t, groups }) {
  return (
    <div className="sfx-help">
      {groups.map((group) => (
        <div key={group} className="sfx-help-row">
          <span className="sfx-help-title">{t("sfxHelp" + group + "Title")}</span>
          <span className="sfx-help-items">
          {String(t("sfxHelp" + group)).split("|").map((item, i) => {
            const at = item.indexOf("=");
            if (at < 0) return <span key={i} className="sfx-help-item">{item}</span>;
            return (
              <span key={i} className="sfx-help-item">
                <KeyChips keys={item.slice(0, at)} />
                <span className="sfx-help-action">{item.slice(at + 1)}</span>
              </span>
            );
          })}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function SfxEditor({ init, bridge }) {
  const t = useStrings(init.strings);
  const doc = init.document;
  const items = React.useMemo(() => editorItems(init), [init]);
  const count = items.length;
  const [active, setActive] = React.useState(() => clampIndex(init.active, items.length));
  const activeRef = React.useRef(active);
  activeRef.current = active;
  const [models, setModels] = React.useState(() => items.map((item) => normalizeModel(item.model)));
  const modelsRef = React.useRef(models);
  modelsRef.current = models;
  const model = models[active];
  // The active layer's model (the layer is the one active when this is called)
  const setModel = React.useCallback((next) => {
    const index = activeRef.current;
    setModels((list) => {
      const copy = list.slice();
      copy[index] = next;
      return copy;
    });
  }, []);
  const [outlineSets, setOutlineSets] = React.useState(() => items.map((item) => Object.assign({}, item.outlines)));
  const outlines = outlineSets[active];
  // Selected characters: indices, in text order
  const [selected, setSelected] = React.useState([]);
  const [marquee, setMarquee] = React.useState(null);
  const [panning, setPanning] = React.useState(false);
  const [tool, setTool] = React.useState("edit");
  // The Bézier anchor picked for its handles (index), or null
  const [anchorPick, setAnchorPick] = React.useState(null);
  const [view, setView] = React.useState(init.view || null);
  const [notices, setNotices] = React.useState(init.notices || []);
  const [loading, setLoading] = React.useState(false);
  const [stroke, setStroke] = React.useState(null);
  const [textDraft, setTextDraft] = React.useState(model.text || "");
  const [busy, setBusy] = React.useState(false);
  // One undo history per layer
  const histories = React.useRef(null);
  if (!histories.current) histories.current = items.map(() => ({ past: [], future: [], tag: null, time: 0 }));
  const historyOf = () => histories.current[activeRef.current];
  const [, forceHistory] = React.useState(0);
  const svgRef = React.useRef(null);
  const stageRef = React.useRef(null);
  const dragRef = React.useRef(null);
  const spaceRef = React.useRef(false);
  const modelRef = React.useRef(model);
  modelRef.current = model;
  const viewRef = React.useRef(view);
  viewRef.current = view;

  /* ----------------------------- history ----------------------------- */

  const remember = React.useCallback((before, tag) => {
    const history = historyOf();
    const now = Date.now();
    if (tag && tag === history.tag && now - history.time < 900) {
      history.time = now;
      return;
    }
    history.past.push(before);
    if (history.past.length > UNDO_LIMIT) history.past.shift();
    history.future = [];
    history.tag = tag || null;
    history.time = now;
    forceHistory((n) => n + 1);
  }, []);

  // A change from a control: one undo step per control and burst of edits
  const edit = React.useCallback((fn, tag) => {
    const before = modelRef.current;
    const next = fn(before);
    if (!next || next === before) return before;
    remember(before, tag);
    setModel(next);
    return next;
  }, [remember, setModel]);

  const undo = React.useCallback(() => {
    const history = historyOf();
    if (!history.past.length) return;
    history.future.push(modelRef.current);
    const previous = history.past.pop();
    history.tag = null;
    setModel(previous);
    setTextDraft(previous.text);
    forceHistory((n) => n + 1);
  }, [setModel]);

  const redo = React.useCallback(() => {
    const history = historyOf();
    if (!history.future.length) return;
    history.past.push(modelRef.current);
    const next = history.future.pop();
    history.tag = null;
    setModel(next);
    setTextDraft(next.text);
    forceHistory((n) => n + 1);
  }, [setModel]);

  /* ------------------------------ glyphs ----------------------------- */

  const outlineSetsRef = React.useRef(outlineSets);
  outlineSetsRef.current = outlineSets;
  const requested = React.useRef(null);
  if (!requested.current) requested.current = items.map(() => ({}));

  // Where the editor is, for the host to open it again there
  const editorState = () => ({ models: modelsRef.current, active: activeRef.current, view: viewRef.current });

  // The outlines of a layer's characters still missing (the layer's own font)
  const fetchGlyphs = React.useCallback((text, at) => {
    const index = at === undefined ? activeRef.current : at;
    const have = outlineSetsRef.current[index] || {};
    const asked = requested.current[index];
    const missing = chars(text).filter((ch) => !have[ch] && !asked[ch]);
    if (!missing.length) return;
    missing.forEach((ch) => { asked[ch] = true; });
    setLoading(true);
    bridge.request("glyphs", missing, index).then((added) => {
      setOutlineSets((list) => {
        const copy = list.slice();
        copy[index] = Object.assign({}, list[index], added || {});
        return copy;
      });
      setLoading(false);
    }, (error) => {
      setLoading(false);
      missing.forEach((ch) => { delete asked[ch]; });
      // Photoshop refused a command while this window is up: the host closes
      // it, reads the characters and opens it again where it was
      if (error && error.modal) bridge.reopen(editorState(), missing, index);
      else setNotices((list) => list.concat([{ key: "sfxGlyphsFailed", detail: String(error && error.message || error) }]));
    });
  }, [bridge]); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => { fetchGlyphs(modelsRef.current[active].text, active); }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  const textTimer = React.useRef(null);
  const textDraftRef = React.useRef(textDraft);
  textDraftRef.current = textDraft;
  // New characters keep the spacing: the path grows around its middle
  const commitText = (value) => {
    const next = edit((m) => (m.text === value ? m : withTracking(withText(m, value), trackingOf(m))), "text");
    setSelected((list) => list.filter((index) => index < chars(value).length));
    fetchGlyphs(value);
    return next;
  };
  const onTextChange = (value) => {
    setTextDraft(value);
    textDraftRef.current = value;
    clearTimeout(textTimer.current);
    textTimer.current = setTimeout(() => {
      textTimer.current = null;
      commitText(value);
    }, 250);
  };
  // A text edit still waiting for its timer, made now (before the layer
  // changes, or Apply); the model it made, or null
  const flushText = () => {
    if (!textTimer.current) return null;
    clearTimeout(textTimer.current);
    textTimer.current = null;
    return commitText(textDraftRef.current) || null;
  };

  const svgPathsOf = useObjectCache((set) => {
    const result = {};
    Object.keys(set || {}).forEach((ch) => { result[ch] = toSvgPath(set[ch]); });
    return result;
  });
  const svgPaths = svgPathsOf(outlines);

  const glyphBoxes = React.useMemo(() => {
    const result = {};
    const half = model.em / 2;
    Object.keys(outlines).forEach((ch) => {
      const box = outlines[ch] && outlines[ch].length ? outlineBounds(outlines[ch], true) : null;
      result[ch] = box ? { left: Math.min(box.left, -half * 0.6), top: Math.min(box.top, -half * 0.6), right: Math.max(box.right, half * 0.6), bottom: Math.max(box.bottom, half * 0.6) }
        : { left: -half, top: -half, right: half, bottom: half };
    });
    return result;
  }, [outlines, model.em]);

  const layoutOf = useObjectCache((m) => layoutGlyphs(m));
  const guideOf = useObjectCache((m) => samplePath(m.path, 48));
  const placements = layoutOf(model);
  const guide = React.useMemo(() => samplePath(model.path, 96), [model.path]);
  const tracking = React.useMemo(() => trackingOf(model), [model]);

  /* ------------------------------- view ------------------------------ */

  const fitTo = React.useCallback((box, padding = 40) => {
    const stage = stageRef.current;
    if (!stage || !box) return;
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    const zoom = clamp(Math.min((w - padding * 2) / Math.max(1, box.width), (h - padding * 2) / Math.max(1, box.height)), 0.02, 16);
    setView({ zoom, x: w / 2 - (box.left + box.width / 2) * zoom, y: h / 2 - (box.top + box.height / 2) * zoom });
  }, []);

  const fitPage = React.useCallback(() => fitTo({ left: 0, top: 0, width: doc.width, height: doc.height }, 24), [fitTo, doc]);

  const sfxBox = React.useCallback(() => {
    const pts = samplePath(modelRef.current.path, 32);
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    pts.forEach((p) => { left = Math.min(left, p[0]); right = Math.max(right, p[0]); top = Math.min(top, p[1]); bottom = Math.max(bottom, p[1]); });
    const pad = modelRef.current.em * modelRef.current.scale;
    return { left: left - pad, top: top - pad, width: right - left + pad * 2, height: bottom - top + pad * 2 };
  }, []);

  React.useLayoutEffect(() => {
    if (!view) fitPage();
    const onResize = () => { if (!viewRef.current) fitPage(); };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const v = view || { zoom: 1, x: 0, y: 0 };
  const toScreen = (p) => [p[0] * v.zoom + v.x, p[1] * v.zoom + v.y];
  const toDoc = (event) => {
    const rect = svgRef.current.getBoundingClientRect();
    return [(event.clientX - rect.left - v.x) / v.zoom, (event.clientY - rect.top - v.y) / v.zoom];
  };

  // Wheel: the page scrolls up and down; Ctrl+wheel: left and right;
  // Alt+wheel: zoom around the pointer. A sideways wheel or a touchpad's
  // sideways swipe (deltaX) scrolls sideways too.
  const onWheel = (event) => {
    event.preventDefault();
    // Line and page deltas (deltaMode 1 and 2) in px
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? (svgRef.current.clientHeight || 600) : 1;
    const deltaX = event.deltaX * unit;
    const deltaY = event.deltaY * unit;
    if (event.altKey) {
      const rect = svgRef.current.getBoundingClientRect();
      const sx = event.clientX - rect.left;
      const sy = event.clientY - rect.top;
      // Some systems send Alt+wheel sideways
      const delta = deltaY || deltaX;
      const factor = Math.exp(-clamp(delta, -300, 300) / 400);
      const zoom = clamp(v.zoom * factor, 0.02, 32);
      const k = zoom / v.zoom;
      setView({ zoom, x: sx - (sx - v.x) * k, y: sy - (sy - v.y) * k });
      return;
    }
    const sideways = event.ctrlKey || event.metaKey;
    const dx = sideways ? deltaY || deltaX : deltaX;
    const dy = sideways ? 0 : deltaY;
    setView({ zoom: v.zoom, x: v.x - dx, y: v.y - dy });
  };

  // React's wheel listener is passive: preventDefault needs a native one
  const wheelRef = React.useRef(onWheel);
  wheelRef.current = onWheel;
  React.useEffect(() => {
    const svg = svgRef.current;
    const listener = (event) => wheelRef.current(event);
    svg.addEventListener("wheel", listener, { passive: false });
    return () => svg.removeEventListener("wheel", listener);
  }, []);

  /* ----------------------------- dragging ---------------------------- */

  const isBlank = (ch) => !String(ch || "").trim();
  const boxOf = (ch) => glyphBoxes[ch] || { left: -model.em / 2, top: -model.em / 2, right: model.em / 2, bottom: model.em / 2 };

  // The four corners of a placed character's box, in document px, its free
  // transform included: top left, top right, bottom right, bottom left
  const warpOf = (m, index) => (m.glyphs[index] && m.glyphs[index].warp) || null;
  const glyphQuad = (placement, pad = 0) => {
    const box = boxOf(placement.ch);
    const at = glyphMapper(placement, model.em, warpOf(model, placement.index));
    const p = pad / Math.max(1e-6, placement.size / model.em);
    return [at(box.left - p, box.top - p), at(box.right + p, box.top - p), at(box.right + p, box.bottom + p), at(box.left - p, box.bottom + p)];
  };

  // Characters the marquee touches (Photoshop's path selection: touching is enough)
  const inMarquee = (rect) => placements.filter((placement) => {
    if (isBlank(placement.ch)) return false;
    const quad = glyphQuad(placement);
    const xs = quad.map((q) => q[0]);
    const ys = quad.map((q) => q[1]);
    return Math.max.apply(null, xs) >= rect.left && Math.min.apply(null, xs) <= rect.right &&
      Math.max.apply(null, ys) >= rect.top && Math.min.apply(null, ys) <= rect.bottom;
  }).map((placement) => placement.index);

  // The character under a document point (the last drawn wins), or null
  const glyphAt = (point) => {
    for (let i = placements.length - 1; i >= 0; i--) {
      const placement = placements[i];
      if (isBlank(placement.ch)) continue;
      const quad = glyphQuad(placement);
      let sign = 0;
      let inside = true;
      for (let k = 0; k < 4 && inside; k++) {
        const a = quad[k];
        const b = quad[(k + 1) % 4];
        const cross = (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]);
        if (cross === 0) continue;
        if (!sign) sign = Math.sign(cross);
        else if (Math.sign(cross) !== sign) inside = false;
      }
      if (inside) return placement.index;
    }
    return null;
  };

  const startDrag = (event, kind, index) => {
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    const point = toDoc(event);
    let mode = kind;
    let selection = selectedRef.current;
    // A click on the dashed line that does not drag picks the character under it
    let lineGlyph = null;
    // Space + drag, or the middle button: the view moves, whatever is under the pointer
    if (event.button === 1 || spaceRef.current) mode = "pan";
    else if (kind === "empty") mode = tool === "draw" || event.altKey ? "draw" : "marquee";
    // Alt+drag on a character: the whole SFX, unless it is one of the selected
    else if (kind === "glyph" && event.altKey) mode = selection.indexOf(index) >= 0 ? "glyph" : "move";
    // The dashed line lies on top of the characters, so a drag on it moves
    // the whole SFX. A selected character under it keeps its own drag, and
    // Shift/Ctrl+click still adds or removes the character under it.
    else if (kind === "guide") {
      const under = glyphAt(point);
      if (under !== null && !event.altKey && (selection.indexOf(under) >= 0 || event.shiftKey || event.ctrlKey || event.metaKey)) {
        mode = "glyph";
        index = under;
      } else {
        mode = "move";
        lineGlyph = under;
      }
    }
    else if (kind === "end") {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey) mode = "scaleAll";
      else if (event.ctrlKey || event.metaKey) mode = "spacing";
      else if (event.shiftKey) mode = "endSize";
      else if (event.altKey) mode = "turnChars";
      // With characters selected, the end squares (with or without a
      // modifier) change only those characters
      if (selection.length) mode = "sel" + mode.charAt(0).toUpperCase() + mode.slice(1);
    }
    if (kind === "anchor" && mode === "anchor") setAnchorPick(index);
    if (mode === "marquee" && !event.shiftKey) setAnchorPick(null);
    if (mode === "glyph") {
      if (event.shiftKey || event.ctrlKey || event.metaKey) {
        // Shift/Ctrl+click: add or remove this character, no drag
        selection = selection.indexOf(index) >= 0 ? selection.filter((i) => i !== index) : selection.concat([index]).sort((a, b) => a - b);
        setSelected(selection);
        return;
      }
      if (selection.indexOf(index) < 0) {
        selection = [index];
        setSelected(selection);
      }
    }
    dragRef.current = {
      mode, index, start: point, last: point, base: modelRef.current, changed: false,
      screen: [event.clientX, event.clientY], view: v, selection, additive: event.shiftKey,
      center: selection.length ? selectionCenter(modelRef.current, selection) : null,
      mid: pathMidpoint(modelRef.current.path), lineGlyph,
    };
    // A corner of one character's frame: the pointer holds the corner where
    // it took it (the handle sits a few px outside the character's box)
    if (mode === "corner") {
      const placed = placements[selection[0]];
      if (!placed) {
        dragRef.current = null;
        return;
      }
      const handlePoint = frameHandles(glyphQuad(placed))[index];
      dragRef.current.offset = [handlePoint[0] - point[0], handlePoint[1] - point[1]];
    }
    if (mode === "draw") setStroke([point]);
    if (mode === "marquee") setMarquee({ from: point, to: point });
    try { svgRef.current.setPointerCapture(event.pointerId); } catch (error) {}
  };

  const dragTo = (drag, point, event) => {
    const base = drag.base;
    const dx = point[0] - drag.start[0];
    const dy = point[1] - drag.start[1];
    switch (drag.mode) {
      case "move":
        return Object.assign({}, base, { path: translatePath(base.path, dx, dy) });
      case "end":
        return Object.assign({}, base, { path: moveEnd(base.path, drag.index, point) });
      case "bend":
        // Line and arc: an arc through the pointer; a Bézier or hand-drawn
        // path bends as a whole, its ends fixed
        if (base.path.type === "line" || base.path.type === "arc") return Object.assign({}, base, { path: bendTo(base.path, point) });
        return Object.assign({}, base, { path: bendWhole(base.path, [dx, dy]) });
      // Bézier anchors and their handles (Alt: a smooth anchor's handles
      // part ways, as in Photoshop)
      case "anchor":
        return moveAnchor(base, drag.index, point);
      case "handle":
        return moveHandle(base, drag.index.node, drag.index.side, point, event.altKey);
      // The ◆ in the middle of a selection: just that stretch bends
      case "stretch":
        return bendStretch(base, drag.selection, [dx, dy]);
      case "endSize": {
        const key = drag.index === 0 ? "startScale" : "endScale";
        const screenDy = event.clientY - drag.screen[1];
        return Object.assign({}, base, { [key]: clamp(base[key] * Math.exp(-screenDy / 150), LIMITS.endScale[0], LIMITS.endScale[1]) });
      }
      case "spacing":
      case "scaleAll": {
        const before = Math.hypot(drag.start[0] - drag.mid[0], drag.start[1] - drag.mid[1]);
        const after = Math.hypot(point[0] - drag.mid[0], point[1] - drag.mid[1]);
        const k = before > 1e-6 ? clamp(after / before, 0.05, 20) : 1;
        if (drag.mode === "spacing") return Object.assign({}, base, { path: scalePath(base.path, k, drag.mid) });
        return Object.assign({}, base, {
          scale: clamp(base.scale * k, LIMITS.scale[0], LIMITS.scale[1]),
          path: scalePath(base.path, k, drag.mid),
          glyphs: base.glyphs.map((g) => Object.assign({}, g, { dx: g.dx * k, dy: g.dy * k })),
        });
      }
      case "turnChars": {
        const screenDx = event.clientX - drag.screen[0];
        return Object.assign({}, base, { rotation: clamp(base.rotation + screenDx * 0.5, LIMITS.rotation[0], LIMITS.rotation[1]) });
      }
      case "glyph":
        return transformSelection(base, drag.selection, { dx, dy });
      // Free transform of one character by a handle of its frame: a corner
      // or side stretches it (Shift: in proportion around its middle; a side
      // around its middle too), Ctrl distorts (a side skews). The modifiers
      // are read live, so they can change during the drag.
      case "corner": {
        const i = drag.selection[0];
        const target = [point[0] + drag.offset[0], point[1] + drag.offset[1]];
        return freeTransformGlyph(base, i, drag.index, target, {
          box: boxOf(chars(base.text)[i]),
          distort: event.ctrlKey || event.metaKey,
          fromCenter: event.shiftKey,
        });
      }
      // End squares with a modifier while characters are selected
      case "selSpacing":
      case "selScaleAll": {
        const c = drag.center;
        const before = Math.hypot(drag.start[0] - c[0], drag.start[1] - c[1]);
        const after = Math.hypot(point[0] - c[0], point[1] - c[1]);
        const k = before > 1e-6 ? clamp(after / before, 0.05, 20) : 1;
        return transformSelection(base, drag.selection, { k, center: c, keepSize: drag.mode === "selSpacing" });
      }
      // A plain end drag on a selection: the path bends where the selection
      // starts and follows the pointer; the rest of the SFX stays put
      case "selEnd":
        return bendAtSelection(base, drag.selection, drag.index, point);
      case "selTurnChars":
        return turnEach(base, drag.selection, (event.clientX - drag.screen[0]) * 0.5);
      case "selEndSize":
        return rampSize(base, drag.selection, clamp(Math.exp(-(event.clientY - drag.screen[1]) / 150), 0.1, 10), drag.index === 1);
      case "rotate": {
        const c = drag.center;
        const a0 = Math.atan2(drag.start[1] - c[1], drag.start[0] - c[0]);
        const a1 = Math.atan2(point[1] - c[1], point[0] - c[0]);
        let angle = (a1 - a0) * DEG;
        if (event.shiftKey) angle = Math.round(angle / 15) * 15;
        return transformSelection(base, drag.selection, { angle, center: c });
      }
      case "scale": {
        const c = drag.center;
        const before = Math.hypot(drag.start[0] - c[0], drag.start[1] - c[1]);
        const after = Math.hypot(point[0] - c[0], point[1] - c[1]);
        return transformSelection(base, drag.selection, { k: before > 1e-6 ? clamp(after / before, 0.05, 20) : 1, center: c });
      }
      default:
        return base;
    }
  };

  const onPointerMove = (event) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.mode === "pan") {
      setView({ zoom: drag.view.zoom, x: drag.view.x + event.clientX - drag.screen[0], y: drag.view.y + event.clientY - drag.screen[1] });
      return;
    }
    const point = toDoc(event);
    if (drag.mode === "draw") {
      setStroke((pts) => (pts ? pts.concat([point]) : [point]));
      return;
    }
    if (drag.mode === "marquee") {
      setMarquee({ from: drag.start, to: point });
      return;
    }
    // A click that wobbles a pixel or two is still a click, not an edit
    if (!drag.moved && Math.hypot(event.clientX - drag.screen[0], event.clientY - drag.screen[1]) < 3) return;
    drag.moved = true;
    drag.last = point;
    const next = dragTo(drag, point, event);
    if (next !== drag.base) {
      drag.changed = true;
      setModel(next);
    }
  };

  const onPointerUp = (event) => {
    const drag = dragRef.current;
    dragRef.current = null;
    try { svgRef.current.releasePointerCapture(event.pointerId); } catch (error) {}
    if (!drag) return;
    if (drag.mode === "draw") {
      const pts = smoothStroke(stroke || [], 2 / v.zoom);
      setStroke(null);
      const length = pts.reduce((sum, p, i) => (i ? sum + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);
      if (pts.length >= 2 && length > 8 / v.zoom) {
        edit((m) => Object.assign({}, m, { path: { type: "free", pts } }));
        setTool("edit");
      }
      return;
    }
    if (drag.mode === "marquee") {
      setMarquee(null);
      const end = toDoc(event);
      const tiny = Math.hypot(event.clientX - drag.screen[0], event.clientY - drag.screen[1]) < 3;
      const rect = { left: Math.min(drag.start[0], end[0]), right: Math.max(drag.start[0], end[0]), top: Math.min(drag.start[1], end[1]), bottom: Math.max(drag.start[1], end[1]) };
      const hits = tiny ? [] : inMarquee(rect);
      if (drag.additive) {
        const merged = drag.selection.slice();
        hits.forEach((i) => { if (merged.indexOf(i) < 0) merged.push(i); });
        setSelected(merged.sort((a, b) => a - b));
      } else setSelected(hits);
      return;
    }
    if (drag.changed) remember(drag.base);
    else if (drag.mode === "move" && !drag.moved && drag.lineGlyph !== null) setSelected([drag.lineGlyph]);
  };

  /* ----------------------------- keyboard ---------------------------- */

  const anchorPickRef = React.useRef(anchorPick);
  anchorPickRef.current = anchorPick;
  const selectedRef = React.useRef(selected);
  selectedRef.current = selected;

  React.useEffect(() => {
    const typing = (event) => {
      const target = event.target;
      return target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA") && target.type !== "range";
    };
    const onKeyDown = (event) => {
      const ctrl = event.ctrlKey || event.metaKey;
      if (ctrl && event.key === "Enter") {
        event.preventDefault();
        applyRef.current();
        return;
      }
      if (typing(event)) return;
      if (ctrl && (event.key === "z" || event.key === "Z")) {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (ctrl && (event.key === "y" || event.key === "Y")) {
        event.preventDefault();
        redo();
        return;
      }
      const list = chars(modelRef.current.text);
      if (ctrl && (event.key === "a" || event.key === "A")) {
        event.preventDefault();
        setSelected(list.map((ch, i) => i).filter((i) => !isBlank(list[i])));
        return;
      }
      if (event.key === " ") {
        spaceRef.current = true;
        setPanning(true);
        event.preventDefault();
        return;
      }
      const selection = selectedRef.current;
      if (event.key === "Escape") {
        event.preventDefault();
        if (tool === "draw") setTool("edit");
        else if (anchorPickRef.current !== null) setAnchorPick(null);
        else setSelected([]);
        return;
      }
      if ((event.key === "PageUp" || event.key === "PageDown") && modelsRef.current.length > 1) {
        event.preventDefault();
        const layers = modelsRef.current.length;
        switchRef.current((activeRef.current + (event.key === "PageUp" ? -1 : 1) + layers) % layers);
        return;
      }
      const length = list.length;
      if (event.key === "Tab" && length) {
        event.preventDefault();
        const step = event.shiftKey ? -1 : 1;
        const current = selection.length ? selection[step > 0 ? selection.length - 1 : 0] : (step > 0 ? -1 : length);
        let next = current;
        for (let n = 0; n < length; n++) {
          next = (next + step + length) % length;
          if (!isBlank(list[next])) break;
        }
        setSelected([next]);
        return;
      }
      if (!selection.length) return;
      const big = event.shiftKey;
      const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (moves[event.key]) {
        event.preventDefault();
        const d = moves[event.key].map((n) => n * (big ? 10 : 1));
        edit((m) => transformSelection(m, selection, { dx: d[0], dy: d[1] }), "nudge");
      } else if (event.key === "[" || event.key === "]") {
        event.preventDefault();
        const angle = (event.key === "[" ? -1 : 1) * (big ? 15 : 1);
        edit((m) => transformSelection(m, selection, { angle }), "rotate");
      } else if (event.key === "+" || event.key === "=" || event.key === "-" || event.key === "_") {
        event.preventDefault();
        const up = event.key === "+" || event.key === "=";
        const k = Math.pow(big ? 1.1 : 1.02, up ? 1 : -1);
        edit((m) => transformSelection(m, selection, { k }), "size");
      } else if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        const next = removeGlyphs(modelRef.current, selection);
        edit(() => next);
        setTextDraft(next.text);
        setSelected([]);
      }
    };
    const onKeyUp = (event) => {
      if (event.key === " ") {
        spaceRef.current = false;
        setPanning(false);
      }
    };
    const onBlur = () => {
      spaceRef.current = false;
      setPanning(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [tool, undo, redo, edit]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ------------------------------ actions ---------------------------- */

  // Another layer on the controls; the page view stays where it is
  const switchTo = (index) => {
    const next = clampIndex(index, count);
    if (next === activeRef.current || dragRef.current) return;
    flushText();
    activeRef.current = next;
    setActive(next);
    setSelected([]);
    setAnchorPick(null);
    setTool("edit");
    setTextDraft(modelsRef.current[next].text || "");
  };
  const switchRef = React.useRef(switchTo);
  switchRef.current = switchTo;

  // A click on a layer that is not active makes it active (Space or the
  // middle button still pan)
  const pickLayer = (event, index) => {
    if (event.button === 1 || spaceRef.current) {
      startDrag(event, "empty");
      return;
    }
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    switchTo(index);
  };

  // Every layer's model goes back, one per layer
  const apply = () => {
    if (busy) return;
    const list = modelsRef.current.slice();
    const flushed = flushText();
    if (flushed) list[activeRef.current] = flushed;
    const empty = firstEmpty(list);
    if (empty >= 0) {
      switchTo(empty);
      setNotices([count > 1 ? { key: "sfxEmptyText", layer: items[empty].layerName } : { key: "sfxEmptyText" }]);
      return;
    }
    setBusy(true);
    bridge.apply({ models: list, active: activeRef.current, view: viewRef.current });
  };
  const applyRef = React.useRef(apply);
  applyRef.current = apply;

  // Every adjustment undone: a straight line where the SFX started
  const resetEverything = () => {
    const start = normalizeModel(items[active].start || items[active].model);
    edit((m) => resetLayout(m, { center: pathMidpoint(start.path), vertical: start.upright }));
    setSelected([]);
  };

  const selectedGlyphs = selected.map((i) => model.glyphs[i]).filter(Boolean);
  const single = selected.length === 1 ? placements[selected[0]] : null;
  const firstGlyph = selectedGlyphs[0] || null;
  const editSelected = (fn, tag) => edit((m) => updateGlyphs(m, selectedRef.current, fn), tag);

  /* ------------------------------ render ----------------------------- */

  const color = toHex(model.color);
  const ends = pathEnds(model.path).map(toScreen);
  const bend = toScreen(bendHandle(model.path));
  const stretchAt = selected.length ? stretchHandle(model, selected) : null;
  const stretch = stretchAt ? toScreen(stretchAt) : null;
  // The two middle handles on top of each other: the selection's wins
  const showBend = !stretch || Math.hypot(stretch[0] - bend[0], stretch[1] - bend[1]) > 12;
  const anchors = pathAnchors(model.path).map((a) => ({ index: a.index, p: toScreen(a.p) }));
  const pickedAnchor = anchorPick !== null && model.path.type === "bezier" && anchorPick > 0 && anchorPick < model.path.nodes.length - 1 ? anchorPick : null;
  // Control handles: each shown segment's two, from its anchors
  const handleList = [];
  handleSegments(model, pickedAnchor, selected).forEach((s) => {
    handleList.push({ node: s, side: "o", from: toScreen(model.path.nodes[s].p), at: toScreen(handlePoint(model.path, s, "o")) });
    handleList.push({ node: s + 1, side: "i", from: toScreen(model.path.nodes[s + 1].p), at: toScreen(handlePoint(model.path, s + 1, "i")) });
  });
  const guidePoints = guide.map((p) => toScreen(p).map((n) => round(n, 1)).join(",")).join(" ");
  const strokePoints = stroke ? stroke.map((p) => toScreen(p).map((n) => round(n, 1)).join(",")).join(" ") : "";

  // Selection outline: each character's box; one character gets its own
  // handles, several get a box around all of them
  const selectedPlacements = selected.map((i) => placements[i]).filter(Boolean);
  const quads = selectedPlacements.map((placement) => glyphQuad(placement, 4 / v.zoom).map(toScreen));
  let handles = null;
  // One character: Photoshop's Free Transform frame, right on its box, with
  // a handle on each corner and side and its outline drawn over it.
  // Turning: drag just outside a corner.
  let transformFrame = null;
  if (single) {
    const quad = glyphQuad(single).map(toScreen);
    const singleWarp = warpOf(model, single.index);
    transformFrame = {
      quad,
      handles: frameHandles(quad),
      outline: outlines[single.ch] ? toSvgPath(placedOutline(outlines[single.ch], single, model.em, singleWarp)) : null,
    };
  } else if (quads.length > 1) {
    const xs = [].concat(...quads.map((q) => q.map((p) => p[0])));
    const ys = [].concat(...quads.map((q) => q.map((p) => p[1])));
    const box = { left: Math.min(...xs) - 4, top: Math.min(...ys) - 4, right: Math.max(...xs) + 4, bottom: Math.max(...ys) + 4 };
    const topMid = [(box.left + box.right) / 2, box.top];
    handles = { topMid, knob: [topMid[0], topMid[1] - 22], corner: [box.right, box.bottom], frame: box };
  }
  const marqueeRect = marquee ? (() => {
    const a = toScreen(marquee.from);
    const b = toScreen(marquee.to);
    return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), width: Math.abs(a[0] - b[0]), height: Math.abs(a[1] - b[1]) };
  })() : null;

  // {key, detail?, layer?, reason?}: a layer's notice names it when several are open
  const noticeText = (notice) => {
    if (typeof notice === "string") return t(notice);
    let text = t(notice.key);
    if (notice.reason) text = text.replace("{reason}", t("sfxSkip" + notice.reason.charAt(0).toUpperCase() + notice.reason.slice(1)));
    if (text.indexOf("{layer}") >= 0) text = text.replace("{layer}", notice.layer || "");
    else if (notice.layer) text = notice.layer + ": " + text;
    return text + (notice.detail ? " (" + notice.detail + ")" : "");
  };

  const item = items[active];
  // Development builds: what the live check reads and does in the window
  if (process.env.TYPER_DEV === "1" && typeof window !== "undefined") {
    window.__sfxDev = {
      state: () => ({ count, active: activeRef.current, texts: modelsRef.current.map((m) => m.text), layers: items.map((entry) => entry.layerName),
        modes: items.map((entry) => entry.mode), rotations: modelsRef.current.map((m) => m.rotation), notices: notices.map(noticeText) }),
      switchTo: (index) => { switchRef.current(index); return true; },
      rotate: (degrees) => { edit((m) => Object.assign({}, m, { rotation: degrees })); return true; },
      apply: () => { applyRef.current(); return true; },
      cancel: () => { bridge.cancel(); return true; },
      view: () => viewRef.current,
      selection: () => selectedRef.current.slice(),
      model: () => modelRef.current,
      // Code run in the window, for events the ops above do not cover
      run: (code) => new Function("window", code)(window),
    };
  }
  const canUndo = historyOf().past.length > 0;
  const canRedo = historyOf().future.length > 0;
  const selectionTitle = selected.length === 1 && single ? t("sfxSelected") + " · " + single.ch
    : selected.length > 1 ? t("sfxSelectedMany").replace("{count}", String(selected.length)) : t("sfxSelected");

  return (
    <div className={"sfx-editor" + (tool === "draw" ? " is-drawing" : "") + (panning ? " is-panning" : "")}>
      <div className="sfx-stage">
        <div className="sfx-canvas-wrap" ref={stageRef}>
        <svg
          ref={svgRef}
          className="sfx-canvas"
          onPointerDown={(event) => startDrag(event, "empty")}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onContextMenu={(event) => event.preventDefault()}
        >
          <g transform={"translate(" + v.x + " " + v.y + ") scale(" + v.zoom + ")"}>
            <rect x="0" y="0" width={doc.width} height={doc.height} className="sfx-page" />
            {init.preview ? (
              <image href={init.preview.src} x="0" y="0" width={doc.width} height={doc.height} preserveAspectRatio="none" />
            ) : null}
            {models.map((m, i) => (i === active ? null : (
              <g key={"layer" + i} className="sfx-other">
                {layoutOf(m).map((placement) => {
                  const d = svgPathsOf(outlineSets[i])[placement.ch];
                  if (!d) return null;
                  const warp = warpOf(m, placement.index);
                  if (warp) return <path key={placement.index} d={toSvgPath(placedOutline(outlineSets[i][placement.ch], placement, m.em, warp))} fill={toHex(m.color)} fillRule="nonzero" />;
                  return <path key={placement.index} d={d} fill={toHex(m.color)} fillRule="nonzero" transform={"matrix(" + glyphMatrix(placement, m.em).join(" ") + ")"} />;
                })}
              </g>
            )))}
            {placements.map((placement) => {
              const d = svgPaths[placement.ch];
              if (!d) return null;
              // A freely transformed character is drawn from its placed outline
              const warp = warpOf(model, placement.index);
              if (warp) return <path key={placement.index} d={toSvgPath(placedOutline(outlines[placement.ch], placement, model.em, warp))} fill={color} fillRule="nonzero" />;
              const m = glyphMatrix(placement, model.em);
              return <path key={placement.index} d={d} fill={color} fillRule="nonzero" transform={"matrix(" + m.join(" ") + ")"} />;
            })}
          </g>
          <g transform={"translate(" + v.x + " " + v.y + ") scale(" + v.zoom + ")"}>
            {models.map((m, i) => (i === active ? null : layoutOf(m).map((placement) => {
              if (isBlank(placement.ch)) return null;
              const half = m.em / 2;
              const warp = warpOf(m, placement.index);
              if (warp) {
                const at = glyphMapper(placement, m.em, warp);
                return (
                  <polygon
                    key={"other" + i + "-" + placement.index}
                    className="sfx-other-hit"
                    points={emSquare(m.em).map((p) => at(p[0], p[1]).join(",")).join(" ")}
                    onPointerDown={(event) => pickLayer(event, i)}
                  >
                    <title>{items[i].layerName || m.text}</title>
                  </polygon>
                );
              }
              return (
                <rect
                  key={"other" + i + "-" + placement.index}
                  className="sfx-other-hit"
                  x={-half} y={-half} width={m.em} height={m.em}
                  transform={"matrix(" + glyphMatrix(placement, m.em).join(" ") + ")"}
                  onPointerDown={(event) => pickLayer(event, i)}
                >
                  <title>{items[i].layerName || m.text}</title>
                </rect>
              );
            })))}
            {placements.map((placement) => {
              // A space keeps its room on the path, but has nothing to show or pick
              if (isBlank(placement.ch)) return null;
              const hitClass = "sfx-glyph-hit" + (!svgPaths[placement.ch] ? " is-missing" : "");
              if (warpOf(model, placement.index)) {
                return (
                  <polygon
                    key={"hit" + placement.index}
                    className={hitClass}
                    points={glyphQuad(placement).map((p) => p.join(",")).join(" ")}
                    onPointerDown={(event) => startDrag(event, "glyph", placement.index)}
                  />
                );
              }
              const box = boxOf(placement.ch);
              const m = glyphMatrix(placement, model.em);
              return (
                <rect
                  key={"hit" + placement.index}
                  className={"sfx-glyph-hit" + (!svgPaths[placement.ch] ? " is-missing" : "")}
                  x={box.left} y={box.top} width={box.right - box.left} height={box.bottom - box.top}
                  transform={"matrix(" + m.join(" ") + ")"}
                  onPointerDown={(event) => startDrag(event, "glyph", placement.index)}
                />
              );
            })}
          </g>
          {/* The dashed line moves the whole SFX: it is above the characters,
              which take the clicks everywhere else */}
          <polyline points={guidePoints} className="sfx-guide-hit" onPointerDown={(event) => startDrag(event, "guide")} />
          {transformFrame && transformFrame.outline ? (
            <g className="sfx-glyph-outline" transform={"translate(" + v.x + " " + v.y + ") scale(" + v.zoom + ")"}>
              <path d={transformFrame.outline} />
            </g>
          ) : null}
          <g className="sfx-overlay">
            {models.map((m, i) => (i === active ? null : (
              <polyline key={"guide" + i} className="sfx-guide sfx-guide-other" points={guideOf(m).map((p) => toScreen(p).map((n) => round(n, 1)).join(",")).join(" ")} />
            )))}
            <polyline points={guidePoints} className="sfx-guide" />
            {stroke ? <polyline points={strokePoints} className="sfx-stroke" /> : null}
            {transformFrame ? (
              <g className="sfx-selection sfx-transform">
                {transformFrame.quad.map((p, k) => (
                  <circle key={"turn" + k} cx={p[0]} cy={p[1]} r={18} className="sfx-rotate-zone" onPointerDown={(event) => startDrag(event, "rotate")} />
                ))}
                <polygon
                  className="sfx-transform-frame"
                  points={transformFrame.quad.map((p) => p.join(",")).join(" ")}
                  onPointerDown={(event) => startDrag(event, "glyph", single.index)}
                />
                {transformFrame.handles.map((p, k) => (
                  <rect
                    key={"frame" + k}
                    x={p[0] - 5} y={p[1] - 5} width={10} height={10}
                    className={"sfx-handle sfx-corner is-handle-" + k}
                    onPointerDown={(event) => startDrag(event, "corner", k)}
                  />
                ))}
              </g>
            ) : null}
            {quads.length > 1 ? (
              <g className="sfx-selection">
                {quads.map((quad, i) => <polygon key={i} points={quad.map((p) => p.join(",")).join(" ")} />)}
                {handles && handles.frame ? (
                  <rect className="sfx-group-frame" x={handles.frame.left} y={handles.frame.top} width={handles.frame.right - handles.frame.left} height={handles.frame.bottom - handles.frame.top} />
                ) : null}
                {handles ? (
                  <React.Fragment>
                    <line x1={handles.topMid[0]} y1={handles.topMid[1]} x2={handles.knob[0]} y2={handles.knob[1]} />
                    <circle cx={handles.knob[0]} cy={handles.knob[1]} r={6} className="sfx-handle" onPointerDown={(event) => startDrag(event, "rotate")} />
                    <rect x={handles.corner[0] - 5} y={handles.corner[1] - 5} width={10} height={10} className="sfx-handle" onPointerDown={(event) => startDrag(event, "scale")} />
                  </React.Fragment>
                ) : null}
              </g>
            ) : null}
            {marqueeRect ? <rect className="sfx-marquee" x={marqueeRect.x} y={marqueeRect.y} width={marqueeRect.width} height={marqueeRect.height} /> : null}
            {handleList.map((h) => (
              <g key={"h" + h.node + h.side} className="sfx-ctrl">
                <line x1={h.from[0]} y1={h.from[1]} x2={h.at[0]} y2={h.at[1]} />
                <circle cx={h.at[0]} cy={h.at[1]} r={4} onPointerDown={(event) => startDrag(event, "handle", { node: h.node, side: h.side })} />
              </g>
            ))}
            {anchors.map((a) => (
              <rect
                key={"anchor" + a.index}
                className={"sfx-anchor" + (a.index === pickedAnchor ? " is-active" : "")}
                x={a.p[0] - 3.5} y={a.p[1] - 3.5} width={7} height={7}
                onPointerDown={(event) => startDrag(event, "anchor", a.index)}
              />
            ))}
            {showBend ? (
              <circle cx={bend[0]} cy={bend[1]} r={6} className="sfx-handle sfx-bend" onPointerDown={(event) => startDrag(event, "bend")} />
            ) : null}
            {stretch ? (
              <rect
                x={stretch[0] - 5} y={stretch[1] - 5} width={10} height={10}
                transform={"rotate(45 " + stretch[0] + " " + stretch[1] + ")"}
                className="sfx-handle sfx-stretch"
                onPointerDown={(event) => startDrag(event, "stretch")}
              />
            ) : null}
            {ends.map((p, i) => (
              <rect
                key={"end" + i}
                x={p[0] - HANDLE / 2} y={p[1] - HANDLE / 2} width={HANDLE} height={HANDLE}
                className={"sfx-handle sfx-end" + (i === 0 ? " is-start" : "")}
                onPointerDown={(event) => startDrag(event, "end", i)}
              />
            ))}
          </g>
        </svg>
        {notices.length ? (
          <div className="sfx-notices">
            {notices.map((notice, i) => (
              <div key={i} className="sfx-notice" title="×" onClick={() => setNotices((list) => list.filter((n, j) => j !== i))}>
                <span>{noticeText(notice)}</span>
                <span className="sfx-notice-close">×</span>
              </div>
            ))}
          </div>
        ) : null}
        <div className="sfx-viewbar">
          <button type="button" onClick={undo} disabled={!canUndo} title="Ctrl+Z">{t("sfxUndo")}</button>
          <button type="button" onClick={redo} disabled={!canRedo} title="Ctrl+Shift+Z">{t("sfxRedo")}</button>
          <span className="sfx-sep" />
          <button type="button" onClick={fitPage}>{t("sfxFitPage")}</button>
          <button type="button" onClick={() => fitTo(sfxBox())}>{t("sfxFitSfx")}</button>
          <span className="sfx-zoom">{Math.round(v.zoom * 100)}%</span>
          {loading ? <span className="sfx-loading">{t("sfxLoadingGlyphs")}</span> : null}
        </div>
        </div>
        <ShortcutHelp t={t} groups={tool === "draw" ? ["Draw"] : (selected.length ? ["Selection", "Keys"] : ["Canvas", "Path"]).concat(anchors.length || handleList.length ? ["Curve"] : [])} />
      </div>

      <aside className="sfx-side">
        <div className="sfx-side-scroll">
          {count > 1 ? (
            <div className="sfx-layers">
              <div className="sfx-group-title">{t("sfxLayers").replace("{count}", String(count))}</div>
              {items.map((entry, i) => (
                <button
                  key={i} type="button" title={entry.layerName}
                  className={"sfx-layer" + (i === active ? " is-active" : "")}
                  onClick={() => switchTo(i)}
                >
                  <span className="sfx-layer-swatch" style={{ background: toHex(models[i].color) }} />
                  <span className="sfx-layer-text">{models[i].text || entry.layerName}</span>
                  {entry.layerName && entry.layerName !== models[i].text ? <span className="sfx-layer-name">{entry.layerName}</span> : null}
                </button>
              ))}
            </div>
          ) : null}
          <div className="sfx-mode">{t(item.mode === "update" ? "sfxModeUpdate" : "sfxModeNew")}</div>
          {item.font && item.font.name ? <div className="sfx-font">{t("sfxFont")}: {item.font.name}{item.font.style ? " " + item.font.style : ""}</div> : null}

          <label className="sfx-field sfx-field-text">
            <span className="sfx-field-label">{t("sfxText")}</span>
            <input type="text" value={textDraft} onChange={(event) => onTextChange(event.target.value)} />
          </label>
          <label className="sfx-field">
            <span className="sfx-field-label">{t("sfxColor")}</span>
            <input type="color" value={color} onChange={(event) => { const c = fromHex(event.target.value); if (c) edit((m) => Object.assign({}, m, { color: c }), "color"); }} />
            <span className="sfx-field-number sfx-hex">{color.toUpperCase()}</span>
          </label>

          <div className="sfx-group">
            <div className="sfx-group-title">{t("sfxPath")}</div>
            <Field label={t("sfxTracking")} value={tracking} min={-80} max={300} unit="%" onChange={(value) => edit((m) => withTracking(m, value), "tracking")} />
            <Field label={t("sfxSize")} value={model.scale * 100} min={10} max={500} unit="%" onChange={(value) => edit((m) => {
              const scale = clamp(value / 100, LIMITS.scale[0], LIMITS.scale[1]);
              const k = scale / m.scale;
              return Object.assign({}, m, { scale, path: scalePath(m.path, k) });
            }, "size")} />
            <Field label={t("sfxStartSize")} value={model.startScale * 100} min={10} max={500} unit="%" onChange={(value) => edit((m) => Object.assign({}, m, { startScale: clamp(value / 100, LIMITS.endScale[0], LIMITS.endScale[1]) }), "start")} />
            <Field label={t("sfxEndSize")} value={model.endScale * 100} min={10} max={500} unit="%" onChange={(value) => edit((m) => Object.assign({}, m, { endScale: clamp(value / 100, LIMITS.endScale[0], LIMITS.endScale[1]) }), "end")} />
            <Field label={t("sfxRotation")} value={model.rotation} min={-180} max={180} unit="°" onChange={(value) => edit((m) => Object.assign({}, m, { rotation: clamp(value, LIMITS.rotation[0], LIMITS.rotation[1]) }), "rotation")} />
            <div className="sfx-field">
              <span className="sfx-field-label">{t("sfxOrientation")}</span>
              <div className="sfx-segmented">
                <button type="button" className={!model.upright ? "is-active" : ""} onClick={() => edit((m) => Object.assign({}, m, { upright: false }))}>{t("sfxAlongPath")}</button>
                <button type="button" className={model.upright ? "is-active" : ""} onClick={() => edit((m) => Object.assign({}, m, { upright: true }))}>{t("sfxUpright")}</button>
              </div>
            </div>
          </div>

          <div className="sfx-group">
            <div className="sfx-group-title">{selectionTitle}</div>
            {single && firstGlyph ? (
              <React.Fragment>
                <Field label={t("sfxOffsetX")} value={firstGlyph.dx} min={-model.em * 4} max={model.em * 4} unit="px" onChange={(value) => editSelected(() => ({ dx: value }), "gx")} />
                <Field label={t("sfxOffsetY")} value={firstGlyph.dy} min={-model.em * 4} max={model.em * 4} unit="px" onChange={(value) => editSelected(() => ({ dy: value }), "gy")} />
              </React.Fragment>
            ) : null}
            {firstGlyph ? (
              <React.Fragment>
                <Field label={t("sfxGlyphRotation")} value={firstGlyph.rot} min={-180} max={180} unit="°" onChange={(value) => editSelected(() => ({ rot: clamp(value, LIMITS.rotation[0], LIMITS.rotation[1]) }), "grot")} />
                <Field label={t("sfxGlyphSize")} value={firstGlyph.scale * 100} min={10} max={500} unit="%" onChange={(value) => editSelected(() => ({ scale: clamp(value / 100, LIMITS.glyphScale[0], LIMITS.glyphScale[1]) }), "gscale")} />
                <button type="button" className="sfx-wide" onClick={() => editSelected(() => defaultGlyph())}>{t(selected.length > 1 ? "sfxResetSelected" : "sfxResetGlyph")}</button>
              </React.Fragment>
            ) : <div className="sfx-hint">{t("sfxNoSelection")}</div>}
            <button type="button" className="sfx-wide" onClick={() => edit((m) => Object.assign({}, m, { glyphs: m.glyphs.map(() => defaultGlyph()) }))}>{t("sfxResetAll")}</button>
          </div>

          <div className="sfx-group">
            <button type="button" className="sfx-wide" onClick={resetEverything} title={t("sfxResetEverythingHint")}>{t("sfxResetEverything")}</button>
          </div>
        </div>
        <div className="sfx-actions">
          <button type="button" onClick={() => bridge.cancel()} disabled={busy}>{t("sfxCancel")}</button>
          <button type="button" className="is-primary" onClick={apply} disabled={busy} title="Ctrl+Enter">{t("sfxApply")}</button>
        </div>
      </aside>
    </div>
  );
}
