// Page bar rules (app_src/pageNav/pageNavLogic.js): which pages a project has,
// which page closes past the limit, when the reminder shows, the recent list.
// No Photoshop involved.
const assert = require("assert");
const load = require("./helpers/loadAppModule")();

const nav = load("app_src/pageNav/pageNavLogic.js");

// Pages: PSDs only, in natural order
assert.deepStrictEqual(
  nav.projectPages([
    { name: "10.psd" },
    { name: "2.PSD" },
    { name: "1.psd" },
    { name: "cover.png" },
    { name: "sub", isFolder: true },
    { name: "labelplus-nondum.json" },
  ]),
  ["1.psd", "2.PSD", "10.psd"]
);
assert.deepStrictEqual(nav.projectPages(null), []);

assert.strictEqual(nav.folderName("C:\\manga\\ch01\\PSD\\"), "PSD");
assert.strictEqual(nav.folderName("C:/manga/ch01"), "ch01");
assert.strictEqual(nav.joinPath("C:\\a\\", "1.psd"), "C:\\a\\1.psd");
assert.ok(nav.samePath("C:\\A\\1.psd", "c:/a/1.PSD"));

// The limit
assert.strictEqual(nav.normalizeMaxOpen(undefined), 20);
assert.strictEqual(nav.normalizeMaxOpen("3"), 6);
assert.strictEqual(nav.normalizeMaxOpen(500), 99);
assert.strictEqual(nav.remindAt(20), 15);
assert.strictEqual(nav.remindAt(6), 1);

// Under the limit nothing closes
const names = (count) => Array.from({ length: count }, (_, i) => i + 1 + ".psd");
assert.deepStrictEqual(nav.pagesToClose({ open: names(19), target: "20.psd", maxOpen: 20 }), []);
// The target already open does not count twice
assert.deepStrictEqual(nav.pagesToClose({ open: names(20), target: "5.psd", maxOpen: 20 }), []);

// Opening the 21st closes the page looked at longest ago, never the kept ones
const viewed = {};
names(20).forEach((name, i) => { viewed[name] = 100 + i; });
viewed["1.psd"] = 500; // looked at again lately
assert.deepStrictEqual(
  nav.pagesToClose({ open: names(20), target: "21.psd", keep: ["20.psd"], lastViewed: viewed, maxOpen: 20 }),
  ["2.psd"]
);
// A page never looked at from the bar goes first
assert.deepStrictEqual(
  nav.pagesToClose({ open: names(20).concat("x.psd"), target: "21.psd", keep: [], lastViewed: viewed, maxOpen: 20 }),
  ["x.psd", "2.psd"]
);
// The current page is kept even when it is the oldest
assert.deepStrictEqual(
  nav.pagesToClose({ open: names(6), target: "7.psd", keep: ["1.psd"], lastViewed: {}, maxOpen: 6 }),
  ["2.psd"]
);

// 24 pages opened at once by hand, none looked at from the bar: the earliest
// opened close first (Photoshop's order, not the names), never the active one
const byHand = ["9.psd", "3.psd"].concat(names(24).filter((name) => name !== "9.psd" && name !== "3.psd"));
assert.deepStrictEqual(
  nav.pagesToClose({ open: byHand, target: byHand[23], keep: [byHand[23]], lastViewed: {}, maxOpen: 20 }),
  byHand.slice(0, 4)
);
assert.ok(nav.pagesToClose({ open: byHand, target: "3.psd", keep: ["3.psd"], lastViewed: {}, maxOpen: 20 }).indexOf("3.psd") < 0);

// The reminder: once, from the mark on
assert.strictEqual(nav.shouldRemind(14, 20, false), false);
assert.strictEqual(nav.shouldRemind(15, 20, false), true);
assert.strictEqual(nav.shouldRemind(18, 20, true), false);

