import { getUserFonts } from "./utils";

const CJK_RE = /[㐀-鿿豈-﫿]/;

// Chinese names of installed fonts, for the style names FontScanR proposes.
// Photoshop's own font list already holds them when it shows font names in
// the interface language; the plugin host reads the rest from the name table
// of the font files. Resolves to { postScriptName: name }, never rejects.
const getChineseFontNames = async (postScriptNames) => {
  const wanted = Array.from(new Set((postScriptNames || []).filter(Boolean)));
  const result = {};
  if (!wanted.length) return result;
  const wantedSet = new Set(wanted);
  (getUserFonts() || []).forEach((font) => {
    if (font && wantedSet.has(font.postScriptName) && CJK_RE.test(font.name || "") && !result[font.postScriptName]) {
      result[font.postScriptName] = font.name;
    }
  });
  const missing = wanted.filter((name) => !result[name]);
  if (!missing.length || typeof window === "undefined" || !window.typerUXP) return result;
  try {
    const fromFiles = await window.typerUXP.request("localFontNames", { postScriptNames: missing });
    Object.keys(fromFiles || {}).forEach((postScriptName) => {
      if (wantedSet.has(postScriptName) && fromFiles[postScriptName]) result[postScriptName] = fromFiles[postScriptName];
    });
  } catch (error) {
    // The English names stay
  }
  return result;
};

export { getChineseFontNames };
