// Development channel: a command left in cmd.js from an earlier session must
// not run when the plugin loads (it once opened the SFX window during startup
// and crashed Photoshop); a command written afterwards runs once.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const files = {};
const fakeFs = {
  readFileSync(name) {
    if (!(name in files)) throw new Error("ENOENT");
    return files[name];
  },
  writeFileSync(name, text) { files[name] = String(text); },
};
let tick = null;
const ran = [];
const channel = { exports: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../uxp-src/host/devChannel.js"), "utf8"), {
  module: channel,
  require: (name) => (name === "fs" ? fakeFs : { platform: () => "win32" }),
  setInterval: (fn) => { tick = fn; },
  setTimeout, clearTimeout,
  __non_webpack_require__: () => {},
  globalThis: { ran },
});
const dir = "file:/C:/private/tmp/typer-uxp-dev/";
files[dir + "cmd.js"] = "old1 host\nglobalThis.ran.push('old'); return 1;";
channel.exports.start(() => {}, () => {});
tick();
tick();
assert.deepStrictEqual(ran, [], "the stale command is ignored");

files[dir + "cmd.js"] = "new1 host\nreturn 42;";
tick();
tick();
setTimeout(() => {
  assert.strictEqual(files[dir + "result-new1.txt"], "42", "a new command runs once");
  assert.ok(!(dir + "result-old1.txt" in files));
  console.log("Dev channel tests passed");
}, 50);
