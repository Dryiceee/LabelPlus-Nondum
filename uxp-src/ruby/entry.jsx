// Ruby (行间注) editor page (plugin:/ruby/index.html), shown by
// uxp-src/host/ruby.js in a modal dialog. Talks to the host over the WebView
// message bridge: JSON strings both ways.
import React from "react";
import ReactDOM from "react-dom";
import RubyEditor from "../../app_src/ruby/editor/RubyEditor";
import "../../app_src/ruby/editor/rubyEditor.scss";

let started = false;

function send(message) {
  const host = window.uxpHost;
  if (!host) throw new Error("the plugin host is not reachable");
  host.postMessage(JSON.stringify(message));
}

const bridge = {
  apply(state) { send({ type: "apply", state }); },
  cancel() { send({ type: "cancel" }); },
};

function start(init) {
  if (started) return;
  started = true;
  document.documentElement.classList.toggle("rb-light", init.theme === "light" || init.theme === "lightest");
  ReactDOM.render(<RubyEditor init={init} bridge={bridge} />, document.getElementById("ruby-root"));
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
  // Development builds: the live check drives the window (scripts/rubyLiveCheck.js)
  else if (message.type === "dev" && process.env.TYPER_DEV === "1") {
    let result = null;
    try {
      const dev = window.__rubyDev;
      result = dev && dev[message.op] ? dev[message.op](...(message.args || [])) : { error: "no " + message.op };
    } catch (error) {
      result = { error: String((error && error.message) || error) };
    }
    send({ type: "devResult", op: message.op, result });
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
