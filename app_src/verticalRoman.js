// Photoshop's Standard Vertical Roman Alignment (Character panel menu). On,
// half-width characters such as Latin letters, digits and "!?" stand upright
// in vertical text; off, they lie on their side. ActionManager keeps it in
// each run's baselineDirection: "withStream" on, "rotated" off ("crossStream"
// is tate-chu-yoko). Measured on Photoshop 28: ten Tahoma "A" at 100 px in
// vertical text make a column 973 px tall with "withStream" (upright) and
// 602 px with "rotated" (on their side). New styles have it on. Pure.

const VERTICAL_ROMAN_ON = "withStream";
const VERTICAL_ROMAN_OFF = "rotated";

const isStandardVerticalRoman = (textProps) => {
  const ranges = (textProps && textProps.layerText && textProps.layerText.textStyleRange) || [];
  return !!(ranges[0] && ranges[0].textStyle && ranges[0].textStyle.baselineDirection === VERTICAL_ROMAN_ON);
};

// Changes textProps in place and returns it
const setStandardVerticalRoman = (textProps, on) => {
  const ranges = (textProps && textProps.layerText && textProps.layerText.textStyleRange) || [];
  ranges.forEach((range) => {
    if (range && range.textStyle) range.textStyle.baselineDirection = on ? VERTICAL_ROMAN_ON : VERTICAL_ROMAN_OFF;
  });
  return textProps;
};

export { VERTICAL_ROMAN_OFF, VERTICAL_ROMAN_ON, isStandardVerticalRoman, setStandardVerticalRoman };
