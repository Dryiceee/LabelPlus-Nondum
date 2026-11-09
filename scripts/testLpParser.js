// LabelPlus text files (app_src/labelplus/lpParser.js). No Photoshop involved.
const assert = require("assert");
const load = require("./helpers/loadAppModule")();
const { parseLpText, parseTextReplace, applyTextReplace, LpParseError } = load("app_src/labelplus/lpParser.js");

const FILE = [
  "﻿1,0",
  "-",
  "框内",
  "框外",
  "-",
  "可以在这里写注释",
  "",
  ">>>>>>>>[001.jpg]<<<<<<<<",
  "----------------[1]----------------[0.25,0.5,1]",
  "第一行",
  "  第二行  ",
  "",
  "----------------[2]----------------[0.75,0.125,2]",
  "拟声词",
  "",
  ">>>>>>>>[002.png]<<<<<<<<",
  "",
].join("\r\n");

// The whole format: BOM, CRLF, groups, translator line breaks
{
  const lp = parseLpText(FILE);
  assert.deepStrictEqual(lp.version, [1, 0]);
  assert.deepStrictEqual(lp.groups, ["框内", "框外"]);
  assert.strictEqual(lp.comment, "可以在这里写注释");
  assert.deepStrictEqual(lp.images.map((image) => image.name), ["001.jpg", "002.png"]);
  const [first, second] = lp.images[0].labels;
  assert.strictEqual(first.text, "第一行\n第二行");
  assert.strictEqual(first.x, 0.25);
  assert.strictEqual(first.y, 0.5);
  assert.strictEqual(first.group, "框内");
  assert.strictEqual(first.groupIndex, 0);
  assert.strictEqual(second.group, "框外");
  assert.strictEqual(lp.images[1].labels.length, 0);
  assert.deepStrictEqual(lp.warnings, []);
}

const body = (markers) => "1,0\n-\nA\n-\nnote\n" + markers;

// Group names and comments may hold "-"
{
  const lp = parseLpText("1,0\n-\n框-内\n-\na-b-c\n>>>>>>[1.jpg]<<<<<<\n");
  assert.deepStrictEqual(lp.groups, ["框-内"]);
  assert.strictEqual(lp.comment, "a-b-c");
}

// Short markers count from six characters, shorter lines are text
{
  const lp = parseLpText(body(">>>>>>[1.jpg]<<<<<<\n------[1]------[0.1,0.2,1]\n-----\n>>> 不是标记\n"));
  assert.strictEqual(lp.images[0].labels[0].text, "-----\n>>> 不是标记");
}

// Odd labels are reported, never dropped
{
  const lp = parseLpText(body(">>>>>>[1.jpg]<<<<<<\n孤儿\n------[1]------[0.1,0.2,9]\n文\n------[2]------[1.5,-1,1]\n文\n------[3]------[x,y,1]\n\n"));
  assert.deepStrictEqual(lp.warnings.map((warning) => warning.code), ["orphanText", "unknownGroup", "positionOffPage", "badPosition", "emptyLabel"]);
  const [unknown, offPage, broken] = lp.images[0].labels;
  assert.strictEqual(unknown.groupIndex, -1);
  assert.deepStrictEqual([offPage.x, offPage.y], [1, 0]);
  assert.deepStrictEqual([broken.x, broken.y], [0.5, 0.5]);
}

// A repeated image keeps one entry, and later versions are flagged
{
  const lp = parseLpText("2,0\n-\nA\n-\n\n>>>>>>[1.jpg]<<<<<<\n------[1]------[0,0,1]\na\n>>>>>>[1.jpg]<<<<<<\n------[2]------[0,0,1]\nb\n");
  assert.strictEqual(lp.images.length, 1);
  assert.strictEqual(lp.images[0].labels.length, 2);
  assert.deepStrictEqual(lp.warnings.map((warning) => warning.code), ["version", "duplicateImage"]);
}

// Files that are not LabelPlus text stop with a code the panel can translate
assert.throws(() => parseLpText("随便一段文字"), (error) => error instanceof LpParseError && error.code === "noImages");
assert.throws(() => parseLpText(">>>>>>[1.jpg]<<<<<<\n"), (error) => error.code === "header");

// Text replacement
assert.deepStrictEqual(parseTextReplace("A->B|C->D|"), [{ from: "A", to: "B" }, { from: "C", to: "D" }]);
assert.deepStrictEqual(parseTextReplace(""), []);
assert.strictEqual(parseTextReplace("A"), null);
assert.strictEqual(parseTextReplace("->B"), null);
assert.strictEqual(applyTextReplace("A!A", [{ from: "A", to: "AA" }]), "AA!AA");
assert.strictEqual(applyTextReplace("...", [{ from: "...", to: "…" }]), "…");

console.log("LabelPlus parser tests passed");
