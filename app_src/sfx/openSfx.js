// The panel's "SFX editor" button: asks the UXP host to open the editor
// window on the selected layer (uxp-src/host/sfx.js) and reports why it could
// not, in the panel's language.
import { locale, nativeAlert } from "../utils";

const MESSAGES = {
  noDocument: ["sfxErrorNoDocument", "Open a document first."],
  selectOne: ["sfxErrorSelectOne", "Select a text layer, or an SFX shape layer (several are fine)."],
  notText: ["sfxErrorNotText", "Select a text layer, or an SFX shape layer made by the SFX editor."],
  emptyText: ["sfxErrorEmptyText", "The selected text layer is empty."],
  badPayload: ["sfxErrorBadPayload", "This layer's SFX settings were written by a newer version, or are damaged."],
  busy: ["sfxErrorBusy", "The SFX editor is already open."],
  noPanel: ["sfxErrorNoPanel", "Open the LabelPlus-Nondum panel first."],
  noOutlines: ["sfxErrorNoOutlines", "Photoshop cannot turn this text into paths (Type > Create Work Path is unavailable for it)."],
};

export const isSfxAvailable = () => typeof window !== "undefined" && !!window.typerUXP;

export function sfxErrorText(result) {
  const entry = MESSAGES[result && result.code];
  const base = entry ? locale[entry[0]] || entry[1] : (locale.sfxErrorFailed || "The SFX editor could not open.");
  return result && result.message && !entry ? base + "\n" + result.message : base;
}

let opening = false;

export async function openSfxEditor() {
  if (!isSfxAvailable() || opening) return;
  opening = true;
  try {
    const raw = await window.typerUXP.request("sfxOpen");
    let result = null;
    try {
      result = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch (error) {
      result = { ok: false, code: "failed", message: String(raw) };
    }
    if (result && !result.ok && result.code !== "busy") nativeAlert(sfxErrorText(result), locale.sfxTitle || "SFX", true);
  } catch (error) {
    nativeAlert(sfxErrorText({ code: "failed", message: String((error && error.message) || error) }), locale.sfxTitle || "SFX", true);
  } finally {
    opening = false;
  }
}
