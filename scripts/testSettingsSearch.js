// Settings search: the index stays in step with the settings window, and the
// ranking finds a setting by its title, its description, a synonym, an English
// word in a translated interface, or a typo.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const load = require("./helpers/loadAppModule")();
const search = load("app_src/settingsSearch.js");

const root = path.resolve(__dirname, "..");

const readLocale = (relativePath) => {
  const values = {};
  fs.readFileSync(path.resolve(root, relativePath), "utf8").split(/\r?\n/).forEach((line) => {
    if (!line || line.startsWith("#") || line.startsWith(" ")) return;
    const at = line.indexOf("=");
    if (at > 0) values[line.slice(0, at)] = line.slice(at + 1);
  });
  return values;
};

const en = readLocale("locale/messages.properties");
const fr = { ...en, ...readLocale("locale/fr_FR/messages.properties") };

const TAB_IDS = ["general", "shortcuts", "appearance", "data"];
const tabKey = (id) => "settingsTab" + id[0].toUpperCase() + id.slice(1);
const makeTabs = (strings, disabled = []) => TAB_IDS.map((id) => ({ id, label: strings[tabKey(id)], disabled: disabled.includes(id) }));

const commandsSource = fs.readFileSync(path.resolve(root, "app_src/shortcutCommands.js"), "utf8");
const commandLabels = ["shortcut_center", "shortcut_applyStyle", "shortcut_increase", "shortcut_decrease"];
assert.ok(commandLabels.every((label) => commandsSource.includes('label: "' + label + '"')));

const makeIndex = (strings, options = {}) => search.buildSettingsSearchIndex({
  locale: strings,
  baseLocale: en,
  tabs: makeTabs(strings, options.disabled),
  shortcutGroups: [{ labelKey: "settingsTabShortcuts", commands: commandLabels.map((label) => ({ label })) }],
  themes: options.themes || [],
  available: options.available || {},
});

const indexFr = makeIndex(fr);
const indexEn = makeIndex(en);
assert(!indexFr.some((entry) => entry.tab === "debug"));
const titles = (index, query) => search.searchSettings(index, query).map((result) => result.entry.title);
const first = (index, query) => titles(index, query)[0];

// Every key of the index exists; read from the source, since the built entries
// hold the translated text
const source = fs.readFileSync(path.resolve(root, "app_src/settingsSearch.js"), "utf8");
const sectionsSource = source.slice(source.indexOf("const SECTIONS"), source.indexOf("const TAB_HINTS"));
const indexedKeys = new Set();
[...sectionsSource.matchAll(/\b(?:title|hint|group|parent|anchor): "([A-Za-z0-9_]+)"/g)].forEach((match) => indexedKeys.add(match[1]));
[...sectionsSource.matchAll(/also: \[([^\]]*)\]/g)].forEach((match) => {
  [...match[1].matchAll(/"([A-Za-z0-9_]+)"/g)].forEach((key) => indexedKeys.add(key[1]));
});
const unknownKeys = [...indexedKeys].filter((key) => !en[key]);
assert.deepStrictEqual(unknownKeys, [], `Keys of the search index missing from the locale: ${unknownKeys.join(", ")}`);

// Every setting shown in the window is indexed. A new setting that should not
// be searchable belongs in this list, with the reason.
const NOT_SEARCHED = new Set([
  "settingsGroupTheme", // Themes are indexed by name, under this group
  "settingsLayoutScaleReset", // Tooltip of the reset button of the scale
]);
const settingsSource = fs.readFileSync(path.resolve(root, "app_src/components/modal/settings.jsx"), "utf8");
const render = settingsSource.slice(settingsSource.indexOf("const renderTabContent"));
const shownKeys = new Set(
  [...render.matchAll(/locale\.((?:settings[A-Za-z0-9]*(?:Label|Help|Descr|Hint|Button|Note)|settingsLayout(?:El|Block)[A-Za-z0-9]+|settingsGroup[A-Za-z0-9]+|multiBubbleMode(?:Toggle|Hint)))\b/g)].map((match) => match[1])
);
const notIndexed = [...shownKeys].filter((key) => !indexedKeys.has(key) && !NOT_SEARCHED.has(key));
assert.deepStrictEqual(notIndexed, [], `Settings missing from the search index (app_src/settingsSearch.js): ${notIndexed.join(", ")}`);

