import { useModalClose } from "../../modalClose";
import { serializeStyle, validateImportData, hasStyleImportConflicts } from "../../librarySerialization";
import React from "react";
import { FiX, FiSearch, FiSettings, FiEye, FiRotateCcw, FiCheck, FiTrash2, FiDatabase, FiZoomIn } from "react-icons/fi";
import { MdSave } from "react-icons/md";
import { FaKeyboard, FaFileExport, FaFileImport } from "react-icons/fa";

import config from "../../config";
import { reloadApp, backupStorage, locale, baseLocale, nativeAlert, nativeConfirm, checkUpdate, deleteStorageFile, getUserFonts } from "../../utils";
import { openKeyboardAccessSettings, readKeyboardAccess } from "../../keyboardAccess";
import { useContext, defaultUiLayout, normalizeUiLayout } from "../../context";
import { PRODUCT_THEMES, getEditorThemePreviewColors } from "../../themePresets";
import Shortcut from "./shortCut";
import FontScanPromo from "./fontScanPromo";
import ProfileSettings from "./profileSettings";
import UnsavedChangesDialog from "./unsavedChangesDialog";
import MissingFontsDialog from "./missingFontsDialog";
import { collectMissingStyleFonts } from "../../fontFinderMatch";
import { NO_TEXT_PRESETS, toolPresetFileToImportData } from "../../toolPresetImport";
import { productShortcutCommands as shortcutCommands } from "../../shortcutCommands";
import { clearTypeRCache, formatCacheBytes, getTypeRCacheInfo } from "../../cepCache";
import { normalizeSettingsTab, readSettingsTab, writeSettingsTab } from "../../settingsTab";
import { buildSettingsSearchIndex, findSettingRow, searchSettings } from "../../settingsSearch";
import SettingsSearchResults from "./settingsSearchResults";
import { MIN_MAX_OPEN, MAX_MAX_OPEN, normalizeMaxOpen, remindAt } from "../../pageNav/pageNavLogic";

// Shortcuts tab: commands grouped by what they act on. A command missing
// here still shows, in the last group, so a new one is never hidden.
const SHORTCUT_GROUPS = [
  { id: "centering", labelKey: "settingsGroupCentering", fallback: "Centering", commands: ["center"] },
  { id: "styles", labelKey: "settingsShortcutGroupStyles", fallback: "Styles and size", commands: ["applyStyle", "previousStyle", "nextStyle", "increase", "decrease", "toggleStyleStroke"] },
  { id: "modes", labelKey: "settingsShortcutGroupModes", fallback: "Modes", commands: ["toggleCleaningLayers"] },
  { id: "pages", labelKey: "settingsShortcutGroupPages", fallback: "Pages", commands: ["previousPsd", "nextPsd"] },
];
const groupShortcutCommands = (commands) => {
  const groups = SHORTCUT_GROUPS.map((group) => ({
    ...group,
    commands: group.commands.map((id) => commands.find((command) => command.id === id)).filter(Boolean),
  }));
  const grouped = new Set(SHORTCUT_GROUPS.reduce((ids, group) => ids.concat(group.commands), []));
  const rest = commands.filter((command) => !grouped.has(command.id));
  groups[groups.length - 1].commands.push(...rest);
  return groups.filter((group) => group.commands.length);
};

const themeLabel = (theme) => ({
  system: locale.settingsThemeSystem || "Photoshop",
  "editor-dark": locale.settingsThemeDark || "Dark",
  "editor-light": locale.settingsThemeLight || "Light",
}[theme.id] || theme.label);

