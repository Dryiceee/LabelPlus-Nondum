// Page bar of the main panel: the rules, without Photoshop. A project is a
// folder of PSDs; a page turn saves the page left behind and keeps it open, so
// its history stays. Past a limit, the page looked at longest ago is closed.

const RECENT_LIMIT = 10;
const DEFAULT_MAX_OPEN = 20;
const MIN_MAX_OPEN = 6;
const MAX_MAX_OPEN = 99;
// The reminder comes this many pages before the limit
const REMIND_BEFORE = 5;

const compareNames = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });

const isPsd = (name) => /\.psd$/i.test(String(name || ""));

// The pages of a folder listing: its PSDs, in natural order (2 before 10)
const projectPages = (entries) => (entries || [])
  .filter((entry) => entry && !entry.isFolder && isPsd(entry.name))
  .map((entry) => entry.name)
  .sort(compareNames);

const folderName = (path) => {
  const parts = String(path || "").replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || String(path || "");
};

// The name a project goes by: the folder holding the chosen one (the chapter
// around its PSD folder), or the chosen folder itself right under a drive
const projectName = (folder) => {
  const parts = String(folder || "").replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
  const last = parts[parts.length - 1] || String(folder || "");
  const parent = parts.length > 1 ? parts[parts.length - 2] : "";
  return parent && !/:$/.test(parent) ? parent : last;
};

const baseName = (path) => folderName(path);

const joinPath = (folder, name) => {
  const base = String(folder || "");
  const separator = base.indexOf("\\") >= 0 ? "\\" : "/";
  return base.replace(/[\\/]+$/, "") + separator + name;
};

// Windows paths compare without case and with either slash
const samePath = (a, b) => String(a || "").replace(/\//g, "\\").toLowerCase() === String(b || "").replace(/\//g, "\\").toLowerCase();

const normalizeMaxOpen = (value) => {
  const number = parseInt(value, 10);
  if (!Number.isFinite(number)) return DEFAULT_MAX_OPEN;
  return Math.min(MAX_MAX_OPEN, Math.max(MIN_MAX_OPEN, number));
};

const remindAt = (maxOpen) => normalizeMaxOpen(maxOpen) - REMIND_BEFORE;

// The pages to close before `target` opens, so that no more than `maxOpen`
// pages of the project stay open: the ones looked at longest ago first; pages
// never looked at from the bar go before all others, the earliest opened
// first. `keep` is never closed.
// open: names open now, in the order Photoshop opened them; lastViewed: { name: time }
function pagesToClose({ open, target, keep, lastViewed, maxOpen }) {
  const limit = normalizeMaxOpen(maxOpen);
  const opened = (open || []).slice();
  const after = opened.indexOf(target) >= 0 ? opened.length : opened.length + 1;
  const extra = after - limit;
  if (extra <= 0) return [];
  const kept = [target].concat(keep || []);
  const viewed = lastViewed || {};
  return opened
    .filter((name) => kept.indexOf(name) < 0)
    .sort((a, b) => (viewed[a] || 0) - (viewed[b] || 0) || opened.indexOf(a) - opened.indexOf(b))
    .slice(0, extra);
}

// The reminder shows once per project, when the open pages reach the mark
const shouldRemind = (openCount, maxOpen, reminded) => !reminded && openCount >= remindAt(maxOpen);

// Most recent first, one entry per folder, at most RECENT_LIMIT
function rememberProject(recent, folder, page, now) {
  const rest = (Array.isArray(recent) ? recent : []).filter((item) => item && item.folder && !samePath(item.folder, folder));
  return [{ folder, page: page || "", at: now || Date.now() }].concat(rest).slice(0, RECENT_LIMIT);
}

const forgetProject = (recent, folder) => (Array.isArray(recent) ? recent : []).filter((item) => item && !samePath(item.folder, folder));

const normalizeRecent = (recent) => (Array.isArray(recent) ? recent : [])
  .filter((item) => item && typeof item.folder === "string" && item.folder)
  .map((item) => ({ folder: item.folder, page: typeof item.page === "string" ? item.page : "", at: Number(item.at) || 0 }))
  .slice(0, RECENT_LIMIT);

const lastPageOf = (recent, folder) => {
  const found = (Array.isArray(recent) ? recent : []).find((item) => item && samePath(item.folder, folder));
  return found ? found.page : "";
};

// Where a project starts: the page asked for, else the page it was left on,
// else the first one
function startIndex(pages, wanted, remembered) {
  const at = (name) => (name ? (pages || []).findIndex((page) => page.toLowerCase() === String(name).toLowerCase()) : -1);
  const asked = at(wanted);
  if (asked >= 0) return asked;
  const left = at(remembered);
  return left >= 0 ? left : 0;
}

// The page of a document path, or -1 when it is not in the project
function pageIndexOfPath(folder, pages, path) {
  if (!path) return -1;
  return (pages || []).findIndex((name) => samePath(joinPath(folder, name), path));
}

// Several projects can have pages open at once; the bar shows one. Given the
// open pages (paths) and the active document, which project and page it shows
// and which projects stay listed:
// - the active document's project, when it is a page of one
// - else the project shown now, while it still has a page open
// - else another project with a page open (its page opened last)
// - else none: the bar goes back to the project list
// projects: [{ folder, pages }]; answers { show: { folder, index } | null,
// keep: [folders], counts: { folder: open pages } }
function settleProjects({ projects, open, active, shownFolder, shownIndex }) {
  const list = projects || [];
  const opened = open || [];
  const isOpen = (path) => opened.some((item) => samePath(item, path));
  const openIndexes = (project) => project.pages
    .map((name, index) => (isOpen(joinPath(project.folder, name)) ? index : -1))
    .filter((index) => index >= 0);
  const counts = {};
  list.forEach((project) => { counts[project.folder] = openIndexes(project).length; });
  let show = null;
  for (let i = 0; i < list.length && !show && active; i++) {
    const index = pageIndexOfPath(list[i].folder, list[i].pages, active);
    if (index >= 0) show = { folder: list[i].folder, index };
  }
  if (!show) {
    const shown = list.find((project) => samePath(project.folder, shownFolder));
    if (shown && counts[shown.folder] > 0) {
      show = { folder: shown.folder, index: shownIndex >= 0 ? shownIndex : openIndexes(shown)[0] };
    }
  }
  if (!show) {
    // The page opened last, across the other projects
    for (let i = opened.length - 1; i >= 0 && !show; i--) {
      for (let j = 0; j < list.length && !show; j++) {
        const index = pageIndexOfPath(list[j].folder, list[j].pages, opened[i]);
        if (index >= 0) show = { folder: list[j].folder, index };
      }
    }
  }
  const keep = list
    .filter((project) => counts[project.folder] > 0 || (show && samePath(project.folder, show.folder)))
    .map((project) => project.folder);
  return { show, keep, counts };
}

export {
  RECENT_LIMIT,
  DEFAULT_MAX_OPEN,
  MIN_MAX_OPEN,
  MAX_MAX_OPEN,
  REMIND_BEFORE,
  compareNames,
  projectPages,
  folderName,
  projectName,
  baseName,
  joinPath,
  samePath,
  normalizeMaxOpen,
  remindAt,
  pagesToClose,
  shouldRemind,
  rememberProject,
  forgetProject,
  normalizeRecent,
  lastPageOf,
  startIndex,
  pageIndexOfPath,
  settleProjects,
};
