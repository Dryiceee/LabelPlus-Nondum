// Loads the TextShapeR engine, once
let enginePromise = null;
export const loadTextShapeREngine = () => {
  if (!enginePromise) enginePromise = import(/* webpackChunkName: "text-shaper-engine" */ "./textShapeR");
  return enginePromise;
};
