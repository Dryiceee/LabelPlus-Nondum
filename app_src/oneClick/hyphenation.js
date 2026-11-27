// Fallback hyphenation for the smart paste, used only when a translation
// does not fit even at the smallest allowed size. French only, on TextShapeR's
// syllable boundaries; English words no longer break (the hyphen pattern
// library is gone).

import { frenchHyphenPoints } from "../textShapeR";
import { detectLanguage } from "../textShapeRLanguage";

// "fr", "en" or "off"; "auto" follows the script, which can be in another
// language than the interface. The interface settles what the script does not.
export const resolveHyphenationLanguage = (setting, uiLanguage, script) => {
  if (setting === "fr" || setting === "en" || setting === "off") return setting;
  const language = detectLanguage(script);
  if (language === "fr" || language === "en") return language;
  return /^fr/i.test(String(uiLanguage || "")) ? "fr" : "en";
};

// The break point function for a language, or null (no hyphenation)
export const breakPointsFor = (language) => {
  if (language === "fr") return (word) => frenchHyphenPoints(word);
  return null;
};
