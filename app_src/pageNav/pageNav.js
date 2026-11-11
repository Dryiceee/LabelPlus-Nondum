// Page bar of the main panel: open folders of PSDs as projects and turn their
// pages. Called by the bar and by the page shortcuts, so it works from the
// state alone. A page turn saves the page left behind and keeps it open (its
// history stays); past the limit set in the settings, counted over every open
// project, the page looked at longest ago is saved and closed.
//
// Several projects can have pages open at once. The bar shows one, and
// follows the document brought to the front. The rules are in pageNavLogic.js.

import { csInterface, locale, nativeConfirm } from "../utils";
import {
  baseName,
  joinPath,
  lastPageOf,
  pageIndexOfPath,
  pagesToClose,
  projectName,
  projectPages,
  rememberProject,
  forgetProject,
  remindAt,
  normalizeMaxOpen,
  samePath,
  settleProjects,
  shouldRemind,
  startIndex,
} from "./pageNavLogic";
import { setPageTurner } from "./pageCommands";

const callHost = (name, ...args) => new Promise((resolve) => {
  csInterface.evalScript(name + "(" + args.map((arg) => JSON.stringify(arg)).join(", ") + ")", (result) => {
    try {
      resolve(JSON.parse(result));
    } catch (error) {
      resolve({ ok: false, code: "bridge", message: String(result) });
    }
  });
});

// For this Photoshop session: the projects opened from the bar, when each page
// was last looked at, and whether the reminder was shown (again once the open
// pages drop below the mark)
const projects = [];
const lastViewed = {};
let reminded = false;
let busy = false;

