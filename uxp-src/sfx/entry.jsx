// SFX editor page (plugin:/sfx/index.html), shown by uxp-src/host/sfx.js in
// a modal dialog. Talks to the host over the WebView message bridge, the way
// the panel does (uxp-src/web/bridge.js): JSON strings both ways.
import React from "react";
import ReactDOM from "react-dom";
import SfxEditor from "../../app_src/sfx/editor/SfxEditor";
import "../../app_src/sfx/editor/sfxEditor.scss";

const pending = new Map();
let nextId = 1;
let started = false;

function send(message) {
  const host = window.uxpHost;
  if (!host) throw new Error("the plugin host is not reachable");
  host.postMessage(JSON.stringify(message));
}

const bridge = {
  request(method, ...args) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      try {
        send({ type: "request", id, method, args });
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  },
  apply(state) { send({ type: "apply", state }); },
  cancel() { send({ type: "cancel" }); },
  reopen(state, chars) { send({ type: "reopen", state, chars }); },
};

function start(init) {
  if (started) return;
  started = true;
  document.documentElement.classList.toggle("sfx-light", init.theme === "light" || init.theme === "lightest");
  ReactDOM.render(<SfxEditor init={init} bridge={bridge} />, document.getElementById("sfx-root"));
}

window.addEventListener("message", (event) => {
  let message = event.data;
  for (let depth = 0; typeof message === "string" && depth < 2; depth++) {
    try {
      message = JSON.parse(message);
    } catch (error) {
      return;
    }
  }
  if (!message || typeof message !== "object") return;
  if (message.type === "init") start(message.init);
  else if (message.type === "reply") {
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    if (message.error !== undefined) {
      const error = new Error(message.error);
      error.modal = !!message.modal;
      task.reject(error);
    } else task.resolve(message.result);
  }
});

window.addEventListener("error", (event) => {
  try {
    send({ type: "log", text: String(event.message || event.error) });
  } catch (error) {}
});

// The host may attach its listener after this page started: ask until it answers
(function ready(attempt) {
  if (started || attempt > 100) return;
  try {
    send({ type: "ready" });
  } catch (error) {}
  setTimeout(() => ready(attempt + 1), 300);
})(0);
