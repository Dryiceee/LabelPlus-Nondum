// TypeR styles applied to LabelPlus layers. Manga text is vertical point text,
// while a stored style says "horizontal": what a style decides is the look of
// the text, never the layer's direction or shape. Pure.

const SHAPE_KEYS = ["orientation", "textShape", "textClickPoint", "textKey", "bounds", "boundingBox"];

const clone = (value) => JSON.parse(JSON.stringify(value));

// A copy of the style that carries no direction, shape or text of its own, and
// one style range: the first, as the style editor keeps it
function lookOnlyStyle(style) {
  const copy = clone(style);
  const layerText = copy.textProps && copy.textProps.layerText;
  if (!layerText) return copy;
  SHAPE_KEYS.forEach((key) => delete layerText[key]);
  if (layerText.textStyleRange) layerText.textStyleRange = layerText.textStyleRange.slice(0, 1);
  if (layerText.paragraphStyleRange) layerText.paragraphStyleRange = layerText.paragraphStyleRange.slice(0, 1);
  return copy;
}

// The text properties that make a new layer: a box as large as the page, so no
// line wraps before the host turns it into point text, as TypeR always does.
// `text` uses \r line breaks; sizes are in points.
function newLayerProps(style, text, orientation, widthPoints, heightPoints) {
  const props = lookOnlyStyle(style).textProps;
  const layerText = props.layerText;
  layerText.textKey = text;
  layerText.textStyleRange[0].from = 0;
  layerText.textStyleRange[0].to = text.length;
  layerText.paragraphStyleRange[0].from = 0;
  layerText.paragraphStyleRange[0].to = text.length;
  layerText.orientation = orientation;
  layerText.textShape = [{
    textType: "box",
    orientation,
    bounds: { top: 0, left: 0, right: widthPoints, bottom: heightPoints },
  }];
  return props;
}

export { lookOnlyStyle, newLayerProps };