const viewKey = (path) => String(path || "").replace(/\//g, "\\").toLowerCase();
const markViewed = (path, at) => { lastViewed[viewKey(path)] = at || Date.now(); };

const notice = (ctx, text, kind, duration) => ctx.dispatch({ type: "showNotice", text, kind: kind || "info", duration });
// The reminder and the closing notice explain history loss: time to read them
const LONG_NOTICE_MS = 15000;
const fill = (template, values) => Object.keys(values).reduce((text, key) => text.split("{" + key + "}").join(values[key]), String(template || ""));
const issueMessage = (code) => locale["lpIssue_" + code] || fill(locale.lpIssueUnknown, { code });

const pathsOf = (project) => project.pages.map((name) => joinPath(project.folder, name));
const allPaths = () => projects.reduce((paths, project) => paths.concat(pathsOf(project)), []);
const findProject = (folder) => projects.find((project) => samePath(project.folder, folder));
const ownerOf = (path) => projects.find((project) => pageIndexOfPath(project.folder, project.pages, path) >= 0);
// "03.psd", or "ch02 · 03.psd" for a page of a project not on the bar
const pageLabel = (ctx, path) => {
  const owner = ownerOf(path);
  const shown = ctx.getState().pageProject;
  return owner && shown && !samePath(owner.folder, shown.folder) ? projectName(owner.folder) + " · " + baseName(path) : baseName(path);
};

const addProject = (folder, pages) => {
  const known = findProject(folder);
  if (known) known.pages = pages;
  else projects.push({ folder, pages });
  return findProject(folder);
};

const remember = (ctx, folder, page) => {
  ctx.dispatch({ type: "setPageNavRecent", recent: rememberProject(ctx.getState().pageNavRecent, folder, page) });
};

const show = (ctx, folder, index) => {
  const project = findProject(folder);
  if (!project) return;
  const shown = ctx.getState().pageProject;
  if (shown && samePath(shown.folder, folder) && shown.pages === project.pages) {
    ctx.dispatch({ type: "setPageIndex", index });
  } else {
    ctx.dispatch({ type: "setPageProject", project: { folder: project.folder, pages: project.pages, index } });
  }
  if (index >= 0) remember(ctx, project.folder, project.pages[index]);
};

// The other open projects and their open page counts, for the bar's list;
// dispatched only when it changed
let lastSummary = "";
const publishOpenProjects = (ctx, counts) => {
  const list = projects.map((project) => ({ folder: project.folder, open: (counts && counts[project.folder]) || 0 }));
  const text = JSON.stringify(list);
  if (text === lastSummary) return;
  lastSummary = text;
  ctx.dispatch({ type: "setPageNavOpenProjects", projects: list });
};

// One page turn at a time; the bar greys out meanwhile
async function exclusive(ctx, work) {
  if (busy) return false;
  busy = true;
  ctx.dispatch({ type: "setPageNavBusy", value: true });
  try {
    await work();
    return true;
  } finally {
    busy = false;
    ctx.dispatch({ type: "setPageNavBusy", value: false });
  }
}

// What the user hears after pages were counted: the pages closed, the ones
// that could not be, or the reminder once the mark is reached
function report(ctx, openCount, closing, maxOpen) {
  const closed = (closing && closing.closed) || [];
  const failed = ((closing && closing.issues) || []).map((issue) => issue.page);
  if (openCount < remindAt(maxOpen)) reminded = false;
  if (closed.length) {
    // The closing notice says why history is lost: no separate reminder
    reminded = true;
    notice(ctx, fill(locale.pageNavAutoClosed, { pages: closed.map((path) => pageLabel(ctx, path)).join("、"), max: maxOpen }), "warning", LONG_NOTICE_MS);
  } else if (failed.length) {
    notice(ctx, fill(locale.pageNavCloseFailed, { pages: failed.map((path) => pageLabel(ctx, path)).join("、") }), "warning");
  } else if (shouldRemind(openCount, maxOpen, reminded)) {
    reminded = true;
    notice(ctx, fill(locale.pageNavRemind, { count: openCount, max: maxOpen }), "warning", LONG_NOTICE_MS);
  }
}

// After pages opened or closed: which project the bar shows, which projects
// stay listed. Inside exclusive().
function settle(ctx, open, active) {
  const shown = ctx.getState().pageProject;
  const result = settleProjects({
    projects,
    open,
    active,
    shownFolder: shown ? shown.folder : "",
    shownIndex: shown ? shown.index : -1,
  });
  for (let i = projects.length - 1; i >= 0; i--) {
    if (!result.keep.some((folder) => samePath(folder, projects[i].folder))) projects.splice(i, 1);
  }
  publishOpenProjects(ctx, result.counts);
  if (!result.show) {
    ctx.dispatch({ type: "setPageProject", project: null });
    return;
  }
  const project = findProject(result.show.folder);
  const changed = !shown || !samePath(shown.folder, result.show.folder) || shown.index !== result.show.index;
  if (changed) {
    if (result.show.index >= 0 && active && samePath(joinPath(project.folder, project.pages[result.show.index]), active)) markViewed(active);
    show(ctx, result.show.folder, result.show.index);
  }
}

async function turnTo(ctx, project, index) {
  const maxOpen = normalizeMaxOpen(ctx.getState().pageNavMaxOpen);
  const target = joinPath(project.folder, project.pages[index]);
  const listed = await callHost("lpOpenPages", allPaths());
  const open = listed && listed.ok ? listed.open : [];
  // The page being left: the active document when it is a page of a project
  const shown = ctx.getState().pageProject;
  const current = shown && shown.index >= 0 ? joinPath(shown.folder, shown.pages[shown.index]) : "";
  const active = listed && listed.ok && listed.active && ownerOf(listed.active) ? listed.active : "";
  const leavingPath = active || (current && open.some((path) => samePath(path, current)) ? current : "");
  const leaving = leavingPath && !samePath(leavingPath, target) ? leavingPath : "";
  const close = pagesToClose({
    open: open.map(viewKey),
    target: viewKey(target),
    keep: leaving ? [viewKey(leaving)] : [],
    lastViewed,
    maxOpen,
  }).map((key) => open.find((path) => viewKey(path) === key));
  const result = await callHost("lpTurnPage", { from: leaving, to: target, close });
  if (!result || !result.ok) {
    notice(ctx, fill(locale.pageNavFailed, { page: baseName(target), reason: issueMessage(result && result.code) }) + (result && result.message ? " " + result.message : ""), "warning");
    return false;
  }
  // The page just left was looked at until now
  if (leaving) markViewed(leaving, Date.now() - 1);
  markViewed(target);
  show(ctx, project.folder, index);

  const closed = result.closed || [];
  const openNow = open.filter((path) => !closed.some((item) => samePath(item, path)));
  if (!openNow.some((path) => samePath(path, target))) openNow.push(target);
  report(ctx, openNow.length, result, maxOpen);
  settle(ctx, openNow, target);
  return true;
}

// Counts the open pages of every project: past the limit the pages looked at
// longest ago are saved and closed, then the bar settles on a project (or the
// project list). Inside exclusive().
async function countPages(ctx) {
  const listed = await callHost("lpOpenPages", allPaths());
  if (!listed || !listed.ok) return;
  const open = listed.open;
  const maxOpen = normalizeMaxOpen(ctx.getState().pageNavMaxOpen);
  const shown = ctx.getState().pageProject;
  const active = listed.active && ownerOf(listed.active) ? listed.active : "";
  const current = shown && shown.index >= 0 ? joinPath(shown.folder, shown.pages[shown.index]) : "";
  const keep = [active, current].filter((path) => path && open.some((item) => samePath(item, path)));
  let closing = null;
  if (open.length) {
    const close = pagesToClose({
      open: open.map(viewKey),
      target: viewKey(keep[0] || open[open.length - 1]),
      keep: keep.map(viewKey),
      lastViewed,
      maxOpen,
    }).map((key) => open.find((path) => viewKey(path) === key));
    if (close.length) {
      closing = await callHost("lpClosePages", close, { save: true });
      if (!closing || !closing.ok) closing = { closed: [], issues: close.map((path) => ({ page: path })) };
    }
  }
  const closed = (closing && closing.closed) || [];
  const openNow = open.filter((path) => !closed.some((item) => samePath(item, path)));
  report(ctx, openNow.length, closing, maxOpen);
  settle(ctx, openNow, active);
}

// Opens `folder` as a project and shows it; projects already open stay open.
// options.page: the page to start on (else the page it was left on, else the
// first)
async function openProject(ctx, folder, options = {}) {
  if (!folder) return false;
  let opened = false;
  await exclusive(ctx, async () => {
    const listed = await callHost("lpListFolder", folder);
    if (!listed || !listed.ok) {
      notice(ctx, fill(locale.pageNavFolderGone, { folder: projectName(folder) }), "warning");
      ctx.dispatch({ type: "setPageNavRecent", recent: forgetProject(ctx.getState().pageNavRecent, folder) });
      return;
    }
    const pages = projectPages(listed.entries);
    if (!pages.length) {
      notice(ctx, fill(locale.pageNavNoPsd, { folder: projectName(folder) }), "warning");
      return;
    }
    const project = addProject(folder, pages);
    const index = startIndex(pages, options.page, lastPageOf(ctx.getState().pageNavRecent, folder));
    ctx.dispatch({ type: "setPageProject", project: { folder: project.folder, pages, index: -1 } });
    opened = await turnTo(ctx, project, index);
    if (!opened) remember(ctx, project.folder, pages[index]);
  });
  return opened;
}

async function goToPage(ctx, index) {
  const shown = ctx.getState().pageProject;
  const project = shown && findProject(shown.folder);
  if (!project || index < 0 || index >= project.pages.length) return false;
  let turned = false;
  await exclusive(ctx, async () => {
    turned = await turnTo(ctx, project, index);
  });
  return turned;
}

// delta: -1 or 1. At either end the bar stays where it is.
async function turnPage(ctx, delta) {
  const shown = ctx.getState().pageProject;
  if (!shown) return false;
  const next = shown.index < 0 ? 0 : shown.index + delta;
  if (next < 0 || next >= shown.pages.length) {
    notice(ctx, next < 0 ? locale.pageNavFirst : locale.pageNavLast, "info");
    return false;
  }
  return goToPage(ctx, next);
}

// Shows another open project, on its page opened last (or the page it was
// left on)
async function switchProject(ctx, folder) {
  const project = findProject(folder);
  if (!project) return openProject(ctx, folder);
  await exclusive(ctx, async () => {
    const listed = await callHost("lpOpenPages", pathsOf(project));
    const open = listed && listed.ok ? listed.open : [];
    const last = open.length ? pageIndexOfPath(project.folder, project.pages, open[open.length - 1]) : -1;
    const index = last >= 0 ? last : startIndex(project.pages, "", lastPageOf(ctx.getState().pageNavRecent, project.folder));
    await turnTo(ctx, project, index);
  });
  return true;
}

// Re-reads the folder of the project on the bar, for PSDs added or removed
async function refreshProject(ctx) {
  const shown = ctx.getState().pageProject;
  if (!shown) return;
  const listed = await callHost("lpListFolder", shown.folder);
  if (!listed || !listed.ok) return;
  const pages = projectPages(listed.entries);
  if (!pages.length) return;
  const current = shown.pages[shown.index];
  addProject(shown.folder, pages);
  const latest = ctx.getState().pageProject;
  if (!latest || !samePath(latest.folder, shown.folder)) return;
  ctx.dispatch({ type: "setPageProject", project: { folder: shown.folder, pages, index: current ? pages.indexOf(current) : -1 } });
}

// The close button: asks first, then saves and closes the project's open
// pages and shows another open project, or the project list
async function closeProject(ctx) {
  const shown = ctx.getState().pageProject;
  if (!shown || busy) return false;
  const project = findProject(shown.folder) || { folder: shown.folder, pages: shown.pages };
  const listed = await callHost("lpOpenPages", pathsOf(project));
  const open = listed && listed.ok ? listed.open : [];
  const name = projectName(project.folder);
  const question = open.length ? fill(locale.pageNavCloseConfirmOpen, { name, count: open.length }) : fill(locale.pageNavCloseConfirm, { name });
  const confirmed = await new Promise((resolve) => nativeConfirm(question, locale.pageNavCloseProject, resolve));
  if (!confirmed) return false;
  await exclusive(ctx, async () => {
    if (open.length) {
      const closing = await callHost("lpClosePages", open, { save: true });
      const failed = closing && closing.ok ? closing.issues || [] : open.map((path) => ({ page: path }));
      if (failed.length) {
        notice(ctx, fill(locale.pageNavCloseFailed, { pages: failed.map((issue) => baseName(issue.page)).join("、") }), "warning");
        return;
      }
    }
    const at = projects.indexOf(findProject(project.folder));
    if (at >= 0) projects.splice(at, 1);
    ctx.dispatch({ type: "setPageProject", project: null });
    await countPages(ctx);
  });
  return true;
}

// Pages opened or closed in Photoshop itself, the panel shown again: the full
// count
async function checkOpenPages(ctx) {
  if (!ctx.getState().pageProject || busy) return;
  await exclusive(ctx, () => countPages(ctx));
}

// The safety net under the events (Photoshop never tells a plugin a document
// closed), run every few seconds while a project is open: one cheap host
// call, and the full count (which greys the bar out) only when it is needed
async function pollOpenPages(ctx) {
  if (!ctx.getState().pageProject || busy) return;
  const listed = await callHost("lpOpenPages", allPaths());
  if (!listed || !listed.ok || busy || !ctx.getState().pageProject) return;
  const open = listed.open;
  const maxOpen = normalizeMaxOpen(ctx.getState().pageNavMaxOpen);
  const shown = ctx.getState().pageProject;
  const shownOpen = open.filter((path) => pageIndexOfPath(shown.folder, shown.pages, path) >= 0).length;
  if (open.length < remindAt(maxOpen)) reminded = false;
  if (!shownOpen || open.length > maxOpen || shouldRemind(open.length, maxOpen, reminded)) {
    await checkOpenPages(ctx);
    return;
  }
  settleQuietly(ctx, open, listed.active);
}

// A document brought to the front in Photoshop: the bar follows when it is a
// page of an open project. Nothing is saved or opened.
async function followActiveDocument(ctx) {
  if (!ctx.getState().pageProject || busy) return;
  const listed = await callHost("lpOpenPages", allPaths());
  if (!listed || !listed.ok || busy || !ctx.getState().pageProject) return;
  settleQuietly(ctx, listed.open, listed.active);
}

// settle() without greying the bar: only follows the active document and
// refreshes the open counts
function settleQuietly(ctx, open, active) {
  if (busy) return;
  settle(ctx, open, active && ownerOf(active) ? active : "");
}

setPageTurner(turnPage);

const pickFolder = async () => {
  const picked = await window.cep.fs.showOpenDialogEx(false, true, locale.pageNavChooseFolder, null, []);
  return picked && picked.data && picked.data[0] ? picked.data[0] : "";
};

export {
  callHost,
  openProject,
  goToPage,
  turnPage,
  switchProject,
  refreshProject,
  closeProject,
  followActiveDocument,
  checkOpenPages,
  pollOpenPages,
  pickFolder,
  remindAt,
};
