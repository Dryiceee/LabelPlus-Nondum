import "./pageNav.scss";

import React from "react";
import { FiChevronLeft, FiChevronRight, FiFolder, FiX } from "react-icons/fi";

import { locale, addPhotoshopEventListener, isPhotoshopSelectEvent, isHostActionPending, isPanelIdle, isPanelInteracting } from "../../utils";
import { useContext } from "../../context";
import { withShortcutHint } from "../../shortcutCommands";
import { projectName } from "../../pageNav/pageNavLogic";
import { checkOpenPages, closeProject, followActiveDocument, goToPage, openProject, pickFolder, pollOpenPages, refreshProject, switchProject, turnPage } from "../../pageNav/pageNav";

// How often the open pages are counted while a project is open. Photoshop
// does not tell a plugin when a document closes (open does arrive), so this
// is what brings the bar back to the project list after Close All. Slower
// once the panel has seen no activity for a while.
const POLL_MS = 3000;
const IDLE_POLL_MS = 10000;

const REFRESH = "__refresh__";
const SWITCH = "switch:";
const RECENT = "recent:";

const pad = (number, width) => String(number).padStart(width, "0");
const isDocumentSelect = (event) => typeof (event && event.data) === "string" && /"_ref":"document"|"documentID"/.test(event.data);
// Photoshop's open and close events (uxp-src/host/main.js forwards them)
const isOpenOrClose = (event) => typeof (event && event.data) === "string" && /"eventID":(1332768288|1131180832)/.test(event.data);

