// Ruby (行间注) editor window (uxp/ruby, a WebView in a modal Photoshop
// dialog). The page is drawn at the document's size with the base layer's
// characters as Photoshop placed them (init.glyphs): drag across characters
// to add a note for them, then write it in the list on the right. The notes
// are drawn where Apply will put them, from estimated lengths; Apply
// measures the real note layers in Photoshop.
import React from "react";
import { predictLayout, normalizeNote, clampSpan, DEFAULTS, LIMITS } from "../layout";

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const UNDO_LIMIT = 200;
const round = (value, digits = 0) => {
  const k = Math.pow(10, digits);
  return Math.round(value * k) / k;
};

// English fallbacks; the host sends the interface language's strings
const FALLBACK = {
  rubyTitle: "Ruby notes",
  rubyApply: "Apply",
  rubyCancel: "Cancel",
  rubyModeNew: "New notes",
  rubyModeUpdate: "Editing notes (re-aligned to the text as it is now)",
  rubyBase: "Text layer: {name}",
  rubyFont: "Font: {font}",
  rubyHint: "Drag across characters on the left to add a note for them.",
  rubyHintPick: "Drag across the characters for this note.",
  rubyNoNotes: "No notes yet.",
  rubyNoteText: "Note",
  rubyAlign: "Align",
  rubyAlignCenter: "Center",
  rubyAlignStartV: "Top",
  rubyAlignStartH: "Left",
  rubyAlignSpread: "Spread",
  rubyOverflow: "Too long",
  rubyOverflowShrink: "Smaller size",
  rubyOverflowSqueeze: "Narrower characters",
  rubyOverflowOverhang: "Let it run over",
  rubyOverflowSpread: "Space out the text",
  rubySize: "Size",
  rubySizeAuto: "auto",
  rubySizeReset: "Auto",
  rubyRatio: "Size ratio",
  rubyGap: "Gap",
  rubyRepick: "Pick again",
  rubyDelete: "Delete",
  rubyFitPage: "Fit page",
  rubyFitText: "Fit text",
  rubyHelp: "Wheel: zoom · Space or right-drag: pan · Ctrl+Z: undo · Delete: remove note",
  rubyUndo: "Undo",
  rubyRedo: "Redo",
  rubyErrEmpty: "No characters picked.",
  rubyErrCrossLine: "A note cannot run across a line break.",
  rubyErrOverlap: "These characters already have a note.",
  rubyErrNoText: "Write the note.",
  rubyErrLost: "The text changed and these characters are gone: pick them again.",
  rubyErrOutside: "These characters are no longer in the text.",
  rubyWarnCollision: "Runs into the next note.",
  rubyWarnOverhang: "Longer than its characters.",
  rubyWarnSpread: "Apply spaces out these characters.",
  rubyWarnLeading: "Too close to the line before: Apply moves this line away to make room.",
  rubyFixFirst: "Fix the notes marked in red first.",
  rubyNoteMoved: "The text changed: notes were matched to their characters again.",
  rubyNoteLost: "The text changed: some notes lost their characters. Pick them again or delete them.",
  rubyApplyFailed: "Photoshop could not apply the notes. The document was left as it was.",
  rubyPickTaken: "Those characters already have a note.",
};

const ERRORS = {
  empty: "rubyErrEmpty", crossLine: "rubyErrCrossLine", overlap: "rubyErrOverlap", noText: "rubyErrNoText", outside: "rubyErrOutside",
};

function useStrings(strings) {
  return React.useCallback((key) => (strings && strings[key]) || FALLBACK[key] || key, [strings]);
}

