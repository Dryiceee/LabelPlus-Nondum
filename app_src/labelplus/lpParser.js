// LabelPlus text files. Pure: nothing here reads Photoshop or the disk.
//
//   1,0                                      version
//   -
//   框内                                     groups, one per line
//   框外
//   -
//   comment
//
//   >>>>>>>>[001.jpg]<<<<<<<<                image
//   ----------------[1]----------------[0.5,0.25,1]    label: x, y, group
//   translated text, may span lines
//
// x and y are fractions of the page. The group is 1-based. Marker lengths
// vary between tools, so six or more characters count, like the PS script.
// Problems that do not stop the import are returned in `warnings`.

const IMAGE_MARKER = /^>{6,}\[(.*)\]<{6,}$/;
const LABEL_MARKER = /^-{6,}\[(\d+)\]-{6,}\[([^\]]*)\]$/;
const SUPPORTED_MAJOR_VERSION = 1;

class LpParseError extends Error {
  constructor(code, line) {
    super("LabelPlus text: " + code + (line ? " (line " + line + ")" : ""));
    this.name = "LpParseError";
    this.code = code;
    this.line = line || 0;
  }
}

const splitLines = (text) => String(text == null ? "" : text).replace(/^﻿/, "").split(/\r\n|\r|\n/);

// The blocks are separated by lines holding a single "-". LabelPlus splits on
// every "-", which cuts group names and comments holding one: a line-based
// split keeps them.
function parseHeader(lines) {
  const separators = [];
  lines.forEach((line, index) => {
    if (line.trim() === "-") separators.push(index);
  });
  if (separators.length < 2) throw new LpParseError("header");
  const version = lines.slice(0, separators[0]).join("").split(",").map((part) => parseInt(part, 10));
  const groups = lines.slice(separators[0] + 1, separators[1]).map((line) => line.trim()).filter(Boolean);
  const comment = lines.slice(separators[1] + 1).join("\n").trim();
  return { version, groups, comment };
}

const cleanText = (lines) => lines.map((line) => line.trim()).join("\n").trim();

function parseLabel(match, line, image, groups, warn) {
  const parts = match[2].split(",");
  const values = parts.map((part) => parseFloat(part));
  const index = parseInt(match[1], 10);
  let x = values[0];
  let y = values[1];
  if (!isFinite(x) || !isFinite(y)) {
    warn("badPosition", line, { image: image.name, index });
    x = isFinite(x) ? x : 0.5;
    y = isFinite(y) ? y : 0.5;
  } else if (x < 0 || x > 1 || y < 0 || y > 1) {
    warn("positionOffPage", line, { image: image.name, index });
  }
  const groupNumber = values[2];
  const hasGroup = Number.isInteger(groupNumber) && groupNumber >= 1 && groupNumber <= groups.length;
  if (!hasGroup) warn("unknownGroup", line, { image: image.name, index, group: parts[2] });
  return {
    index,
    line,
    x: Math.min(1, Math.max(0, x)),
    y: Math.min(1, Math.max(0, y)),
    groupIndex: hasGroup ? groupNumber - 1 : -1,
    group: hasGroup ? groups[groupNumber - 1] : "",
    text: "",
  };
}

function parseLpText(text) {
  const lines = splitLines(text);
  const warnings = [];
  const warn = (code, line, details) => warnings.push(Object.assign({ code, line }, details));

  const firstImage = lines.findIndex((line) => IMAGE_MARKER.test(line.trim()));
  if (firstImage < 0) throw new LpParseError("noImages");
  const header = parseHeader(lines.slice(0, firstImage));
  if (header.version[0] > SUPPORTED_MAJOR_VERSION) warn("version", 1, { version: header.version.join(",") });
  if (!header.groups.length) warn("noGroups", 1);

  const images = [];
  const byName = new Map();
  let image = null;
  let label = null;
  let pending = [];

  const flush = () => {
    if (label) {
      label.text = cleanText(pending);
      if (!label.text) warn("emptyLabel", label.line, { image: image.name, index: label.index });
    } else if (image && cleanText(pending)) {
      warn("orphanText", image.line, { image: image.name });
    }
    pending = [];
  };

  for (let i = firstImage; i < lines.length; i++) {
    const line = lines[i].trim();
    const lineNumber = i + 1;
    const imageMatch = IMAGE_MARKER.exec(line);
    if (imageMatch) {
      flush();
      label = null;
      const name = imageMatch[1].trim();
      if (byName.has(name)) {
        warn("duplicateImage", lineNumber, { image: name });
        image = byName.get(name);
      } else {
        image = { name, line: lineNumber, labels: [] };
        byName.set(name, image);
        images.push(image);
      }
      continue;
    }
    const labelMatch = LABEL_MARKER.exec(line);
    if (labelMatch) {
      flush();
      label = parseLabel(labelMatch, lineNumber, image, header.groups, warn);
      image.labels.push(label);
      continue;
    }
    pending.push(lines[i]);
  }
  flush();

  return { version: header.version, groups: header.groups, comment: header.comment, images, warnings };
}

// "A->B|C->D". Null when an entry is malformed, an empty string gives no rule.
function parseTextReplace(expression) {
  const rules = [];
  const entries = String(expression == null ? "" : expression).split("|");
  for (let i = 0; i < entries.length; i++) {
    if (entries[i] === "") continue;
    const parts = entries[i].split("->");
    if (parts.length !== 2 || parts[0] === "") return null;
    rules.push({ from: parts[0], to: parts[1] });
  }
  return rules;
}

// One pass per rule: the PS script loops until `from` is gone, which never
// ends on a rule like "A->AA".
const applyTextReplace = (text, rules) => (rules || []).reduce((out, rule) => out.split(rule.from).join(rule.to), text);

export { LpParseError, parseLpText, parseTextReplace, applyTextReplace };