// Titles, French interface
assert.strictEqual(first(indexFr, fr.settingsLanguageLabel), fr.settingsLanguageLabel, "a full title comes first");
assert.strictEqual(first(indexFr, fr.settingsTabShortcuts), fr.settingsTabShortcuts, "a tab name opens the tab first");
assert.ok(titles(indexFr, fr.settingsTabShortcuts).length > 3, "and lists what it holds");

// Case, accents and ligatures do not count
assert.strictEqual(first(indexFr, "THEME"), first(indexFr, "thème"));

// Synonyms that the setting text lacks, small words, any order
assert.ok(titles(indexFr, "zoom").includes(fr.settingsLayoutScaleLabel), "zoom");
assert.ok(titles(indexFr, "sauvegarde").includes(fr.settingsExport), "sauvegarde");
assert.ok(titles(indexEn, "scale interface").includes(en.settingsLayoutScaleLabel), "any order");
assert.strictEqual(first(indexEn, en.shortcut_center), en.shortcut_center, "exact shortcut name");

// Typos, only when nothing matches as written
assert.ok(titles(indexEn, "lnaguage").includes(en.settingsLanguageLabel), "swapped letters");
assert.deepStrictEqual(titles(indexEn, "zzzzqqq"), [], "nothing for nonsense");

// The settings of hidden or removed features are not offered
for (const key of ["settingsSmartPasteLabel", "settingsMarkdownLabel", "settingsInternalPaddingLabel", "settingsShowTipsLabel", "settingsUxpMigrationButton", "settingsLayoutReset"]) {
  assert.ok(!titles(indexEn, en[key]).includes(en[key]), key);
}
assert.ok(!indexEn.some((entry) => ["insertion", "script", "styles", "fontViewer"].includes(entry.tab)));

// What cannot be used is not offered: updates while this edition has none
assert.ok(!titles(indexEn, en.settingsCheckUpdatesLabel).includes(en.settingsCheckUpdatesLabel));
assert.ok(titles(makeIndex(en, { available: { updates: true } }), en.settingsCheckUpdatesLabel).includes(en.settingsCheckUpdatesLabel));
assert.ok(titles(makeIndex(fr, { available: { updates: true } }), "mise à jour").includes(fr.settingsCheckUpdatesLabel), "mise à jour");

// Dynamic entries: themes and shortcuts
const withThemes = makeIndex(en, { themes: ["Midnight Ink"] });
assert.strictEqual(first(withThemes, "midnight"), "Midnight Ink");
assert.ok(titles(indexEn, en.shortcut_applyStyle).length > 0);

// An empty search shows nothing
assert.deepStrictEqual(search.searchSettings(indexEn, ""), []);
assert.deepStrictEqual(search.searchSettings(indexEn, "   "), []);
assert.deepStrictEqual(search.searchSettings(indexEn, "?!"), []);

// The highlight lands on the original characters, accents included
const marked = (text, terms) => search.splitHighlights(text, terms).filter((piece) => piece.match).map((piece) => piece.text);
assert.deepStrictEqual(marked("Césure du thème", ["cesure", "theme"]), ["Césure", "thème"]);
assert.deepStrictEqual(marked("Cœur de texte", ["coeur"]), ["Cœur"]);
assert.deepStrictEqual(marked("Start art", ["art"]), ["art"], "the start of a word first");
assert.deepStrictEqual(marked("Restart", ["art"]), ["art"], "else inside a word");
assert.deepStrictEqual(marked("Restart", ["ar"]), [], "but not for a short word");
assert.strictEqual(search.splitHighlights("Texte libre", ["texte"]).map((piece) => piece.text).join(""), "Texte libre", "no character lost");
assert.deepStrictEqual(search.splitHighlights("", ["a"]), []);

// Other alphabets go through the same path
const ru = { ...en, ...readLocale("locale/ru_RU/messages.properties") };
const indexRu = makeIndex(ru);
assert.strictEqual(first(indexRu, ru.settingsLanguageLabel), ru.settingsLanguageLabel);
const ar = { ...en, ...readLocale("locale/ar_AE/messages.properties") };
const indexAr = makeIndex(ar);
assert.strictEqual(first(indexAr, ar.settingsLanguageLabel), ar.settingsLanguageLabel);

console.log("Settings search tests passed");
