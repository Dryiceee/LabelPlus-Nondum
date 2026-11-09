// Choices of the LabelPlus window that are plain logic: the list of pages and
// the text replacements. Pure.

import { parseTextReplace } from "./lpParser";

// Longest first: "！？" must be replaced before "？" and "！" alone
const DEFAULT_REPLACEMENTS = [
  { from: "！？", to: "!?", enabled: true },
  { from: "...", to: "…", enabled: true },
  { from: "？", to: "?", enabled: true },
  { from: "！", to: "!", enabled: true },
];

const sameRule = (a, b) => a.from === b.from && a.to === b.to;

// New rules become options, switched on; a rule already there is switched on.
// Null when the text is malformed.
function addReplacements(options, text) {
  const rules = parseTextReplace(text);
  if (!rules) return null;
  const next = options.map((option) => Object.assign({}, option));
  rules.forEach((rule) => {
    const known = next.find((option) => sameRule(option, rule));
    if (known) known.enabled = true;
    else next.push({ from: rule.from, to: rule.to, enabled: true });
  });
  return next;
}

// Brings back the built-in options that were deleted, in their place at the top
// so that "！？" still runs before "？". What the user added or unticked stays.
function restoreDefaultReplacements(options) {
  const defaults = DEFAULT_REPLACEMENTS.map((builtIn) => Object.assign({}, options.find((option) => sameRule(option, builtIn)) || builtIn));
  return defaults.concat(options.filter((option) => !DEFAULT_REPLACEMENTS.some((builtIn) => sameRule(option, builtIn))));
}

const activeReplacements = (options) => options.filter((option) => option.enabled).map(({ from, to }) => ({ from, to }));

// A click in the list, as in a file list: alone it selects one row, Ctrl adds or
// removes a row, Shift selects from the last clicked row. Ctrl+Shift adds the
// range. Returns { selected, anchor }, the rows in list order.
function clickRow(names, selected, anchor, name, keys = {}) {
  const chosen = new Set(selected);
  let nextAnchor = name;
  if (keys.shift) {
    const from = names.indexOf(anchor);
    const to = names.indexOf(name);
    const start = from < 0 ? to : Math.min(from, to);
    const end = from < 0 ? to : Math.max(from, to);
    if (!keys.ctrl) chosen.clear();
    for (let i = start; i <= end; i++) chosen.add(names[i]);
    nextAnchor = from < 0 ? name : anchor;
  } else if (keys.ctrl) {
    if (chosen.has(name)) chosen.delete(name);
    else chosen.add(name);
  } else {
    chosen.clear();
    chosen.add(name);
  }
  return { selected: names.filter((item) => chosen.has(item)), anchor: nextAnchor };
}

export { DEFAULT_REPLACEMENTS, addReplacements, restoreDefaultReplacements, activeReplacements, clickRow };