const toHex = (c) => (c ? "#" + [c.r, c.g, c.b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join("") : "#000000");

let nextId = 1;
const newId = () => "e" + Date.now().toString(36) + (nextId++);

function Segmented({ value, options, onChange }) {
  return (
    <div className="rb-segmented">
      {options.map(([key, label]) => (
        <button key={key} type="button" className={value === key ? "is-active" : ""} onClick={() => onChange(key)}>{label}</button>
      ))}
    </div>
  );
}

function NumberField({ label, value, placeholder, unit, step = 1, min, max, onChange, extra }) {
  const [draft, setDraft] = React.useState(value === null || value === undefined ? "" : String(value));
  React.useEffect(() => { setDraft(value === null || value === undefined ? "" : String(value)); }, [value]);
  return (
    <label className="rb-field">
      <span className="rb-field-label">{label}</span>
      <input
        type="number" step={step} min={min} max={max} value={draft} placeholder={placeholder}
        onChange={(event) => {
          setDraft(event.target.value);
          if (event.target.value === "") onChange(null);
          else {
            const v = Number(event.target.value);
            if (isFinite(v)) onChange(v);
          }
        }}
      />
      {unit ? <span className="rb-unit">{unit}</span> : null}
      {extra}
    </label>
  );
}

export default function RubyEditor({ init, bridge }) {
  const t = useStrings(init.strings);
  const doc = init.document || { width: 1000, height: 1000, resolution: 72 };
  const vertical = !!init.vertical;
  const glyphs = init.glyphs || [];
  const ems = init.ems || [];
  const pxToPt = (px) => (px * 72) / (doc.resolution || 72);
  const ptToPx = (pt) => (pt * (doc.resolution || 72)) / 72;

  const [notes, setNotes] = React.useState(() => (init.notes || []).map((note, i) => Object.assign(normalizeNote(note, i), { id: note.id || newId(), lost: !!note.lost })));
  const [activeId, setActiveId] = React.useState(() => (init.notes && init.notes[0] ? init.notes[0].id || null : null));
  const [pickFor, setPickFor] = React.useState(null);
  const [picking, setPicking] = React.useState(null);
  const [notices, setNotices] = React.useState(init.notices || []);
  const [view, setView] = React.useState(init.view || null);
  const [panning, setPanning] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const stageRef = React.useRef(null);
  const svgRef = React.useRef(null);
  const dragRef = React.useRef(null);
  const spaceRef = React.useRef(false);
  const notesRef = React.useRef(notes);
  notesRef.current = notes;
  const textRefs = React.useRef({});
  // Undo: each change pushes the notes as they were; typing in one field
  // (the same tag) within a moment is one step
  const historyRef = React.useRef({ past: [], future: [], tag: null, at: 0 });
  const [, setHistoryTick] = React.useState(0);
  const commit = (fn, tag) => {
    const current = notesRef.current;
    const next = fn(current);
    if (next === current) return;
    const h = historyRef.current;
    const now = Date.now();
    if (!(tag && h.tag === tag && now - h.at < 1500)) {
      h.past.push(current);
      if (h.past.length > UNDO_LIMIT) h.past.shift();
    }
    h.future = [];
    h.tag = tag || null;
    h.at = now;
    notesRef.current = next;
    setNotes(next);
    setHistoryTick((n) => n + 1);
  };
  const stepHistory = (back) => {
    const h = historyRef.current;
    const from = back ? h.past : h.future;
    if (!from.length) return;
    (back ? h.future : h.past).push(notesRef.current);
    const next = from.pop();
    h.tag = null;
    notesRef.current = next;
    setNotes(next);
    setPickFor(null);
    setHistoryTick((n) => n + 1);
  };
  const undo = () => stepHistory(true);
  const redo = () => stepHistory(false);

  /* ------------------------------ layout ----------------------------- */

  // The notes on the base as Apply will leave it (room between lines,
  // spread characters): result.glyphs are the base glyphs moved there
  const result = React.useMemo(() => predictLayout({ glyphs, ems, vertical, notes: notes.filter((note) => !note.lost) }), [notes, glyphs, ems, vertical]);
  const shown = result.glyphs || glyphs;
  const itemById = React.useMemo(() => {
    const map = {};
    result.items.forEach((item) => { map[item.id] = item; });
    return map;
  }, [result]);
  const errorOf = (note) => (note.lost ? "rubyErrLost" : itemById[note.id] && itemById[note.id].error ? ERRORS[itemById[note.id].error] || "rubyErrEmpty" : null);
  const noteOfGlyph = React.useMemo(() => {
    const map = {};
    notes.forEach((note) => {
      if (note.lost) return;
      for (let i = note.start; i < note.end; i++) if (map[i] === undefined) map[i] = note.id;
    });
    return map;
  }, [notes]);

  /* ------------------------------- view ------------------------------ */

  const textBox = React.useMemo(() => {
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    glyphs.forEach((g) => {
      if (!g.box) return;
      left = Math.min(left, g.box.left); top = Math.min(top, g.box.top);
      right = Math.max(right, g.box.right); bottom = Math.max(bottom, g.box.bottom);
    });
    if (left === Infinity) return { left: 0, top: 0, width: doc.width, height: doc.height };
    const pad = (Math.max(...ems.filter((v) => v > 0), 20)) * 1.6;
    return { left: left - pad, top: top - pad, width: right - left + pad * 2, height: bottom - top + pad * 2 };
  }, [glyphs, ems, doc]);

  const fitTo = React.useCallback((box, padding = 30) => {
    const stage = stageRef.current;
    if (!stage || !box) return;
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    const zoom = clamp(Math.min((w - padding * 2) / Math.max(1, box.width), (h - padding * 2) / Math.max(1, box.height)), 0.02, 16);
    setView({ zoom, x: w / 2 - (box.left + box.width / 2) * zoom, y: h / 2 - (box.top + box.height / 2) * zoom });
  }, []);
  const fitPage = () => fitTo({ left: 0, top: 0, width: doc.width, height: doc.height }, 20);
  const fitText = () => fitTo(textBox);

  React.useLayoutEffect(() => {
    if (!view) fitText();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const v = view || { zoom: 1, x: 0, y: 0 };
  const toDoc = (event) => {
    const rect = svgRef.current.getBoundingClientRect();
    return [(event.clientX - rect.left - v.x) / v.zoom, (event.clientY - rect.top - v.y) / v.zoom];
  };

  const wheelRef = React.useRef(null);
  wheelRef.current = (event) => {
    event.preventDefault();
    const rect = svgRef.current.getBoundingClientRect();
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    const factor = Math.exp(-clamp(event.deltaY, -300, 300) / 400);
    const zoom = clamp(v.zoom * factor, 0.02, 32);
    const k = zoom / v.zoom;
    setView({ zoom, x: sx - (sx - v.x) * k, y: sy - (sy - v.y) * k });
  };
  React.useEffect(() => {
    const svg = svgRef.current;
    const listener = (event) => wheelRef.current(event);
    svg.addEventListener("wheel", listener, { passive: false });
    return () => svg.removeEventListener("wheel", listener);
  }, []);

  /* ------------------------------ notes ------------------------------ */

  const update = (id, patch, tag) => commit((list) => list.map((note) => (note.id === id ? Object.assign({}, note, patch) : note)), tag);
  const remove = (id) => {
    commit((list) => list.filter((note) => note.id !== id));
    if (activeId === id) setActiveId(null);
    if (pickFor === id) setPickFor(null);
  };

  const focusNote = (id) => {
    setTimeout(() => {
      const input = textRefs.current[id];
      if (input) input.focus();
    }, 0);
  };

  // A run of characters picked on the page: a new note, or the one being
  // picked again
  const pickSpan = (from, to) => {
    const { start, end } = clampSpan(glyphs, from, to);
    if (!glyphs.slice(start, end).some((g) => g.box)) return;
    const taken = notesRef.current.some((note) => !note.lost && note.id !== pickFor && start < note.end && note.start < end);
    if (taken) {
      setNotices((list) => list.concat(["rubyPickTaken"]));
      return;
    }
    if (pickFor) {
      update(pickFor, { start, end, lost: false });
      setActiveId(pickFor);
      focusNote(pickFor);
      setPickFor(null);
      return;
    }
    const id = newId();
    commit((list) => list.concat([Object.assign(normalizeNote({ start, end, text: "" }), { id, lost: false })]));
    setActiveId(id);
    focusNote(id);
  };

  /* ----------------------------- pointer ----------------------------- */

  const glyphAt = (p) => {
    // The nearest character box (within half an em of it)
    let best = null;
    let bestDistance = Infinity;
    shown.forEach((g) => {
      if (!g.box) return;
      const dx = Math.max(g.box.left - p[0], 0, p[0] - g.box.right);
      const dy = Math.max(g.box.top - p[1], 0, p[1] - g.box.bottom);
      const d = Math.hypot(dx, dy);
      const limit = (ems[g.index] || 40) * 0.5;
      if (d <= limit && d < bestDistance) {
        best = g;
        bestDistance = d;
      }
    });
    return best;
  };

  const onPointerDown = (event) => {
    if (event.button === 2 || event.button === 1 || spaceRef.current) {
      dragRef.current = { kind: "pan", screen: [event.clientX, event.clientY], view: v };
      setPanning(true);
    } else {
      const g = glyphAt(toDoc(event));
      if (!g) return;
      const owner = noteOfGlyph[g.index];
      dragRef.current = { kind: "pick", from: g.index, to: g.index, owner, moved: false };
      setPicking({ from: g.index, to: g.index });
    }
    try {
      svgRef.current.setPointerCapture(event.pointerId);
    } catch (error) {}
  };

  const onPointerMove = (event) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.kind === "pan") {
      setView({ zoom: drag.view.zoom, x: drag.view.x + event.clientX - drag.screen[0], y: drag.view.y + event.clientY - drag.screen[1] });
      return;
    }
    const g = glyphAt(toDoc(event));
    if (g && g.index !== drag.to) {
      drag.to = g.index;
      drag.moved = true;
      const span = clampSpan(glyphs, drag.from, drag.to);
      setPicking({ from: span.start, to: span.end - 1 });
    }
  };

  const onPointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    setPanning(false);
    setPicking(null);
    if (!drag || drag.kind !== "pick") return;
    // A click on a character that has a note: that note
    if (!drag.moved && drag.owner && !pickFor) {
      setActiveId(drag.owner);
      return;
    }
    pickSpan(drag.from, drag.to);
  };

  /* ------------------------------ apply ------------------------------ */

  const hasErrors = notes.some((note) => errorOf(note));
  const apply = () => {
    if (busy) return;
    if (hasErrors) {
      setNotices((list) => list.concat(["rubyFixFirst"]));
      return;
    }
    setBusy(true);
    bridge.apply({ notes: notes.map((note) => normalizeNote(note)).map((note, i) => Object.assign(note, { id: notes[i].id })), view });
  };
  const applyRef = React.useRef(apply);
  applyRef.current = apply;

  React.useEffect(() => {
    const onKeyDown = (event) => {
      const typing = /^(input|textarea|select)$/i.test((event.target && event.target.tagName) || "");
      if (event.key === " " && !typing) {
        spaceRef.current = true;
        event.preventDefault();
      } else if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.key === "z" || event.key === "Z")) {
        // Ours, in the text fields too: one history for the whole window
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if ((event.ctrlKey || event.metaKey) && (event.key === "y" || event.key === "Y")) {
        event.preventDefault();
        redo();
      } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        applyRef.current();
      } else if ((event.key === "Delete" || event.key === "Backspace") && !typing && activeId) {
        event.preventDefault();
        remove(activeId);
      } else if (event.key === "Escape" && pickFor) {
        setPickFor(null);
      }
    };
    const onKeyUp = (event) => {
      if (event.key === " ") spaceRef.current = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  });

  // Development builds: the live check drives the window (scripts/rubyLiveCheck.js)
  if (process.env.TYPER_DEV === "1") {
    window.__rubyDev = {
      state: () => ({ notes: notesRef.current, items: result.items.map((item) => ({ id: item.id, error: item.error, rect: item.rect || null })), collisions: Array.from(result.collisions) }),
      setNotes: (list) => { commit(() => list.map((note, i) => Object.assign(normalizeNote(note, i), { id: note.id || newId(), lost: !!note.lost }))); return true; },
      undo: () => { undo(); return true; },
      redo: () => { redo(); return true; },
      pick: (from, to) => { pickSpan(from, to); return true; },
      apply: () => { applyRef.current(); return true; },
      cancel: () => { bridge.cancel(); return true; },
    };
  }

  /* ------------------------------ render ----------------------------- */

  const look = init.look || { stroke: null, opacity: 1 };
  const stroke = look.stroke;
  const fontFamily = [init.font && init.font.name, init.font && init.font.postScriptName].filter(Boolean).map((name) => "\"" + name + "\"").concat(["sans-serif"]).join(", ");
  const color = toHex(init.font && init.font.color);
  const pickRange = picking ? { from: Math.min(picking.from, picking.to), to: Math.max(picking.from, picking.to) } : null;
  const spanText = (note) => glyphs.slice(note.start, note.end).map((g) => g.ch).join("");

  const noticeText = (notice) => {
    const key = typeof notice === "string" ? notice : notice.key;
    const text = t(key);
    return notice && notice.detail ? text + " (" + notice.detail + ")" : text;
  };

  const drawNote = (item) => {
    const { rect, plan, note } = item;
    const active = note.id === activeId;
    const collide = result.collisions.has(note.id);
    const letterSpacing = (plan.tracking / 1000) * plan.size;
    const cx = vertical ? rect.cross : rect.main0;
    const cy = vertical ? rect.main0 : rect.cross;
    const squeeze = plan.scale !== 1 ? (vertical ? "translate(0 " + cy + ") scale(1 " + plan.scale + ") translate(0 " + -cy + ")" : "translate(" + cx + " 0) scale(" + plan.scale + " 1) translate(" + -cx + " 0)") : undefined;
    const box = rect.box;
    return (
      <g key={note.id}>
        <text
          className="rb-note-text"
          x={cx} y={cy}
          transform={squeeze}
          fill={color}
          stroke={stroke ? toHex(stroke.color) : undefined}
          strokeOpacity={stroke ? stroke.opacity : undefined}
          strokeWidth={stroke ? stroke.size * (stroke.outer ? 2 : 1) : undefined}
          strokeLinejoin="round"
          paintOrder="stroke"
          fontFamily={fontFamily}
          fontSize={plan.size}
          letterSpacing={letterSpacing}
          dominantBaseline="central"
          style={vertical ? { writingMode: "vertical-rl", textOrientation: "mixed" } : undefined}
        >{note.text}</text>
        <rect className={"rb-note-box" + (active ? " is-active" : "") + (collide ? " is-collision" : "")} x={box.left} y={box.top} width={box.right - box.left} height={box.bottom - box.top} />
        <rect className="rb-note-hit" x={box.left} y={box.top} width={box.right - box.left} height={box.bottom - box.top}
          onPointerDown={(event) => { event.stopPropagation(); setActiveId(note.id); focusNote(note.id); }} />
      </g>
    );
  };

  const alignOptions = [["center", t("rubyAlignCenter")], ["start", t(vertical ? "rubyAlignStartV" : "rubyAlignStartH")], ["spread", t("rubyAlignSpread")]];

  return (
    <div className={"rb-editor" + (panning ? " is-panning" : "")}>
      <div className="rb-stage">
        <div className="rb-canvas-wrap" ref={stageRef}>
          <svg
            ref={svgRef}
            className="rb-canvas"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onContextMenu={(event) => event.preventDefault()}
          >
            <g transform={"translate(" + v.x + " " + v.y + ") scale(" + v.zoom + ")"}>
              <rect x="0" y="0" width={doc.width} height={doc.height} className="rb-page" />
              {init.preview ? <image href={init.preview.src} x="0" y="0" width={doc.width} height={doc.height} preserveAspectRatio="none" /> : null}
              <g className="rb-base" opacity={look.opacity}>
                {shown.map((g) => (g.path ? (
                  <path
                    key={"base" + g.index} d={g.path} fillRule="nonzero"
                    transform={g.shift && (g.shift.dx || g.shift.dy) ? "translate(" + g.shift.dx + " " + g.shift.dy + ")" : undefined}
                    fill={toHex(g.color || (init.font && init.font.color))}
                    stroke={stroke ? toHex(stroke.color) : undefined}
                    strokeOpacity={stroke ? stroke.opacity : undefined}
                    strokeWidth={stroke ? stroke.size * (stroke.outer ? 2 : 1) : undefined}
                    strokeLinejoin="round"
                    paintOrder="stroke"
                  />
                ) : null))}
              </g>
              {shown.map((g) => {
                if (!g.box) return null;
                const owner = noteOfGlyph[g.index];
                const inPick = pickRange && g.index >= pickRange.from && g.index <= pickRange.to;
                const cls = "rb-glyph" + (inPick ? " is-picking" : owner ? (owner === activeId ? " is-active" : " is-noted") : "");
                return <rect key={g.index} className={cls} x={g.box.left} y={g.box.top} width={g.box.right - g.box.left} height={g.box.bottom - g.box.top} />;
              })}
              {result.items.filter((item) => !item.error).map(drawNote)}
            </g>
          </svg>
          {notices.length ? (
            <div className="rb-notices">
              {notices.map((notice, i) => (
                <div key={i} className="rb-notice" onClick={() => setNotices((list) => list.filter((n, j) => j !== i))}>
                  <span>{noticeText(notice)}</span>
                  <span>×</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <div className="rb-viewbar">
          <button type="button" onClick={undo} disabled={!historyRef.current.past.length} title="Ctrl+Z">{t("rubyUndo")}</button>
          <button type="button" onClick={redo} disabled={!historyRef.current.future.length} title="Ctrl+Shift+Z">{t("rubyRedo")}</button>
          <span className="rb-sep" />
          <button type="button" onClick={fitPage}>{t("rubyFitPage")}</button>
          <button type="button" onClick={fitText}>{t("rubyFitText")}</button>
          <span className="rb-zoom">{Math.round(v.zoom * 100)}%</span>
          <span className="rb-help">{t("rubyHelp")}</span>
        </div>
      </div>

      <aside className="rb-side">
        <div className="rb-side-scroll">
          <div className="rb-head">
            <div className="rb-mode">{t(init.mode === "update" ? "rubyModeUpdate" : "rubyModeNew")}</div>
            {init.baseName ? <div className="rb-meta">{t("rubyBase").replace("{name}", init.baseName)}</div> : null}
            {init.font && init.font.name ? <div className="rb-meta">{t("rubyFont").replace("{font}", init.font.name + (init.font.style ? " " + init.font.style : ""))}</div> : null}
          </div>
          <div className={"rb-hint" + (pickFor ? " is-picking" : "")}>{t(pickFor ? "rubyHintPick" : "rubyHint")}</div>
          {!notes.length ? <div className="rb-meta">{t("rubyNoNotes")}</div> : null}
          {notes.map((note, i) => {
            const item = itemById[note.id];
            const error = errorOf(note);
            const plan = item && item.plan;
            const autoSize = plan && note.size === null ? round(pxToPt(plan.size), 1) : null;
            const roomy = item && item.span && result.room.some((entry) => entry.line === item.span.line);
            const warn = !error && plan ? (result.collisions.has(note.id) ? "rubyWarnCollision" : roomy ? "rubyWarnLeading" : plan.baseExtra > 0 ? "rubyWarnSpread" : plan.overhang ? "rubyWarnOverhang" : null) : null;
            return (
              <div key={note.id} className={"rb-note" + (note.id === activeId ? " is-active" : "") + (error ? " has-error" : "")} onMouseDown={() => setActiveId(note.id)}>
                <div className="rb-note-head">
                  <span className="rb-note-number">{i + 1}.</span>
                  <span className="rb-note-span">{note.lost ? "—" : "「" + spanText(note) + "」"}</span>
                </div>
                {error ? <div className="rb-note-error">{t(error)}</div> : null}
                {warn ? <div className="rb-note-warn">{t(warn)}</div> : null}
                <label className="rb-field">
                  <span className="rb-field-label">{t("rubyNoteText")}</span>
                  <input type="text" ref={(el) => { textRefs.current[note.id] = el; }} value={note.text} onChange={(event) => update(note.id, { text: event.target.value }, "text:" + note.id)} />
                </label>
                <div className="rb-field">
                  <span className="rb-field-label">{t("rubyAlign")}</span>
                  <Segmented value={note.align} options={alignOptions} onChange={(align) => update(note.id, { align })} />
                </div>
                <label className="rb-field">
                  <span className="rb-field-label">{t("rubyOverflow")}</span>
                  <select value={note.overflow} onChange={(event) => update(note.id, { overflow: event.target.value })}>
                    <option value="shrink">{t("rubyOverflowShrink")}</option>
                    <option value="squeeze">{t("rubyOverflowSqueeze")}</option>
                    <option value="overhang">{t("rubyOverflowOverhang")}</option>
                    <option value="spread">{t("rubyOverflowSpread")}</option>
                  </select>
                </label>
                <NumberField
                  label={t("rubySize")} unit="pt" step={0.5} min={0.5}
                  value={note.size === null ? null : round(pxToPt(note.size), 2)}
                  placeholder={autoSize !== null ? t("rubySizeAuto") + " " + autoSize : t("rubySizeAuto")}
                  onChange={(pt) => update(note.id, { size: pt === null || pt <= 0 ? null : ptToPx(pt) }, "size:" + note.id)}
                  extra={note.size !== null ? <button type="button" className="rb-link" onClick={() => update(note.id, { size: null })}>{t("rubySizeReset")}</button> : null}
                />
                {note.size === null ? (
                  <NumberField label={t("rubyRatio")} unit="%" step={5} min={LIMITS.ratio[0] * 100} max={LIMITS.ratio[1] * 100}
                    value={round(note.ratio * 100, 1)}
                    onChange={(value) => update(note.id, { ratio: value === null ? DEFAULTS.ratio : clamp(value / 100, LIMITS.ratio[0], LIMITS.ratio[1]) }, "ratio:" + note.id)} />
                ) : null}
                <NumberField label={t("rubyGap")} unit="%" step={5} min={LIMITS.gap[0] * 100} max={LIMITS.gap[1] * 100}
                  value={round(note.gap * 100, 1)}
                  onChange={(value) => update(note.id, { gap: value === null ? 0 : clamp(value / 100, LIMITS.gap[0], LIMITS.gap[1]) }, "gap:" + note.id)} />
                <div className="rb-note-actions">
                  <button type="button" onClick={() => { setPickFor(pickFor === note.id ? null : note.id); setActiveId(note.id); }}>{t("rubyRepick")}</button>
                  <button type="button" onClick={() => remove(note.id)}>{t("rubyDelete")}</button>
                </div>
              </div>
            );
          })}
        </div>
        <div className="rb-actions">
          <button type="button" onClick={() => bridge.cancel()} disabled={busy}>{t("rubyCancel")}</button>
          <button type="button" className="is-primary" onClick={apply} disabled={busy} title="Ctrl+Enter">{t("rubyApply")}</button>
        </div>
      </aside>
    </div>
  );
}
