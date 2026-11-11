import { registerModalClose } from "../../modalClose";
import "./labelPlus.scss";

import React from "react";
import { FiX } from "react-icons/fi";

import { csInterface, locale, nativeConfirm, getUserFonts, readStorage, writeToStorage } from "../../utils";
import { useContext } from "../../context";
import StylesBlock from "../stylesBlock/stylesBlock";
import { DEFAULT_REPLACEMENTS, activeReplacements, addReplacements, clickRow, restoreDefaultReplacements } from "../../labelplus/importOptions";
import { parseLpText } from "../../labelplus/lpParser";
import { buildImportPlan, compareNames, detectImageFolder, isImageFile, matchImages, mergeGroupRules, OUTPUT_FOLDER_NAME } from "../../labelplus/importPlan";
import { dirnameOf, groupIssues, joinPath, processPayload, readSidecar, runImport } from "../../labelplus/chapterRun";
import { openProject } from "../../pageNav/pageNav";

const SETTINGS_KEY = "labelPlus";

const callHost = (name, ...args) => new Promise((resolve) => {
  csInterface.evalScript(name + "(" + args.map((arg) => JSON.stringify(arg)).join(", ") + ")", (result) => {
    try {
      resolve(JSON.parse(result));
    } catch (error) {
      resolve({ ok: false, code: "bridge", message: String(result) });
    }
  });
});
const host = { call: callHost };

const pickPath = async (directory, title, types) => {
  const picked = await window.cep.fs.showOpenDialogEx(false, directory, title, null, types);
  return picked && picked.data && picked.data[0] ? picked.data[0] : "";
};

const listFolder = async (path) => {
  const listed = await callHost("lpListFolder", path);
  return listed.ok ? listed.entries : [];
};

// The folder holding the pages, next to the text file
const findImageFolder = async (textFile) => {
  const base = dirnameOf(textFile);
  const entries = await listFolder(base);
  const own = entries.filter((entry) => !entry.isFolder && isImageFile(entry.name)).length;
  const folders = [];
  for (const entry of entries.filter((item) => item.isFolder)) {
    const inner = await listFolder(joinPath(base, entry.name));
    folders.push({ name: entry.name, images: inner.filter((item) => !item.isFolder && isImageFile(item.name)).length });
  }
  const found = detectImageFolder(folders, own);
  if (found === null) return "";
  return found ? joinPath(base, found) : base;
};

// The report line of a processing run: centring, then whitening when any
const statsText = (stats) => {
  const centre = locale.lpCenterStats.replace("{total}", stats.total || 0).replace("{wanted}", stats.wanted || 0).replace("{centred}", stats.centred || 0);
  return stats.cleaned ? centre + " " + locale.lpCleanStats.replace("{cleaned}", stats.cleaned) : centre;
};

const issueText = (issue) => {
  const template = locale["lpIssue_" + issue.code] || locale.lpIssueUnknown;
  return template
    .replace("{group}", issue.group || "")
    .replace("{font}", issue.font || "")
    .replace("{code}", issue.code || "");
};

const issueWhere = (issue) => {
  const parts = [];
  if (issue.page || issue.image) parts.push(issue.page || issue.image);
  if (issue.index) parts.push("#" + issue.index);
  if (issue.text) parts.push(issue.text);
  return parts.join(" · ");
};

const Checklist = ({ issues }) => {
  if (!issues.length) return <p className="lp-ok">{locale.lpChecklistEmpty}</p>;
  return (
    <ul className="lp-checklist">
      {issues.map((issue, index) => (
        <li key={index}>
          <span className="lp-where">{issueWhere(issue)}</span>
          <span>{issueText(issue)}</span>
          {issue.message ? <span className="lp-detail">{issue.message}</span> : null}
        </li>
      ))}
    </ul>
  );
};

// Photoshop's skin hides the bare input. No focus move on the press: focusing the
// hidden input is what can scroll the panel away.
const Check = ({ checked, onChange, children }) => (
  <label className="topcoat-checkbox lp-check" onMouseDown={(event) => event.preventDefault()}>
    <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    <div className="topcoat-checkbox__checkmark"></div>
    <span>{children}</span>
  </label>
);

