// Settings window: the last tab the user looked at is restored, General
// opens the first time, and an unknown or removed tab never leaves it blank
const assert = require("assert");
const load = require("./helpers/loadAppModule")();
const tabs = load("app_src/settingsTab.js");

const memoryWindow = () => {
  const values = {};
  return {
    values,
    localStorage: {
      getItem: (key) => (Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null),
      setItem: (key, value) => {
        values[key] = String(value);
      },
    },
  };
};

assert.deepStrictEqual(tabs.SETTINGS_TABS, ["general", "shortcuts", "appearance", "data"]);
assert.strictEqual(tabs.DEFAULT_SETTINGS_TAB, "general");

const win = memoryWindow();
assert.strictEqual(tabs.readSettingsTab(win), "general", "General opens the first time");
tabs.writeSettingsTab("appearance", win);
assert.strictEqual(tabs.readSettingsTab(win), "appearance", "the last tab comes back");
tabs.writeSettingsTab("data", win);
assert.strictEqual(tabs.readSettingsTab(win), "data");

// Tabs of older versions, or anything else, are not written and read as General
tabs.writeSettingsTab("behavior", win);
assert.strictEqual(tabs.readSettingsTab(win), "data", "an unknown tab is not stored");
for (const removed of ["debug", "insertion", "script", "styles", "fontViewer"]) {
  win.values["typer.settingsTab"] = removed;
  assert.strictEqual(tabs.readSettingsTab(win), "general", "a removed tab falls back to General: " + removed);
}

// No storage (or a storage that throws) never breaks opening the settings
assert.strictEqual(tabs.readSettingsTab(null), "general");
assert.strictEqual(tabs.readSettingsTab({ localStorage: { getItem: () => { throw new Error("denied"); } } }), "general");
assert.doesNotThrow(() => tabs.writeSettingsTab("data", { localStorage: { setItem: () => { throw new Error("full"); } } }));

console.log("Settings tab memory tests passed");