const SettingsModal = React.memo(function SettingsModal() {
  const context = useContext((state) => ({
    language: state.language,
    checkUpdates: state.checkUpdates,
    autoUpdate: state.autoUpdate,
    editorTheme: state.editorTheme,
    shortcut: state.shortcut,
    uiLayout: state.uiLayout,
    styles: state.styles,
    modalData: state.modalData,
    pageNavOpenAfterImport: state.pageNavOpenAfterImport,
    pageNavMaxOpen: state.pageNavMaxOpen,
  }));
  // Another window can open a given tab; otherwise the settings reopen on the
  // last tab the user looked at
  const [activeTab, setActiveTab] = React.useState(() => normalizeSettingsTab((context.state.modalData && context.state.modalData.tab) || readSettingsTab()));
  const [language, setLanguage] = React.useState(context.state.language || "auto");
  const [checkUpdates, setCheckUpdates] = React.useState(context.state.checkUpdates !== false);
  const [autoUpdate, setAutoUpdate] = React.useState(context.state.autoUpdate === true);
  const [pageOpenAfterImport, setPageOpenAfterImport] = React.useState(context.state.pageNavOpenAfterImport !== false);
  const [pageMaxOpen, setPageMaxOpen] = React.useState(String(normalizeMaxOpen(context.state.pageNavMaxOpen)));
  const [editorTheme, setEditorTheme] = React.useState(context.state.editorTheme || "system");
  const [uiScale, setUiScale] = React.useState(String(normalizeUiLayout(context.state.uiLayout).sizes.uiScale));
  const [shortcutDraft, setShortcutDraft] = React.useState(() => ({ ...context.state.shortcut }));
  const [edited, setEdited] = React.useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = React.useState(false);
  const [missingFontsImport, setMissingFontsImport] = React.useState(null);
  const [cacheInfo, setCacheInfo] = React.useState(getTypeRCacheInfo);
  const [keyboardAccess, setKeyboardAccess] = React.useState("unknown");

  // UXP on macOS: Input Monitoring for Photoshop, read again on each tab change
  React.useEffect(() => {
    let active = true;
    readKeyboardAccess().then((value) => {
      if (active) setKeyboardAccess(value);
    });
    return () => {
      active = false;
    };
  }, [activeTab]);

  React.useEffect(() => {
    setShortcutDraft({ ...context.state.shortcut });
  }, [context.state.shortcut]);

  React.useEffect(() => {
    writeSettingsTab(activeTab);
    if (activeTab === "general") setCacheInfo(getTypeRCacheInfo());
  }, [activeTab]);

  const [searchQuery, setSearchQuery] = React.useState("");
  const [searchHighlight, setSearchHighlight] = React.useState(0);
  const [searchTarget, setSearchTarget] = React.useState(null);
  const searchInputRef = React.useRef(null);
  const settingsFormRef = React.useRef(null);
  const searching = searchQuery.trim() !== "";

  // Runs once the tab of the chosen result is displayed
  React.useEffect(() => {
    if (!searchTarget || !settingsFormRef.current) return undefined;
    const form = settingsFormRef.current;
    const row = searchTarget.isTab ? null : findSettingRow(form, searchTarget);
    if (!row) {
      const body = form.closest(".app-modal-body");
      if (body) body.scrollTop = 0;
      return undefined;
    }
    row.scrollIntoView({ block: "center" });
    row.classList.add("settings-search-flash");
    const timer = setTimeout(() => row.classList.remove("settings-search-flash"), 1800);
    return () => {
      clearTimeout(timer);
      row.classList.remove("settings-search-flash");
    };
  }, [searchTarget]);

  // Cmd/Ctrl+F, except while a shortcut row is recording that very combination
  React.useEffect(() => {
    const focusSearch = (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.keyCode !== 70) return;
      const active = document.activeElement;
      if (active && active.closest && active.closest(".shortcut-row")) return;
      e.preventDefault();
      if (!searchInputRef.current) return;
      searchInputRef.current.focus();
      searchInputRef.current.select();
    };
    document.addEventListener("keydown", focusSearch);
    return () => document.removeEventListener("keydown", focusSearch);
  }, []);

  const shortcutGroups = React.useMemo(
    () => groupShortcutCommands(shortcutCommands).map((group) => ({ ...group, label: locale[group.labelKey] || group.fallback })),
    []
  );

  const shortcutConflicts = React.useMemo(() => {
    const bySignature = {};
    const conflicts = {};
    shortcutCommands.forEach((command) => {
      const keys = shortcutDraft[command.id] || [];
      if (!keys.length) return;
      const signature = Array.from(new Set(keys.map((key) => String(key).toUpperCase())))
        .sort()
        .join("+");
      if (!signature) return;
      if (!bySignature[signature]) bySignature[signature] = [];
      bySignature[signature].push(command);
    });
    Object.values(bySignature).forEach((commands) => {
      if (commands.length < 2) return;
      commands.forEach((command) => {
        conflicts[command.id] = commands
          .filter((other) => other.id !== command.id)
          .map((other) => locale[other.label] || other.id)
          .join(", ");
      });
    });
    return conflicts;
  }, [shortcutDraft]);

  const changeShortcut = React.useCallback((id, keys) => {
    setShortcutDraft((current) => ({ ...current, [id]: keys }));
    setEdited(true);
  }, []);

  const closeModal = () => {
    context.dispatch({ type: "setModal" });
  };

  const close = () => {
    if (edited) {
      setDiscardConfirmOpen(true);
      return;
    }
    closeModal();
  };
  useModalClose(close);

  const confirmClose = () => {
    setDiscardConfirmOpen(false);
    closeModal();
  };

  const changeLanguage = (e) => {
    setLanguage(e.target.value);
    setEdited(true);
  };

  const changeCheckUpdates = (e) => {
    setCheckUpdates(e.target.checked);
    setEdited(true);
  };

  const changeAutoUpdate = (e) => {
    setAutoUpdate(e.target.checked);
    setEdited(true);
  };

  // Keeps the grid selection in sync when the reducer moves the theme itself
  React.useEffect(() => {
    setEditorTheme(context.state.editorTheme);
  }, [context.state.editorTheme]);

  // Applied at once: a theme is judged by looking at it
  const changeEditorTheme = (theme) => {
    setEditorTheme(theme);
    context.dispatch({ type: "setEditorTheme", theme });
  };

  const save = (e) => {
    e.preventDefault();
    if (language !== context.state.language) {
      context.dispatch({ type: "setLanguage", lang: language });
      setTimeout(() => reloadApp(), 100);
    }
    if (config.updatesEnabled) {
      if (checkUpdates !== context.state.checkUpdates) {
        context.dispatch({ type: "setCheckUpdates", value: checkUpdates });
      }
      if (autoUpdate !== context.state.autoUpdate) {
        context.dispatch({ type: "setAutoUpdate", value: autoUpdate });
      }
    }
    const current = normalizeUiLayout(context.state.uiLayout);
    const layoutToSave = normalizeUiLayout({
      ...current,
      sizes: { ...current.sizes, uiScale: uiScale === "" ? defaultUiLayout.sizes.uiScale : uiScale },
    });
    if (JSON.stringify(layoutToSave) !== JSON.stringify(current)) {
      context.dispatch({ type: "setUiLayout", layout: layoutToSave });
    }
    if (pageOpenAfterImport !== context.state.pageNavOpenAfterImport) {
      context.dispatch({ type: "setPageNavOpenAfterImport", value: pageOpenAfterImport });
    }
    if (normalizeMaxOpen(pageMaxOpen) !== context.state.pageNavMaxOpen) {
      context.dispatch({ type: "setPageNavMaxOpen", value: pageMaxOpen });
    }
    context.dispatch({ type: "updateShortcut", shortcut: shortcutDraft });
    closeModal();
  };

  const importSettings = async () => {
    const pathSelect = await window.cep.fs.showOpenDialogEx(true, false, null, null, ["json", "tpl"]);
    if (!pathSelect?.data?.length) return false;
    let foldersImported = 0;
    let backedUp = false;
    const importedStyles = [];
    for (const path of pathSelect.data) {
      const isToolPresetFile = /\.tpl$/i.test(path);
      const result = await window.cep.fs.readFile(path, isToolPresetFile ? window.cep.encoding.Base64 : undefined);
      if (result.err) {
        nativeAlert(locale.errorImportStyles, locale.errorTitle, true);
      } else {
        try {
          const data = validateImportData(isToolPresetFile ? toolPresetFileToImportData(result.data, path) : JSON.parse(result.data));
          if (data.incomplete) nativeAlert(locale.importTplPartial, locale.errorTitle, true);
          // A TypeR TextShapeR learning file: nothing this edition reads, and
          // it must never fall through to the full-settings import below
          if (data.typerTextShapeRTuning) throw new Error("format");
          if (!backedUp) {
            if (!backupStorage()) { nativeAlert(locale.storageWarning, locale.errorTitle, true); continue; }
            backedUp = true;
          }
          if (data.pastePointText === undefined && data.textItemKind !== undefined) {
            data.pastePointText = !!data.textItemKind;
          }
          if (data.exportedStyles) {
            const folderId = Math.random().toString(36).substring(2, 8);
            const importedAt = Date.now();
            const dataFolder = { id: folderId, name: data.name };
            const styles = data.exportedStyles.map((style) => ({
                ...serializeStyle(style),
                name: style.name,
                id: Math.random().toString(36).substring(2, 8),
                folder: folderId,
                textType: style.textType || "inherit",
                textProps: style.textProps,
                prefixes: style.prefixes || [],
                prefixColor: style.prefixColor,
                stroke: style.stroke,
                edited: importedAt,
            }));
            context.dispatch({ type: "importStyleFolder", folder: dataFolder, styles });
            importedStyles.push(...styles);
            foldersImported++;
          } else if (
            data.folders &&
            data.styles &&
            data.includesSettings !== true &&
            !data.ignoreLinePrefixes &&
            !data.ignoreTags &&
            !data.defaultStyleId &&
            !data.language &&
            !data.autoClosePSD &&
            !data.autoScrollStyle &&
            !data.pastePointText &&
            !data.textItemKind
          ) {
            const idMap = {};
            const foldersWithNewIds = data.folders.map((folder) => {
              const newId = Math.random().toString(36).substring(2, 8);
              idMap[folder.id] = newId;
              return { folder, newId };
            });
            const folders = foldersWithNewIds.map(({ folder, newId }) => ({
              id: newId,
              name: folder.name,
              parentId: folder.parentId ? idMap[folder.parentId] || null : null,
              order: typeof folder.order === "number" ? folder.order : undefined,
            }));
            const importedAt = Date.now();
            const styles = data.styles.map((style) => ({
              ...serializeStyle(style),
              id: Math.random().toString(36).substring(2, 8),
              name: style.name,
              folder: style.folder ? idMap[style.folder] : null,
              textType: style.textType || "inherit",
              textProps: style.textProps,
              prefixes: style.prefixes || [],
              prefixColor: style.prefixColor,
              stroke: style.stroke,
              edited: importedAt,
            }));
            context.dispatch({ type: "importStyleLibrary", folders, styles });
            importedStyles.push(...styles);
            foldersImported += folders.length;
          } else {
            const currentStyles = context.getState().styles;
            const keepExistingStyles = data.styles && hasStyleImportConflicts(currentStyles, data.styles)
              ? await new Promise(resolve => nativeConfirm(locale.settingsImportReplace, locale.confirmTitle, resolve))
              : false;
            context.dispatch({ type: "import", data, keepExistingStyles });
            setTimeout(() => reloadApp(), 100);
            closeModal();
          }
        } catch (error) {
          nativeAlert(error.message === NO_TEXT_PRESETS ? locale.importTplNoText : locale.errorImportStyles, locale.errorTitle, true);
        }
      }
    }
    if (foldersImported > 0) {
      const message = foldersImported > 1 ? locale.importFoldersSuccess : locale.importFolderSuccess;
      // An empty list means Photoshop's fonts are not known yet: no warning
      const installedFonts = getUserFonts();
      const missingFonts = installedFonts.length ? collectMissingStyleFonts(importedStyles, installedFonts) : [];
      if (missingFonts.length) setMissingFontsImport({ fonts: missingFonts, message });
      else nativeAlert(message, locale.successTitle, false);
    }
  };

  const exportSettings = () => {
    context.dispatch({ type: "setModal", modal: "export" });
  };

  const checkUpdatesNow = () => {
    checkUpdate(config.appVersion).then((data) => {
      if (data) {
        context.dispatch({ type: "setModal", modal: "update", data });
      } else {
        nativeAlert(locale.updateNoUpdate, locale.successTitle, false);
      }
    }).catch(() => nativeAlert(locale.updateCheckFailed, locale.errorTitle, true));
  };

  const resetStorage = () => {
    nativeConfirm(
      locale.settingsResetProfileConfirm,
      locale.confirmTitle || "Confirmation",
      (confirmed) => {
        if (!confirmed) return;
        const success = deleteStorageFile();
        if (success) {
          nativeAlert(locale.settingsResetProfileSuccess, locale.successTitle, false);
          setTimeout(() => reloadApp(), 300);
        } else {
          nativeAlert(locale.settingsResetProfileError, locale.errorTitle, true);
        }
      }
    );
  };

  const clearCache = () => {
    const size = formatCacheBytes(cacheInfo.bytes);
    nativeConfirm(
      (locale.settingsClearCacheConfirm || "Clear {size} of TypeR cache? Your texts, tabs, settings, styles, themes, and saved states will be kept.")
        .replace("{size}", size),
      locale.confirmTitle || "Confirmation",
      (confirmed) => {
        if (!confirmed) return;
        const result = clearTypeRCache();
        setCacheInfo(getTypeRCacheInfo());
        if (!result.supported) {
          nativeAlert(locale.settingsClearCacheError || "Unable to access the TypeR cache.", locale.errorTitle, true);
        } else if (result.ok) {
          nativeAlert(
            (locale.settingsClearCacheSuccess || "{size} of cache cleared.").replace("{size}", formatCacheBytes(result.clearedBytes)),
            locale.successTitle,
            false
          );
        } else {
          nativeAlert(
            (locale.settingsClearCachePartial || "{cleared} cleared; {remaining} is still in use. Restart Photoshop, then try again.")
              .replace("{cleared}", formatCacheBytes(result.clearedBytes))
              .replace("{remaining}", formatCacheBytes(result.remainingBytes)),
            locale.errorTitle,
            true
          );
        }
      }
    );
  };

  const resetShortcuts = () => {
    nativeConfirm(
      locale.settingsResetShortcutsConfirm || "Reset shortcuts to default?",
      locale.confirmTitle || "Confirmation",
      (confirmed) => {
        if (!confirmed) return;
        context.dispatch({ type: "resetShortcut" });
      }
    );
  };

  const tabs = [
    { id: "general", label: locale.settingsTabGeneral || "General", icon: FiSettings },
    { id: "shortcuts", label: locale.settingsTabShortcuts || "Shortcuts", icon: FaKeyboard },
    { id: "appearance", label: locale.settingsTabAppearance || "Appearance", icon: FiEye },
    { id: "data", label: locale.settingsTabData || "Data", icon: FiDatabase },
  ];

  const searchIndex = React.useMemo(() => buildSettingsSearchIndex({
    locale,
    baseLocale,
    tabs,
    shortcutGroups,
    themes: PRODUCT_THEMES.map(themeLabel),
    available: {
      updates: config.updatesEnabled === true,
      clearCache: cacheInfo.supported,
      keyboardAccess: keyboardAccess === "missing",
    },
  }), [shortcutGroups, cacheInfo.supported, keyboardAccess]);
  const searchResults = React.useMemo(() => searchSettings(searchIndex, searchQuery), [searchIndex, searchQuery]);

  const changeSearchQuery = (value) => {
    setSearchQuery(value);
    setSearchHighlight(0);
    const body = settingsFormRef.current && settingsFormRef.current.closest(".app-modal-body");
    if (body) body.scrollTop = 0;
  };

  const openSearchResult = (entry) => {
    setActiveTab(entry.tab);
    changeSearchQuery("");
    setSearchTarget({ ...entry });
    if (searchInputRef.current) searchInputRef.current.blur();
  };

  const handleSearchKeyDown = (e) => {
    if (e.key === "Escape") {
      if (!searchQuery) return;
      // The search is cleared first: the next Escape closes the window
      e.preventDefault();
      e.stopPropagation();
      changeSearchQuery("");
    } else if (!searching) {
      return;
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!searchResults.length) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setSearchHighlight((searchHighlight + step + searchResults.length) % searchResults.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (searchResults[searchHighlight]) openSearchResult(searchResults[searchHighlight].entry);
    }
  };

  // Shared markup for a toggle row (checkbox + label + optional hint). The
  // options that only matter while it is checked sit indented under it.
  const renderToggle = (checked, onChange, label, hint, children) => (
    <React.Fragment>
      <div className="settings-checkbox-item">
        <label className="settings-checkbox-label">
          <input type="checkbox" checked={checked} onChange={onChange} />
          <div className="settings-checkbox-custom"></div>
          <div className="settings-checkbox-content">
            <span>{label}</span>
            {hint ? <div className="settings-checkbox-hint">{hint}</div> : null}
          </div>
        </label>
      </div>
      {checked && children ? <div className="settings-checkbox-children">{children}</div> : null}
    </React.Fragment>
  );

  const renderTabContent = () => {
    switch (activeTab) {
      case "general":
        return (
          <div className="fields">
            <div className="settings-group">
              <div className="settings-group-title">{locale.settingsLanguageLabel}</div>
              <div className="field">
                <div className="field-input">
                  <select value={language} onChange={changeLanguage} className="topcoat-textarea">
                    {Object.entries(config.languages).map(([code, name]) => (
                      <option key={code} value={code}>
                        {code === "auto" ? locale.settingsLanguageAuto : name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
            <div className="settings-group">
              <div className="settings-group-title">{locale.settingsGroupPages}</div>
              <div className="settings-checkbox-grid">
                {renderToggle(
                  pageOpenAfterImport,
                  (e) => {
                    setPageOpenAfterImport(e.target.checked);
                    setEdited(true);
                  },
                  locale.settingsPageOpenAfterImport,
                  locale.settingsPageOpenAfterImportHint
                )}
              </div>
              <div className="field">
                <div className="field-label">{locale.settingsPageMaxOpen}</div>
                <div className="field-input">
                  <input
                    type="number"
                    min={MIN_MAX_OPEN}
                    max={MAX_MAX_OPEN}
                    className="topcoat-text-input"
                    value={pageMaxOpen}
                    onChange={(e) => {
                      setPageMaxOpen(e.target.value);
                      setEdited(true);
                    }}
                    onBlur={() => setPageMaxOpen(String(normalizeMaxOpen(pageMaxOpen)))}
                  />
                </div>
                <div className="field-descr">
                  {(locale.settingsPageMaxOpenHint || "")
                    .replace("{remind}", remindAt(pageMaxOpen))
                    .replace("{max}", normalizeMaxOpen(pageMaxOpen))}
                </div>
              </div>
            </div>
            {config.updatesEnabled && (
            <div className="settings-group">
              <div className="settings-group-title">{locale.settingsGroupAppUpdates || "Updates"}</div>
              <div className="settings-checkbox-grid">
                {renderToggle(
                  checkUpdates,
                  changeCheckUpdates,
                  locale.settingsCheckUpdatesLabel,
                  null,
                  renderToggle(
                    autoUpdate,
                    changeAutoUpdate,
                    locale.settingsAutoUpdateLabel || "Install updates automatically",
                    locale.settingsAutoUpdateHint || "New versions install silently in the background. TypeR reloads by itself, or at the next Photoshop restart when it cannot"
                  )
                )}
              </div>
              <div className="field">
                <button type="button" className="topcoat-button--large" onClick={checkUpdatesNow}>
                  {locale.settingsCheckUpdatesButton}
                </button>
              </div>
            </div>
            )}
            {cacheInfo.supported && (
            <div className="settings-group">
              <div className="settings-group-title">{locale.settingsGroupMaintenance || "Maintenance"}</div>
              <div className="field">
                <button
                  type="button"
                  className="topcoat-button--large"
                  onClick={clearCache}
                  disabled={cacheInfo.bytes === 0}
                >
                  <FiTrash2 size={18} /> {locale.settingsClearCache || "Clear cache"}
                </button>
              </div>
              <div className="field-descr">
                {(locale.settingsCacheAccumulated || "Accumulated cache: {size}")
                  .replace("{size}", formatCacheBytes(cacheInfo.bytes))}
              </div>
              <div className="field-descr">
                {locale.settingsClearCacheHint || "Deletes TypeR's temporary browser files without touching texts, tabs, settings, styles, themes, or saved states."}
              </div>
            </div>
            )}
          </div>
        );

      case "data":
        return (
          <React.Fragment>
            <ProfileSettings
              currentLanguage={context.state.language}
              hasUnsavedChanges={edited}
            />
            <div className="fields">
              <div className="settings-group">
                <div className="settings-group-title">{locale.settingsGroupImportExport || "Import/Export"}</div>
                <FontScanPromo />
                <div className="field">
                  <button type="button" className="topcoat-button--large" onClick={importSettings}>
                    <FaFileImport size={18} /> {locale.settingsImport}
                  </button>
                </div>
                <div className="field">
                  <button type="button" className="topcoat-button--large" onClick={exportSettings}>
                    <FaFileExport size={18} /> {locale.settingsExport}
                  </button>
                </div>
              </div>
              <div className="settings-group">
                <div className="settings-group-title">{locale.settingsGroupDanger || "Danger zone"}</div>
                <div className="field">
                  <button type="button" className="topcoat-button--large settings-danger-btn" onClick={resetStorage}>
                    {locale.settingsResetProfile}
                  </button>
                </div>
                <div className="field-descr">
                  {locale.settingsResetProfileHint}
                </div>
              </div>
            </div>
          </React.Fragment>
        );

      case "appearance": {
        const scaleValue = Math.min(150, Math.max(70, parseInt(uiScale, 10) || 100));
        return (
          <div className="fields">
            <div className="settings-group">
              <div className="settings-group-title">{locale.settingsGroupTheme || "Theme"}</div>
              <div className="settings-theme-grid">
                {PRODUCT_THEMES.map((theme) => {
                  const preview = getEditorThemePreviewColors(theme);
                  const isActive = editorTheme === theme.id;
                  const label = themeLabel(theme);
                  return (
                    <div className="settings-theme-cell" key={theme.id}>
                      <button
                        type="button"
                        className={"settings-theme-choice" + (isActive ? " m-active" : "")}
                        onClick={() => changeEditorTheme(theme.id)}
                        title={label}
                        style={{ "--theme-card-accent": preview.accent }}
                      >
                        <span className="settings-theme-preview" style={{ backgroundColor: preview.surface }}>
                          <span className="settings-theme-preview-bar" style={{ backgroundColor: preview.panel }}>
                            <i style={{ backgroundColor: preview.accent }} />
                            <i style={{ backgroundColor: preview.muted }} />
                          </span>
                          <span className="settings-theme-preview-line m-long" style={{ backgroundColor: preview.text }} />
                          <span className="settings-theme-preview-line" style={{ backgroundColor: preview.muted }} />
                          <span className="settings-theme-preview-pill" style={{ backgroundColor: preview.accent }} />
                          {isActive && (
                            <span
                              className="settings-theme-check"
                              style={{ backgroundColor: preview.accent, color: preview.accentText || preview.surface }}
                            >
                              <FiCheck size={10} />
                            </span>
                          )}
                        </span>
                        <span className="settings-theme-name">{label}</span>
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="settings-group">
              <div className="settings-layout-scale">
                <span className="settings-layout-scale-label">
                  <FiZoomIn size={13} />
                  {locale.settingsLayoutScaleLabel || "Interface scale"}
                </span>
                <input
                  type="range"
                  min="70"
                  max="150"
                  step="5"
                  value={scaleValue}
                  onChange={(e) => {
                    setUiScale(e.target.value);
                    setEdited(true);
                  }}
                />
                <span className="settings-layout-scale-value">{scaleValue}%</span>
                <button
                  type="button"
                  className="settings-layout-icon-btn"
                  disabled={scaleValue === defaultUiLayout.sizes.uiScale}
                  title={(locale.settingsLayoutScaleReset || "Back to {scale}%").replace("{scale}", defaultUiLayout.sizes.uiScale)}
                  onClick={() => {
                    setUiScale(String(defaultUiLayout.sizes.uiScale));
                    setEdited(true);
                  }}
                >
                  <FiRotateCcw size={11} />
                </button>
              </div>
            </div>
          </div>
        );
      }

      case "shortcuts":
        return (
          <div className="fields">
            <div className="settings-group">
              <div className="field-descr">
                {locale.settingsShortcutsHint || "Click a shortcut and press the new key combination."}
              </div>
            </div>
            {keyboardAccess === "missing" && (
              <div className="settings-group">
                <div className="field-descr">{locale.settingsKeyboardAccessText}</div>
                <div className="field">
                  <button type="button" className="topcoat-button--large" onClick={openKeyboardAccessSettings}>
                    {locale.settingsKeyboardAccessOpen}
                  </button>
                </div>
              </div>
            )}
            {shortcutGroups.map((group) => (
              <div className="settings-group" key={group.id}>
                <div className="settings-group-title">{group.label}</div>
                <div className="shortcut-list">
                  {group.commands.map((command) => (
                    <Shortcut
                      key={command.id}
                      value={shortcutDraft[command.id] || []}
                      index={command.id}
                      modifierOnly={command.modifierOnly === true}
                      onChange={changeShortcut}
                      conflict={shortcutConflicts[command.id]
                        ? (locale.shortcutConflict || "Also assigned to: {actions}")
                          .replace("{actions}", shortcutConflicts[command.id])
                        : ""}
                    />
                  ))}
                </div>
              </div>
            ))}
            <div className="settings-group">
              <div className="field">
                <button type="button" className="topcoat-button--large" onClick={resetShortcuts}>
                  <FiRotateCcw size={14} /> {locale.settingsResetShortcuts || "Reset shortcuts"}
                </button>
              </div>
              <div className="field-descr">
                {locale.settingsShortcutsTip || "If shortcuts feel buggy or stop working, resetting them often fixes it."}
              </div>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <React.Fragment>
      <div className="app-modal-header hostBrdBotContrast">
        <div className="app-modal-title settings-title">{locale.settingsTitle}</div>
        <div className="settings-search">
          <FiSearch size={14} />
          <input
            ref={searchInputRef}
            type="text"
            className="topcoat-textarea"
            spellCheck={false}
            value={searchQuery}
            placeholder={locale.settingsSearchPlaceholder}
            aria-label={locale.settingsSearchPlaceholder}
            onChange={(e) => changeSearchQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
          />
          {searchQuery ? (
            <button type="button" className="topcoat-icon-button--quiet" title={locale.fontViewerClearSearch} onClick={() => changeSearchQuery("")}>
              <FiX size={14} />
            </button>
          ) : null}
        </div>
        <button className="topcoat-icon-button--large--quiet" title={locale.close} onClick={close}>
          <FiX size={18} />
        </button>
      </div>
      <div className="app-modal-body">
        <div className="app-modal-body-inner">
          <div className="settings-tabs">
            {tabs.map((tab) => {
              const IconComponent = tab.icon;
              return (
                <button
                  key={tab.id}
                  className={`settings-tab ${activeTab === tab.id && !searching ? 'settings-tab--active' : ''}`}
                  title={tab.label}
                  onClick={() => {
                    setActiveTab(tab.id);
                    changeSearchQuery("");
                  }}
                >
                  <IconComponent size={16} />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </div>
          {searching && (
            <SettingsSearchResults
              query={searchQuery}
              results={searchResults}
              highlight={searchHighlight}
              onOpen={openSearchResult}
              onHighlight={setSearchHighlight}
            />
          )}
          {/* Stays mounted under the results: the tabs keep their own state */}
          <form
            ref={settingsFormRef}
            className={`settings-content${searching ? " settings-content--hidden" : ""}`}
            onSubmit={save}
          >
            {renderTabContent()}
            <div className="settings-actions hostBgdLight hostBrdTopContrast">
              {edited && (
                <span className="settings-unsaved">
                  {locale.settingsUnsavedChanges || "Unsaved changes"}
                </span>
              )}
              <button type="submit" className={edited ? "topcoat-button--large--cta" : "topcoat-button--large"}>
                <MdSave size={18} /> {locale.save}
              </button>
            </div>
          </form>
        </div>
        {missingFontsImport && (
          <MissingFontsDialog
            fonts={missingFontsImport.fonts}
            message={missingFontsImport.message}
            onClose={() => setMissingFontsImport(null)}
          />
        )}
        {discardConfirmOpen && (
          <UnsavedChangesDialog
            onConfirm={confirmClose}
            onCancel={() => setDiscardConfirmOpen(false)}
          />
        )}
      </div>
    </React.Fragment>
  );
});

export default SettingsModal;
