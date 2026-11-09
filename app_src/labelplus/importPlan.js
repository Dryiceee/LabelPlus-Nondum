// From a parsed LabelPlus file to the pages to build: which image opens, which
// PSD comes out, which labels go in. Pure: the host does the Photoshop part.

import { applyTextReplace } from "./lpParser";

const IMAGE_EXTENSIONS = [".psd", ".png", ".jpg", ".jpeg", ".tif", ".tiff"];
// Folders LabelPlus users keep the raw pages in, next to the text file
const IMAGE_FOLDER_NAMES = ["images", "image", "imgs", "img", "source", "src", "raw", "图源", "原图"];
const OUTPUT_FOLDER_NAME = "psd";

const stemOf = (name) => {
  const dot = String(name).lastIndexOf(".");
  return dot > 0 ? String(name).slice(0, dot) : String(name);
};
const extensionOf = (name) => {
  const dot = String(name).lastIndexOf(".");
  return dot > 0 ? String(name).slice(dot).toLowerCase() : "";
};
const isImageFile = (name) => IMAGE_EXTENSIONS.indexOf(extensionOf(name)) >= 0;

// "2.jpg" before "10.jpg", as a person reads a chapter
const compareNames = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });

// The folder holding the pages: a known name first, then the text file's own
// folder when it holds images, then the only subfolder that has images.
// `folders` = [{ name, images: count }]. Null when nothing fits.
function detectImageFolder(folders, ownImageCount) {
  const withImages = (folders || []).filter((folder) => folder.images > 0);
  for (let i = 0; i < IMAGE_FOLDER_NAMES.length; i++) {
    const known = withImages.find((folder) => folder.name.toLowerCase() === IMAGE_FOLDER_NAMES[i]);
    if (known) return known.name;
  }
  if (ownImageCount > 0) return "";
  return withImages.length === 1 ? withImages[0].name : null;
}

// Pairs each image of the text with a file of the folder. Exact name first,
// then the same stem with another image extension. `replaceExtension` forces
// the extension; `byOrder` pairs the sorted lists instead, for pages renamed
// after the translation. A missing page gets file: "".
function matchImages(imageNames, files, options = {}) {
  const pages = (files || []).filter(isImageFile).sort(compareNames);
  const exact = new Map(pages.map((name) => [name.toLowerCase(), name]));
  const byStem = new Map();
  pages.forEach((name) => {
    const stem = stemOf(name).toLowerCase();
    const known = byStem.get(stem);
    const rank = (candidate) => IMAGE_EXTENSIONS.indexOf(extensionOf(candidate));
    if (!known || rank(name) < rank(known)) byStem.set(stem, name);
  });
  const extension = options.replaceExtension
    ? "." + String(options.replaceExtension).replace(/^\./, "").toLowerCase()
    : "";
  return imageNames.map((image, index) => {
    let file = "";
    if (options.byOrder) file = pages[index] || "";
    else if (extension) file = exact.get((stemOf(image) + extension).toLowerCase()) || "";
    else file = exact.get(String(image).toLowerCase()) || byStem.get(stemOf(image).toLowerCase()) || "";
    return { image, file };
  });
}

// A group with no rule yet: the first group (框内 by default, whatever it is
// called) is centred on its bubble, the others stay on their label point.
// Whitening is off until the user asks for it.
function defaultGroupRules(groups) {
  const rules = {};
  (groups || []).forEach((group, index) => {
    rules[group] = { styleId: null, center: index === 0, clean: false };
  });
  return rules;
}

// Saved rules survive a chapter whose groups changed: known names keep theirs,
// new ones get the default, and names gone from the file are kept for later.
function mergeGroupRules(groups, saved) {
  return Object.assign({}, saved || {}, defaultGroupRules(groups), pickKnown(groups, saved));
}
function pickKnown(groups, saved) {
  const known = {};
  (groups || []).forEach((group) => {
    if (saved && saved[group]) known[group] = saved[group];
  });
  return known;
}

// Two pages may not write the same PSD ("1.jpg" and "1.png")
function outputNameOf(file) {
  return stemOf(file) + ".psd";
}

// options: { selectedImages, selectedGroups, skipEmpty, rules: [{from,to}],
// matches: [{image,file}] }. Returns { pages, skipped, issues }.
function buildImportPlan(lp, options = {}) {
  const matches = new Map((options.matches || []).map((match) => [match.image, match.file]));
  const selectedImages = options.selectedImages ? new Set(options.selectedImages) : null;
  const selectedGroups = options.selectedGroups ? new Set(options.selectedGroups) : null;
  const pages = [];
  const skipped = [];
  const issues = [];
  const outputs = new Map();

  lp.images.forEach((image) => {
    if (selectedImages && !selectedImages.has(image.name)) return;
    const labels = image.labels
      .filter((label) => !selectedGroups || selectedGroups.has(label.group))
      .map((label) => Object.assign({}, label, { text: applyTextReplace(label.text, options.rules) }))
      .filter((label) => {
        if (label.text) return true;
        issues.push({ code: "emptyLabel", image: image.name, index: label.index });
        return false;
      });
    if (!labels.length && options.skipEmpty !== false) {
      skipped.push(image.name);
      return;
    }
    const file = matches.get(image.name) || "";
    if (!file) {
      issues.push({ code: "imageMissing", image: image.name });
      return;
    }
    const output = outputNameOf(file);
    if (outputs.has(output.toLowerCase())) {
      issues.push({ code: "outputCollision", image: image.name, output, other: outputs.get(output.toLowerCase()) });
      return;
    }
    outputs.set(output.toLowerCase(), image.name);
    pages.push({ image: image.name, file, output, labels });
  });
  return { pages, skipped, issues };
}

// How far to move a new text so that it sits on its label point. The start of
// the text goes on the point: the top of the first column in vertical text
// (the rightmost one), the start of the first line in horizontal text.
function labelPointOffset(box, point, orientation, fontPixels) {
  const half = (fontPixels > 0 ? fontPixels : 0) / 2;
  if (orientation === "vertical") {
    return { x: point.x - (box.right - half), y: point.y - box.top };
  }
  return { x: point.x - box.left, y: point.y - (box.top + half) };
}

export {
  IMAGE_EXTENSIONS,
  OUTPUT_FOLDER_NAME,
  isImageFile,
  compareNames,
  detectImageFolder,
  matchImages,
  defaultGroupRules,
  mergeGroupRules,
  outputNameOf,
  buildImportPlan,
  labelPointOffset,
};
