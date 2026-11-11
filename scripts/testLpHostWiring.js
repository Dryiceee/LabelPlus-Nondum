// The LabelPlus host runs only inside Photoshop, so a misspelled helper would
// surface there first: every helper it uses must be exported by photoshop.js,
// and every host call of the window must exist. No Photoshop involved.
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const read = (name) => fs.readFileSync(path.join(__dirname, "..", name), "utf8");
const unique = (values) => [...new Set(values)];

const hostSource = read("uxp-src/host/labelplus.js");
const photoshopSource = read("uxp-src/host/photoshop.js");
const internals = photoshopSource.slice(photoshopSource.indexOf("_internals: {"));

const destructured = /const \{([^}]+)\} = host;/.exec(hostSource)[1].split(",").map((name) => name.trim());
const used = unique([...hostSource.matchAll(/\bhost\.(\w+)/g)].map((match) => match[1]).concat(destructured));
assert.ok(used.length > 10, "the helpers were found");
used.forEach((name) => assert.ok(new RegExp("\\b" + name + "\\b").test(internals), "photoshop.js does not export " + name));

const methods = /methods: \{([^}]+)\}/.exec(hostSource)[1].split(",").map((name) => name.trim());
methods.forEach((name) => assert.ok(new RegExp("function " + name + "\\b").test(hostSource), "no function " + name));
assert.ok(read("uxp-src/host/main.js").includes("...labelplus.methods"), "main.js exposes the LabelPlus calls");

const panelCalls = unique(
  ["app_src/components/modal/labelPlus.jsx", "app_src/labelplus/chapterRun.js", "app_src/pageNav/pageNav.js"]
    .flatMap((file) => [...read(file).matchAll(/(?:callHost|host\.call)\("(\w+)"/g)].map((match) => match[1]))
);
assert.ok(panelCalls.length >= 5, "the panel calls were found");
panelCalls.forEach((name) => assert.ok(methods.includes(name), "the host has no " + name));

// Every code the checklist can show has a message
const messages = read("locale/messages.properties");
const zhMessages = read("locale/zh_CN/messages.properties");
const codes = unique(
  ["uxp-src/host/labelplus.js", "app_src/labelplus/chapterRun.js", "app_src/labelplus/importPlan.js", "app_src/labelplus/lpParser.js"]
    .flatMap((file) => [...read(file).matchAll(/(?:code: |failure\(|warn\()"(\w+)"/g)].map((match) => match[1]))
).filter((code) => !["header", "noImages", "read", "write", "list", "selection", "align"].includes(code));
assert.ok(codes.length > 15, "the issue codes were found");
codes.forEach((code) => {
  assert.ok(messages.includes("lpIssue_" + code + "="), "no English message for " + code);
  assert.ok(zhMessages.includes("lpIssue_" + code + "="), "no Chinese message for " + code);
});

console.log("LabelPlus host wiring tests passed");