// Under Align in the main panel. First row: open a folder, and the project
// list (the shown project, the other open ones to switch to, the recent ones).
// Second row, while a project is shown: ◀ page ▶ and close.
const PageNav = React.memo(function PageNav() {
  const context = useContext((state) => ({
    pageProject: state.pageProject,
    pageNavRecent: state.pageNavRecent,
    pageNavOpenProjects: state.pageNavOpenProjects,
    pageNavBusy: state.pageNavBusy,
    shortcut: state.shortcut,
  }));
  const ctx = { dispatch: context.dispatch, getState: context.getState, get state() { return context.getState(); } };
  const project = context.state.pageProject;
  const busy = context.state.pageNavBusy;

  // Follow the document brought to the front in Photoshop. Only a document
  // select asks the host: a layer click must not cost a host call.
  const projectFolder = project ? project.folder : "";
  React.useEffect(() => {
    if (!projectFolder) return undefined;
    let timer = null;
    const unsubscribe = addPhotoshopEventListener((event) => {
      if (!isPhotoshopSelectEvent(event) || !isDocumentSelect(event)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        followActiveDocument(ctx);
      }, 300);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [projectFolder]);

  // Pages opened or closed in Photoshop itself, and the panel shown again:
  // count the open pages (limit, reminder, back to the project list when none
  // is left). Waits for the end of a burst, such as File > Open of many pages.
  React.useEffect(() => {
    if (!projectFolder) return undefined;
    let timer = null;
    const schedule = (delay) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        checkOpenPages(ctx);
      }, delay);
    };
    const unsubscribe = addPhotoshopEventListener((event) => {
      if (isOpenOrClose(event)) schedule(1500);
    });
    const onVisible = () => {
      if (!document.hidden) schedule(200);
    };
    document.addEventListener("visibilitychange", onVisible);
    // Never behind a running host action, nor during a click in the panel,
    // and one count at a time
    let counting = false;
    let lastCount = 0;
    const poll = setInterval(() => {
      if (counting || timer || document.hidden || isHostActionPending() || isPanelInteracting()) return;
      if (isPanelIdle() && Date.now() - lastCount < IDLE_POLL_MS) return;
      counting = true;
      lastCount = Date.now();
      pollOpenPages(ctx).finally(() => {
        counting = false;
      });
    }, POLL_MS);
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(poll);
      if (timer) clearTimeout(timer);
    };
  }, [projectFolder]);

  const chooseFolder = async () => {
    const folder = await pickFolder();
    if (folder) openProject(ctx, folder);
  };

  const recent = context.state.pageNavRecent || [];
  const openProjects = context.state.pageNavOpenProjects || [];
  const sameFolder = (a, b) => String(a).replace(/\//g, "\\").toLowerCase() === String(b).replace(/\//g, "\\").toLowerCase();
  const recentLabel = (item) => projectName(item.folder) + (item.page ? " · " + item.page : "") + "  (" + item.folder + ")";
  const openLabel = (item) => (item.open > 0 ? fill(locale.pageNavSwitchProject, { name: projectName(item.folder), count: item.open }) : projectName(item.folder));

  // Project row: the open projects (the shown one selected), then the recent ones
  const listed = project && !openProjects.some((item) => sameFolder(item.folder, project.folder))
    ? [{ folder: project.folder, open: 0 }].concat(openProjects)
    : openProjects;
  const openList = listed.filter((item) => item.open > 0 || (project && sameFolder(item.folder, project.folder)));
  const recentList = recent.filter((item) => !openList.some((open) => sameFolder(open.folder, item.folder)));
  const onProject = (event) => {
    const value = event.target.value;
    if (value.indexOf(SWITCH) === 0) {
      const folder = value.slice(SWITCH.length);
      if (!project || !sameFolder(folder, project.folder)) switchProject(ctx, folder);
    } else if (value.indexOf(RECENT) === 0) {
      openProject(ctx, value.slice(RECENT.length));
    }
  };
  const projectRow = (
    <div className="page-nav">
      <button type="button" className="topcoat-icon-button--large page-nav_arrow" disabled={busy} title={locale.pageNavChooseFolderHint} onClick={chooseFolder}>
        <FiFolder size={16} />
      </button>
      <select
        className="topcoat-textarea page-nav_select"
        value={project ? SWITCH + project.folder : ""}
        disabled={busy || (!project && !recent.length)}
        title={project ? project.folder : locale.pageNavRecent}
        onChange={onProject}
      >
        {project ? null : <option value="">{recent.length ? locale.pageNavRecent : locale.pageNavNoRecent}</option>}
        {openList.map((item) => (
          <option key={"o" + item.folder} value={SWITCH + item.folder} title={item.folder}>{openLabel(item)}</option>
        ))}
        {project && recentList.length ? <option disabled value="-recent-">{locale.pageNavRecentGroup}</option> : null}
        {recentList.map((item) => (
          <option key={"r" + item.folder} value={RECENT + item.folder} title={item.folder}>{recentLabel(item)}</option>
        ))}
      </select>
    </div>
  );

  if (!project) return <div className={"page-nav-block" + (busy ? " is-busy" : "")}>{projectRow}</div>;

  const total = project.pages.length;
  const width = String(total).length < 2 ? 2 : String(total).length;
  const onPage = (event) => {
    const value = event.target.value;
    if (value === REFRESH) refreshProject(ctx);
    else if (value !== "") goToPage(ctx, parseInt(value, 10));
  };

  return (
    <div className={"page-nav-block" + (busy ? " is-busy" : "")}>
      {projectRow}
      <div className="page-nav">
        <button
          type="button"
          className="topcoat-icon-button--large page-nav_arrow"
          disabled={busy || project.index <= 0}
          title={withShortcutHint(locale.pageNavPrevious, context.state.shortcut && context.state.shortcut.previousPsd)}
          onClick={() => turnPage(ctx, -1)}
        >
          <FiChevronLeft size={18} />
        </button>
        <select
          className="topcoat-textarea page-nav_select"
          value={project.index >= 0 ? String(project.index) : ""}
          disabled={busy}
          title={project.folder}
          onChange={onPage}
        >
          {project.index < 0 ? <option value="">{"— / " + total}</option> : null}
          {project.pages.map((name, index) => (
            <option key={name} value={String(index)}>{pad(index + 1, width) + "/" + pad(total, width) + " · " + name}</option>
          ))}
          <option disabled value="-sep-">──────────</option>
          <option value={REFRESH}>{locale.pageNavRefresh}</option>
        </select>
        <button
          type="button"
          className="topcoat-icon-button--large page-nav_arrow"
          disabled={busy || project.index >= total - 1}
          title={withShortcutHint(locale.pageNavNext, context.state.shortcut && context.state.shortcut.nextPsd)}
          onClick={() => turnPage(ctx, 1)}
        >
          <FiChevronRight size={18} />
        </button>
        <button type="button" className="topcoat-icon-button--large page-nav_arrow" disabled={busy} title={fill(locale.pageNavCloseProjectHint, { name: projectName(project.folder) })} onClick={() => closeProject(ctx)}>
          <FiX size={16} />
        </button>
      </div>
    </div>
  );
});

const fill = (template, values) => Object.keys(values).reduce((text, key) => text.split("{" + key + "}").join(values[key]), String(template || ""));

export default PageNav;