// Recent projects: newest first, one per folder, ten at most
let recent = [];
for (let i = 0; i < 12; i++) recent = nav.rememberProject(recent, "C:\\ch" + i, "1.psd", i);
assert.strictEqual(recent.length, nav.RECENT_LIMIT);
assert.strictEqual(recent[0].folder, "C:\\ch11");
recent = nav.rememberProject(recent, "c:/CH5", "7.psd", 99);
assert.strictEqual(recent[0].page, "7.psd");
assert.strictEqual(recent.filter((item) => nav.samePath(item.folder, "C:\\ch5")).length, 1);
assert.strictEqual(nav.lastPageOf(recent, "C:\\ch5"), "7.psd");
assert.strictEqual(nav.lastPageOf(recent, "C:\\none"), "");
assert.strictEqual(nav.forgetProject(recent, "C:\\ch5").length, recent.length - 1);
assert.deepStrictEqual(nav.normalizeRecent([null, { folder: "" }, { folder: "C:\\a", page: 3 }]), [{ folder: "C:\\a", page: "", at: 0 }]);

// Where a project starts
const pages = ["1.psd", "2.psd", "3.psd"];
assert.strictEqual(nav.startIndex(pages, "3.PSD", "2.psd"), 2);
assert.strictEqual(nav.startIndex(pages, "", "2.psd"), 1);
assert.strictEqual(nav.startIndex(pages, "gone.psd", "gone.psd"), 0);

assert.strictEqual(nav.pageIndexOfPath("C:\\ch\\PSD", pages, "c:/ch/psd/2.psd"), 1);
assert.strictEqual(nav.pageIndexOfPath("C:\\ch\\PSD", pages, "C:\\other\\2.psd"), -1);
assert.strictEqual(nav.pageIndexOfPath("C:\\ch\\PSD", pages, ""), -1);

// A project goes by the folder holding the chosen one
assert.strictEqual(nav.projectName("C:\\manga\\ch02\\psd"), "ch02");
assert.strictEqual(nav.projectName("C:\\manga\\ch02\\PSD\\"), "ch02");
assert.strictEqual(nav.projectName("C:\\manga\\ch03\\output"), "ch03");
assert.strictEqual(nav.projectName("D:/scans/ch04/done"), "ch04");
// Right under a drive there is no folder above: its own name
assert.strictEqual(nav.projectName("C:\\psd"), "psd");

// Several projects open: which one the bar shows
const ch1 = { folder: "C:\\m\\ch1\\psd", pages: ["1.psd", "2.psd", "3.psd"] };
const ch2 = { folder: "C:\\m\\ch2\\psd", pages: ["1.psd", "2.psd"] };
const p = (project, name) => project.folder + "\\" + name;
// The active document's project wins, even when another one is shown
let settled = nav.settleProjects({ projects: [ch1, ch2], open: [p(ch1, "1.psd"), p(ch2, "2.psd")], active: p(ch2, "2.psd"), shownFolder: ch1.folder, shownIndex: 0 });
assert.deepStrictEqual(settled.show, { folder: ch2.folder, index: 1 });
assert.deepStrictEqual(settled.keep, [ch1.folder, ch2.folder]);
assert.deepStrictEqual(settled.counts, { [ch1.folder]: 1, [ch2.folder]: 1 });
// A document outside every project: the shown project stays, on its page
settled = nav.settleProjects({ projects: [ch1, ch2], open: [p(ch1, "1.psd"), p(ch2, "2.psd")], active: "C:\\other.psd", shownFolder: ch1.folder, shownIndex: 2 });
assert.deepStrictEqual(settled.show, { folder: ch1.folder, index: 2 });
// The shown project has nothing open any more: the other one, on its page opened last
settled = nav.settleProjects({ projects: [ch1, ch2], open: [p(ch2, "1.psd"), p(ch2, "2.psd")], active: "", shownFolder: ch1.folder, shownIndex: 0 });
assert.deepStrictEqual(settled.show, { folder: ch2.folder, index: 1 });
assert.deepStrictEqual(settled.keep, [ch2.folder], "a project with no page open is dropped");
// Nothing open anywhere: back to the project list
settled = nav.settleProjects({ projects: [ch1, ch2], open: [], active: "", shownFolder: ch1.folder, shownIndex: 0 });
assert.strictEqual(settled.show, null);
assert.deepStrictEqual(settled.keep, []);
// The limit counts every project: the page looked at longest ago, whichever project
assert.deepStrictEqual(
  nav.pagesToClose({ open: ["a1", "b1", "a2", "b2", "a3", "b3"], target: "b4", keep: ["b3"], lastViewed: { a1: 5, b1: 1, a2: 6, b2: 7, a3: 8, b3: 9 }, maxOpen: 6 }),
  ["b1"]
);

console.log("Page bar tests passed");
