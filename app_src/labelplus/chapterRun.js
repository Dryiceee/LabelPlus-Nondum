// Runs a whole chapter, one host call per page, so the panel can show progress
// and stop between pages. A page that fails never stops the chapter: everything
// that needs a look ends up in one checklist. The host is injected, so all of
// this runs in tests without Photoshop.
//
// The import leaves a sidecar next to the PSDs: the label point and the group
// of each layer. Centring needs the label point, and a layer's own position can
// no longer tell it once the layer has been moved or restyled.

const SIDECAR_NAME = "labelplus-nondum.json";
// Written by the test builds, read when the folder has nothing newer
const OLD_SIDECAR_NAME = "labelplus-next.json";
const SIDECAR_VERSION = 1;

const joinPath = (folder, name) => {
  const base = String(folder || "");
  const separator = base.indexOf("\\") >= 0 ? "\\" : "/";
  return base.replace(/[\\/]+$/, "") + separator + name;
};

const dirnameOf = (path) => {
  const value = String(path || "");
  const at = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  return at > 0 ? value.slice(0, at) : "";
};

const styleOf = (rule, styles) => {
  if (!rule || !rule.styleId) return null;
  return (styles || []).find((style) => style.id === rule.styleId) || null;
};

const fontOf = (style) => {
  const range = style && style.textProps && style.textProps.layerText && style.textProps.layerText.textStyleRange;
  return range && range[0] && range[0].textStyle ? range[0].textStyle.fontPostScriptName : "";
};

// Group-level problems, reported once rather than on every layer
function groupIssues(groups, rules, styles, installedFonts) {
  const issues = [];
  (groups || []).forEach((group) => {
    const rule = rules && rules[group];
    const style = styleOf(rule, styles);
    if (!style) {
      issues.push({ page: "", code: rule && rule.styleId ? "styleGone" : "noStyle", group });
      return;
    }
    const font = fontOf(style);
    if (font && installedFonts && !installedFonts.has(font)) issues.push({ page: "", code: "missingFont", group, font });
  });
  return issues;
}

const pageIssues = (page, issues) => (issues || []).map((issue) => Object.assign({ page }, issue));

async function saveSidecar(host, folder, sidecar) {
  const saved = await host.call("lpWriteText", joinPath(folder, SIDECAR_NAME), JSON.stringify(sidecar, null, 1));
  return saved && saved.ok ? [] : [{ page: "", code: "sidecarWrite", message: saved && saved.message }];
}

function parseSidecar(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && parsed.version === SIDECAR_VERSION && parsed.pages ? parsed : null;
  } catch (error) {
    return null;
  }
}

async function readSidecar(host, folder) {
  for (const name of [SIDECAR_NAME, OLD_SIDECAR_NAME]) {
    const read = await host.call("lpReadText", joinPath(folder, name));
    if (read && read.ok) return parseSidecar(read.text);
  }
  return null;
}

// options: { plan, groups, sourceFolder, outputFolder, rules, styles,
// orientation, textFile, previous, center, host, onProgress, isCancelled }.
// With center (the processing run), the groups whose rule says so are centred
// and whitened as each page is built.
// `previous` is the sidecar already in the folder: other pages stay in it.
async function runImport(options) {
  const { plan, groups, sourceFolder, outputFolder, rules, styles, orientation, host } = options;
  const checklist = [];
  const sidecar = {
    version: SIDECAR_VERSION,
    textFile: options.textFile || "",
    groups,
    pages: Object.assign({}, options.previous && options.previous.pages),
  };
  const built = [];
  const stats = { total: 0, wanted: 0, centred: 0, cleaned: 0, trace: [] };
  let done = 0;
  let cancelled = false;
  for (let i = 0; i < plan.pages.length; i++) {
    if (options.isCancelled && options.isCancelled()) {
      cancelled = true;
      break;
    }
    const page = plan.pages[i];
    if (options.onProgress) options.onProgress({ current: i + 1, total: plan.pages.length, name: page.output });
    const labels = page.labels.map((label) => ({
      index: label.index,
      x: label.x,
      y: label.y,
      group: label.group,
      text: label.text,
      style: styleOf(rules && rules[label.group], styles),
      center: !!(options.center && rules && rules[label.group] && rules[label.group].center),
      clean: !!(options.center && rules && rules[label.group] && rules[label.group].clean),
    }));
    const result = await host.call("lpImportPage", {
      source: joinPath(sourceFolder, page.file),
      output: joinPath(outputFolder, page.output),
      orientation,
      groups,
      labels,
    });
    if (!result || !result.ok) {
      checklist.push({ page: page.output, code: (result && result.code) || "import", message: result && result.message });
      continue;
    }
    done++;
    built.push(page.output);
    stats.total += (result.layers || []).length;
    stats.wanted += result.wanted || 0;
    stats.centred += result.centred || 0;
    stats.cleaned += result.cleaned || 0;
    (result.trace || []).forEach((line) => stats.trace.push(page.output + " " + line));
    checklist.push(...pageIssues(page.output, result.issues));
    sidecar.pages[page.output] = { image: page.image, layers: result.layers };
    // After each page: stopping or crashing keeps what was built
    checklist.push(...(await saveSidecar(host, outputFolder, sidecar)));
  }
  return { done, total: plan.pages.length, cancelled, checklist, sidecar, built, stats };
}

const processPayload = (sidecarPage, rules, styles, flags) => {
  const hostRules = {};
  Object.keys(rules || {}).forEach((group) => {
    hostRules[group] = { center: !!rules[group].center, clean: !!rules[group].clean, style: styleOf(rules[group], styles) };
  });
  return {
    rules: hostRules,
    labels: sidecarPage ? sidecarPage.layers : [],
    applyStyle: !!flags.applyStyle,
    center: !!flags.center,
  };
};

// options: { folder, psdFiles, sidecar, rules, styles, applyStyle, center,
// host, onProgress, isCancelled }
async function runProcess(options) {
  const { folder, psdFiles, sidecar, rules, styles, host } = options;
  const checklist = [];
  let done = 0;
  let cancelled = false;
  const pages = (sidecar && sidecar.pages) || {};
  const stats = { total: 0, wanted: 0, centred: 0, cleaned: 0, trace: [] };
  for (let i = 0; i < psdFiles.length; i++) {
    if (options.isCancelled && options.isCancelled()) {
      cancelled = true;
      break;
    }
    const name = psdFiles[i];
    if (options.onProgress) options.onProgress({ current: i + 1, total: psdFiles.length, name });
    const page = pages[name];
    if (!page) checklist.push({ page: name, code: "noLabelData" });
    const result = await host.call("lpProcessPage", Object.assign({ path: joinPath(folder, name) }, processPayload(page, rules, styles, options)));
    if (!result || !result.ok) {
      checklist.push({ page: name, code: (result && result.code) || "process", message: result && result.message });
      continue;
    }
    done++;
    stats.total += result.total || 0;
    stats.wanted += result.wanted || 0;
    stats.centred += result.centred || 0;
    stats.cleaned += result.cleaned || 0;
    (result.trace || []).forEach((line) => stats.trace.push(name + " " + line));
    checklist.push(...pageIssues(name, result.issues));
  }
  return { done, total: psdFiles.length, cancelled, checklist, stats };
}

export {
  SIDECAR_NAME,
  joinPath,
  dirnameOf,
  styleOf,
  groupIssues,
  parseSidecar,
  readSidecar,
  runImport,
  runProcess,
  processPayload,
};
