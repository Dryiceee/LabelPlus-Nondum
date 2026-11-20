// Development builds only (npm run build:uxp:dev): lets the test harness run
// code inside the plugin host or the panel, through files in a temporary
// folder. Never part of a release build.
const fs = require("fs");

// UXP's fs takes file: URLs on Windows (see files.js toUrl): C:\private\tmp\typer-uxp-dev
const DIR = require("os").platform() === "win32" ? "file:/C:/private/tmp/typer-uxp-dev/" : "/private/tmp/typer-uxp-dev/";
const PANEL_TIMEOUT_MS = 20000;

function writeResult(id, out) {
  try {
    fs.writeFileSync(DIR + "result-" + id + ".txt", String(out));
  } catch (error) {}
}

function start(postToPanel, onPanelResult) {
  // A command left from an earlier session never runs on load: replaying it
  // while the plugin starts (e.g. one that opens a modal window) crashed
  // Photoshop. Only commands written after this point run.
  let lastId = null;
  try {
    const stale = fs.readFileSync(DIR + "cmd.js", { encoding: "utf-8" });
    lastId = stale.slice(0, stale.indexOf("\n")).split(" ")[0];
  } catch (error) {}
  const panelWaiters = new Map();
  onPanelResult((message) => {
    const id = message.id;
    if (!panelWaiters.has(id)) return;
    clearTimeout(panelWaiters.get(id));
    panelWaiters.delete(id);
    writeResult(id, message.error ? "ERR " + message.error : JSON.stringify(message.result === undefined ? null : message.result));
  });
  setInterval(() => {
    let code = null;
    try {
      code = fs.readFileSync(DIR + "cmd.js", { encoding: "utf-8" });
    } catch (error) {
      return;
    }
    const newline = code.indexOf("\n");
    const header = code.slice(0, newline).split(" ");
    const id = header[0];
    const target = header[1] || "host";
    if (id === lastId) return;
    lastId = id;
    const body = code.slice(newline + 1);
    if (target === "panel") {
      panelWaiters.set(id, setTimeout(() => {
        panelWaiters.delete(id);
        writeResult(id, "TIMEOUT");
      }, PANEL_TIMEOUT_MS));
      postToPanel({ type: "devEval", id, code: body });
      return;
    }
    (async () => {
      try {
        const fn = new Function("require", "return (async () => {" + body + "\n})()");
        const result = await fn(__non_webpack_require__);
        writeResult(id, JSON.stringify(result === undefined ? null : result));
      } catch (error) {
        writeResult(id, "ERR " + ((error && (error.stack || error.message)) || error));
      }
    })();
  }, 100);
}

module.exports = { start };
