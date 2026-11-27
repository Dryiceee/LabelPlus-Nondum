// The panel's "ruby" (行间注) button: asks the UXP host to open the ruby
// editor on the selected layer (uxp-src/host/ruby.js) and reports why it
// could not, in the panel's language.
import { locale, nativeAlert } from "../utils";

const MESSAGES = {
  noDocument: ["rubyErrorNoDocument", "Open a document first."],
  selectOne: ["rubyErrorSelectOne", "Select one text layer, or a ruby group."],
  notText: ["rubyErrorNotText", "Select a text layer, or a ruby group made by this editor."],
  emptyText: ["rubyErrorEmptyText", "The selected text layer is empty."],
  paragraph: ["rubyErrorParagraph", "Ruby notes work on point text only. Convert the layer to point text first."],
  warped: ["rubyErrorWarped", "Ruby notes do not work on warped text."],
  transformed: ["rubyErrorTransformed", "Ruby notes do not work on rotated, skewed or flipped text (scaled text is fine)."],
  noBase: ["rubyErrorNoBase", "This ruby group has lost its text layer."],
  badPayload: ["rubyErrorBadPayload", "A note in this group was written by a newer version, or is damaged."],
  busy: ["rubyErrorBusy", "The ruby editor is already open."],
  noPanel: ["rubyErrorNoPanel", "Open the LabelPlus-Nondum panel first."],
  noOutlines: ["rubyErrorNoOutlines", "Photoshop cannot turn this text into paths (Type > Create Work Path is unavailable for it)."],
  mismatch: ["rubyErrorMismatch", "Photoshop drew a different number of glyphs than the text has characters."],
};

export const isRubyAvailable = () => typeof window !== "undefined" && !!window.typerUXP;

export function rubyErrorText(result) {
  const entry = MESSAGES[result && result.code];
  const base = entry ? locale[entry[0]] || entry[1] : (locale.rubyErrorFailed || "The ruby editor could not open.");
  return result && result.message && (!entry || result.code === "mismatch" || result.code === "noOutlines") ? base + "\n" + result.message : base;
}

let opening = false;

export async function openRubyEditor() {
  if (!isRubyAvailable() || opening) return;
  opening = true;
  try {
    const raw = await window.typerUXP.request("rubyOpen");
    let result = null;
    try {
      result = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch (error) {
      result = { ok: false, code: "failed", message: String(raw) };
    }
    if (result && !result.ok && result.code !== "busy") nativeAlert(rubyErrorText(result), locale.rubyTitle || "Ruby", true);
  } catch (error) {
    nativeAlert(rubyErrorText({ code: "failed", message: String((error && error.message) || error) }), locale.rubyTitle || "Ruby", true);
  } finally {
    opening = false;
  }
}