const LabelPlusModal = React.memo(function LabelPlusModal({ front = true }) {
  const context = useContext((state) => ({ styles: state.styles, currentStyleId: state.currentStyleId }));
  const saved = React.useMemo(() => readStorage(SETTINGS_KEY) || {}, []);
  const [textFile, setTextFile] = React.useState("");
  const [lp, setLp] = React.useState(null);
  const [sourceFolder, setSourceFolder] = React.useState("");
  const [sourceFiles, setSourceFiles] = React.useState([]);
  const [outputFolder, setOutputFolder] = React.useState("");
  const [matchMode, setMatchMode] = React.useState(saved.matchMode || "name");
  const [extension, setExtension] = React.useState(saved.extension || "");
  const [replacements, setReplacements] = React.useState(() => addReplacements(saved.replacements || DEFAULT_REPLACEMENTS, saved.replaceText || "") || DEFAULT_REPLACEMENTS);
  const [replaceDraft, setReplaceDraft] = React.useState("");
  const [skipEmpty, setSkipEmpty] = React.useState(saved.skipEmpty !== false);
  const [orientation, setOrientation] = React.useState(saved.orientation || "vertical");
  const [rules, setRules] = React.useState(saved.rules || {});
  const [selectedImages, setSelectedImages] = React.useState([]);
  const [imageAnchor, setImageAnchor] = React.useState(null);
  const [excludedGroups, setExcludedGroups] = React.useState([]);
  const [activeGroup, setActiveGroup] = React.useState("");
  const [running, setRunning] = React.useState(false);
  const [progress, setProgress] = React.useState(null);
  const [report, setReport] = React.useState(null);
  const [error, setError] = React.useState("");
  const cancelled = React.useRef(false);

  const close = () => {
    if (running) {
      cancelled.current = true;
      return;
    }
    context.dispatch({ type: "setModal" });
  };
  // An editor opened on top takes the close key, and gives it back on return
  const latestClose = React.useRef(close);
  latestClose.current = close;
  React.useEffect(() => (front ? registerModalClose(() => latestClose.current()) : undefined), [front]);

  React.useEffect(() => {
    writeToStorage({ [SETTINGS_KEY]: { matchMode, extension, replacements, skipEmpty, orientation, rules } }, false, { debounce: 500 });
  }, [matchMode, extension, replacements, skipEmpty, orientation, rules]);

  const groups = lp ? lp.groups : [];
  const usedRules = React.useMemo(() => mergeGroupRules(groups, rules), [groups, rules]);

  const setRule = (group, change) => setRules(Object.assign({}, usedRules, { [group]: Object.assign({}, usedRules[group], change) }));
  // The style list below the group tabs selects the style of the open tab
  const currentGroup = groups.indexOf(activeGroup) >= 0 ? activeGroup : groups[0];
  const expectedStyle = React.useRef(undefined);
  React.useEffect(() => {
    if (!currentGroup) return;
    const id = (usedRules[currentGroup] && usedRules[currentGroup].styleId) || null;
    if ((context.state.currentStyleId || null) === id) return;
    expectedStyle.current = id;
    context.dispatch({ type: "setCurrentStyleId", id });
  }, [currentGroup]);
  React.useEffect(() => {
    if (!currentGroup) return;
    const id = context.state.currentStyleId || null;
    if (expectedStyle.current === id) {
      expectedStyle.current = undefined;
      return;
    }
    if (((usedRules[currentGroup] && usedRules[currentGroup].styleId) || null) !== id) setRule(currentGroup, { styleId: id });
  }, [context.state.currentStyleId]);

  // A scroll of anything around the window would leave the panel displaced
  const root = React.useRef(null);
  React.useEffect(() => {
    const reset = (event) => {
      const inner = root.current && root.current.closest(".app-modal-inner");
      const target = event.target;
      if (!inner) return;
      if (target === document) window.scrollTo(0, 0);
      else if (target.contains && target.contains(inner)) target.scrollTop = 0;
    };
    document.addEventListener("scroll", reset, true);
    return () => document.removeEventListener("scroll", reset, true);
  }, []);

  const styleName = (group) => {
    const id = usedRules[group] && usedRules[group].styleId;
    const style = id && context.state.styles.find((item) => item.id === id);
    return style ? style.name : locale.lpNoStyle;
  };
  const toggleIn = (list, setList, value) => setList(list.indexOf(value) >= 0 ? list.filter((item) => item !== value) : list.concat(value));

  const changeSourceFolder = async (path) => {
    setSourceFolder(path);
    const entries = path ? await listFolder(path) : [];
    setSourceFiles(entries.filter((entry) => !entry.isFolder).map((entry) => entry.name));
  };

  const openTextFile = async () => {
    const path = await pickPath(false, locale.lpTextFile, ["txt"]);
    if (!path) return;
    setError("");
    setReport(null);
    const read = await callHost("lpReadText", path);
    if (!read.ok) {
      setError(locale.lpReadFailed + " " + (read.message || ""));
      return;
    }
    let parsed;
    try {
      parsed = parseLpText(read.text);
    } catch (parseError) {
      setError(locale.lpParseFailed);
      setLp(null);
      return;
    }
    setTextFile(path);
    setLp(parsed);
    setSelectedImages(parsed.images.map((image) => image.name));
    setImageAnchor(null);
    setExcludedGroups([]);
    setOutputFolder(joinPath(dirnameOf(path), OUTPUT_FOLDER_NAME));
    await changeSourceFolder(await findImageFolder(path));
  };

  // Text still in the box counts: it becomes an option at the latest on import
  const pendingReplacements = React.useMemo(() => addReplacements(replacements, replaceDraft), [replacements, replaceDraft]);
  const replaceRules = pendingReplacements ? activeReplacements(pendingReplacements) : null;
  const commitReplacements = () => {
    if (!pendingReplacements) return;
    setReplacements(pendingReplacements);
    setReplaceDraft("");
  };
  const matches = React.useMemo(() => {
    if (!lp) return [];
    return matchImages(lp.images.map((image) => image.name), sourceFiles, {
      byOrder: matchMode === "order",
      replaceExtension: matchMode === "extension" ? extension : "",
    });
  }, [lp, sourceFiles, matchMode, extension]);
  const plan = React.useMemo(() => {
    if (!lp || !replaceRules) return null;
    return buildImportPlan(lp, {
      matches,
      rules: replaceRules,
      skipEmpty,
      selectedImages,
      selectedGroups: groups.filter((group) => excludedGroups.indexOf(group) < 0).concat(""),
    });
  }, [lp, matches, pendingReplacements, skipEmpty, selectedImages, excludedGroups]);

  const installedFonts = () => {
    const fonts = getUserFonts();
    return fonts && fonts.length ? new Set(fonts.map((font) => font.postScriptName)) : null;
  };

  const startRun = () => {
    cancelled.current = false;
    setRunning(true);
    setError("");
    setReport(null);
  };
  const finishRun = (next) => {
    setRunning(false);
    setProgress(null);
    setReport(next);
  };

  // Both buttons work on the pages chosen above; the second also centres
  const doRun = async (withCenter) => {
    if (!plan || !plan.pages.length || !outputFolder) return;
    commitReplacements();
    const existing = (await listFolder(outputFolder)).map((entry) => entry.name.toLowerCase());
    const overwrites = plan.pages.filter((page) => existing.indexOf(page.output.toLowerCase()) >= 0);
    // Pages the page bar keeps open would be refused: they close first, unsaved,
    // since the import writes over them anyway
    const openCheck = overwrites.length ? await callHost("lpOpenPages", overwrites.map((page) => joinPath(outputFolder, page.output))) : null;
    const openPages = openCheck && openCheck.ok ? openCheck.open : [];
    if (overwrites.length) {
      const message = locale.lpOverwriteConfirm.replace("{count}", overwrites.length) + (openPages.length ? " " + locale.lpOverwriteOpen.replace("{count}", openPages.length) : "");
      const confirmed = await new Promise((resolve) => nativeConfirm(message, locale.lpTitle, resolve));
      if (!confirmed) return;
    }
    if (openPages.length) await callHost("lpClosePages", openPages);
    startRun();
    const previous = await readSidecar(host, outputFolder);
    const run = await runImport({
      plan,
      groups,
      sourceFolder,
      outputFolder,
      rules: usedRules,
      styles: context.state.styles,
      orientation,
      textFile,
      previous,
      center: withCenter,
      host,
      onProgress: setProgress,
      isCancelled: () => cancelled.current,
    });
    const issues = lp.warnings.filter((warning) => warning.code !== "emptyLabel").concat(plan.issues, groupIssues(groups, usedRules, context.state.styles, installedFonts()), run.checklist);
    const cancelledRun = run.cancelled;
    const title = (withCenter ? locale.lpProcessDone : locale.lpImportDone).replace("{done}", run.done).replace("{total}", run.total);
    const stats = withCenter ? statsText(run.stats) : "";
    const trace = withCenter ? run.stats.trace : [];
    finishRun({ title, cancelled: cancelledRun, issues, stats, trace });
    // The chapter opens in the page bar, on its first new page
    if (!cancelledRun && run.built.length && context.getState().pageNavOpenAfterImport !== false) {
      openProject({ dispatch: context.dispatch, getState: context.getState }, outputFolder, { page: run.built[0] });
    }
  };

  // The open document: to try the settings on one page. Nothing is saved.
  const processActive = async () => {
    startRun();
    const sidecar = outputFolder ? await readSidecar(host, outputFolder) : null;
    const active = sidecar ? await callHost("lpActiveDocumentName") : null;
    const page = active && active.ok ? sidecar.pages[active.name] : null;
    const result = await callHost("lpProcessPage", Object.assign({ path: "" }, processPayload(page, usedRules, context.state.styles, { applyStyle: true, center: true })));
    finishRun({
      title: result.ok ? locale.lpProcessDone.replace("{done}", 1).replace("{total}", 1) : locale.lpProcessFailed,
      cancelled: false,
      issues: result.ok ? result.issues : [{ code: result.code, message: result.message }],
      stats: result.ok ? statsText(result) : "",
      trace: result.trace || [],
    });
  };

  const found = matches.filter((match) => match.file).length;
  const canImport = !running && plan && plan.pages.length > 0 && !!sourceFolder && !!outputFolder;

  return (
    <React.Fragment>
      <div className="app-modal-header hostBrdBotContrast">
        <div className="app-modal-title">{locale.lpTitle}</div>
        <button className="topcoat-icon-button--large--quiet" title={locale.close} onClick={close}>
          <FiX size={18} />
        </button>
      </div>
      <div className="app-modal-body">
        <div className="app-modal-body-inner lp-modal" ref={root}>
          <section>
            <h3>{locale.lpStepFiles}</h3>
            <div className="lp-row">
              <button type="button" className="topcoat-button--large" disabled={running} onClick={openTextFile}>{locale.lpTextFile}</button>
              <span className="lp-path">{textFile || locale.lpNoFile}</span>
            </div>
            <div className="lp-row">
              <button type="button" className="topcoat-button--large" disabled={running} onClick={async () => { const path = await pickPath(true, locale.lpSourceFolder); if (path) changeSourceFolder(path); }}>{locale.lpSourceFolder}</button>
              <span className="lp-path">{sourceFolder || locale.lpNoFolder}</span>
            </div>
            <div className="lp-row">
              <button type="button" className="topcoat-button--large" disabled={running} onClick={async () => { const path = await pickPath(true, locale.lpOutputFolder); if (path) setOutputFolder(path); }}>{locale.lpOutputFolder}</button>
              <span className="lp-path">{outputFolder || locale.lpNoFolder}</span>
            </div>
          </section>

          <section>
            <h3>{locale.lpStepGroups}</h3>
            {currentGroup ? (
              <React.Fragment>
                <div className="lp-tabs" role="tablist">
                  {groups.map((group) => (
                    <button
                      type="button"
                      key={group}
                      role="tab"
                      aria-selected={group === currentGroup}
                      className={"lp-tab" + (group === currentGroup ? " is-active" : "")}
                      onClick={() => setActiveGroup(group)}
                    >
                      <span className="lp-tab-name">{group}</span>
                      <span className="lp-tab-style">{styleName(group)}</span>
                    </button>
                  ))}
                </div>
                <div className="lp-row lp-tab-options">
                  <Check checked={excludedGroups.indexOf(currentGroup) < 0} onChange={() => toggleIn(excludedGroups, setExcludedGroups, currentGroup)}>{locale.lpGroupImport}</Check>
                  <Check checked={!!(usedRules[currentGroup] && usedRules[currentGroup].center)} onChange={(value) => setRule(currentGroup, { center: value })}>{locale.lpGroupCenter}</Check>
                  <Check checked={!!(usedRules[currentGroup] && usedRules[currentGroup].clean)} onChange={(value) => setRule(currentGroup, { clean: value })}>{locale.lpGroupClean}</Check>
                  <button type="button" className="topcoat-button" onClick={() => context.dispatch({ type: "setCurrentStyleId", id: null })}>{locale.lpNoStyle}</button>
                </div>
              </React.Fragment>
            ) : null}
            <div className="lp-styles styles-block"><StylesBlock /></div>
          </section>

          {lp ? (
            <React.Fragment>
              <section>
                <h3>{locale.lpStepImages.replace("{found}", found).replace("{total}", matches.length)}</h3>
                <div className="lp-row">
                  <label>{locale.lpMatchMode}</label>
                  <select className="topcoat-textarea" value={matchMode} onChange={(event) => setMatchMode(event.target.value)}>
                    <option value="name">{locale.lpMatchName}</option>
                    <option value="extension">{locale.lpMatchExtension}</option>
                    <option value="order">{locale.lpMatchOrder}</option>
                  </select>
                  {matchMode === "extension" ? <input className="topcoat-text-input" value={extension} placeholder="png" onChange={(event) => setExtension(event.target.value)} /> : null}
                </div>
                <div className="lp-row">
                  <button type="button" className="topcoat-button" onClick={() => setSelectedImages(matches.map((match) => match.image))}>{locale.lpSelectAll}</button>
                  <button type="button" className="topcoat-button" onClick={() => setSelectedImages([])}>{locale.lpSelectNone}</button>
                  <span className="lp-hint">{locale.lpImagesHint.replace("{selected}", selectedImages.length).replace("{total}", matches.length)}</span>
                </div>
                <ul className="lp-images" role="listbox" aria-multiselectable="true">
                  {matches.map((match) => {
                    const chosen = selectedImages.indexOf(match.image) >= 0;
                    return (
                      <li
                        key={match.image}
                        role="option"
                        aria-selected={chosen}
                        className={(chosen ? "is-selected" : "") + (match.file ? "" : " is-missing")}
                        onMouseDown={(event) => { if (event.shiftKey) event.preventDefault(); }}
                        onClick={(event) => {
                          const next = clickRow(matches.map((item) => item.image), selectedImages, imageAnchor, match.image, { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey });
                          setSelectedImages(next.selected);
                          setImageAnchor(next.anchor);
                        }}
                      >
                        {match.image + " → " + (match.file || locale.lpImageMissing)}
                      </li>
                    );
                  })}
                </ul>
              </section>

              <section>
                <h3>{locale.lpStepOptions}</h3>
                <div className="lp-row">
                  <label>{locale.lpOrientation}</label>
                  <select className="topcoat-textarea" value={orientation} onChange={(event) => setOrientation(event.target.value)}>
                    <option value="vertical">{locale.lpVertical}</option>
                    <option value="horizontal">{locale.lpHorizontal}</option>
                  </select>
                </div>
                <div className="lp-field-label">{locale.lpTextReplace}</div>
                <ul className="lp-replacements">
                  {replacements.map((option, index) => (
                    <li key={option.from + "\u0000" + option.to}>
                      <Check checked={option.enabled} onChange={(value) => setReplacements(replacements.map((item, at) => (at === index ? Object.assign({}, item, { enabled: value }) : item)))}>{option.from + " → " + option.to}</Check>
                      <button type="button" className="lp-remove" title={locale.lpReplaceRemove} aria-label={locale.lpReplaceRemove} onClick={() => nativeConfirm(locale.lpReplaceRemoveConfirm.replace("{rule}", option.from + " → " + option.to), locale.lpTitle, (confirmed) => { if (confirmed) setReplacements((current) => current.filter((item) => item.from !== option.from || item.to !== option.to)); })}>
                        <FiX size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="lp-row">
                  <input className="topcoat-text-input" value={replaceDraft} placeholder="A->B|C->D" onChange={(event) => setReplaceDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") commitReplacements(); }} />
                  <button type="button" className="topcoat-button" disabled={!replaceDraft || !pendingReplacements} onClick={commitReplacements}>{locale.lpReplaceAdd}</button>
                  <button type="button" className="topcoat-button" onClick={() => setReplacements(restoreDefaultReplacements(replacements))}>{locale.lpReplaceRestore}</button>
                </div>
                {!pendingReplacements ? <p className="lp-error">{locale.lpTextReplaceInvalid}</p> : null}
                <div className="lp-row">
                  <Check checked={skipEmpty} onChange={setSkipEmpty}>{locale.lpSkipEmpty}</Check>
                </div>
                <p className="lp-hint">{locale.lpRunHint}</p>
                <div className="lp-row">
                  <button type="button" className="topcoat-button--large" disabled={!canImport} onClick={() => doRun(false)}>
                    {locale.lpImportButton.replace("{count}", plan ? plan.pages.length : 0)}
                  </button>
                  <button type="button" className="topcoat-button--large--cta" disabled={!canImport} onClick={() => doRun(true)}>{locale.lpProcessButton}</button>
                  <button type="button" className="topcoat-button--large" disabled={running} onClick={processActive}>{locale.lpProcessActive}</button>
                </div>
              </section>
            </React.Fragment>
          ) : null}

          {error ? <p className="lp-error">{error}</p> : null}
          {progress ? <p className="lp-progress">{progress.current + " / " + progress.total + "  " + progress.name}</p> : null}
          {running ? <button type="button" className="topcoat-button--large--quiet" onClick={() => { cancelled.current = true; }}>{locale.lpStop}</button> : null}

          {report ? (
            <section>
              <h3>{report.title}{report.cancelled ? " · " + locale.lpStopped : ""}</h3>
              {report.stats ? <p>{report.stats}</p> : null}
              <Checklist issues={report.issues} />
              {report.trace && report.trace.length ? <pre className="lp-trace">{report.trace.join("\n")}</pre> : null}
            </section>
          ) : null}
        </div>
      </div>
    </React.Fragment>
  );
});

export default LabelPlusModal;
