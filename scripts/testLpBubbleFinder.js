// Finding the bubble of a label on a raw page
// (app_src/labelplus/bubbleFinder.js). Synthetic pages, no Photoshop involved.
const assert = require("assert");
const load = require("./helpers/loadAppModule")();
const { toLuma, createPage, findBubble } = load("app_src/labelplus/bubbleFinder.js");
const { openedBox, outlinePath, chamberBoxes, placeShared, cleanOutline } = load("app_src/labelplus/bubbleShape.js");

const WIDTH = 800;
const HEIGHT = 1000;
const WHITE = 255;
const BLACK = 0;

function canvas(background) {
  const luma = new Uint8Array(WIDTH * HEIGHT).fill(background);
  const paint = (test, value) => {
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        if (test(x, y)) luma[y * WIDTH + x] = value;
      }
    }
  };
  return { luma, paint };
}
const inEllipse = (cx, cy, rx, ry) => (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
const inRect = (l, t, r, b) => (x, y) => x >= l && x < r && y >= t && y < b;
// A column of fake lettering: separate blocks, like the strokes of a raw page
const lettering = (paint, x, top, count, value) => {
  for (let i = 0; i < count; i++) paint(inRect(x, top + i * 30, x + 18, top + i * 30 + 18), value);
};
const page = (art) => createPage(art.luma, WIDTH, HEIGHT);
const nearlyCentred = (found, cx, cy) => {
  assert.ok(found, "a bubble was found");
  assert.ok(Math.abs((found.left + found.right) / 2 - cx) <= 3, "x centre " + found.left + "-" + found.right);
  assert.ok(Math.abs((found.top + found.bottom) / 2 - cy) <= 3, "y centre " + found.top + "-" + found.bottom);
};

// Black text on a white bubble, the label point on a stroke of the lettering
{
  const art = canvas(128);
  art.paint(inEllipse(400, 500, 150, 220), BLACK);
  art.paint(inEllipse(400, 500, 145, 215), WHITE);
  lettering(art.paint, 391, 400, 7, BLACK);
  const found = findBubble(page(art), { x: 400, y: 408 }, { fontPixels: 24 });
  nearlyCentred(found, 400, 500);
  assert.ok(found.value >= 200, "the white interior, not the stroke or the ring");
}

// White text on a black bubble: the same page with the polarity flipped
{
  const art = canvas(128);
  art.paint(inEllipse(400, 500, 150, 220), WHITE);
  art.paint(inEllipse(400, 500, 145, 215), BLACK);
  lettering(art.paint, 391, 400, 7, WHITE);
  const found = findBubble(page(art), { x: 400, y: 408 }, { fontPixels: 24 });
  nearlyCentred(found, 400, 500);
  assert.ok(found.value <= 55, "the black interior");
}

// The point between two strokes still finds the bubble
{
  const art = canvas(128);
  art.paint(inEllipse(300, 300, 120, 160), WHITE);
  lettering(art.paint, 291, 220, 5, BLACK);
  nearlyCentred(findBubble(page(art), { x: 300, y: 244 }, { fontPixels: 20 }), 300, 300);
}

// A white bubble in a black panel: the panel around it is not the bubble, even
// if the nearest dark pixel belongs to it
{
  const art = canvas(WHITE);
  art.paint(inRect(100, 100, 700, 500), BLACK);
  art.paint(inEllipse(400, 300, 120, 150), WHITE);
  nearlyCentred(findBubble(page(art), { x: 400, y: 300 }, { fontPixels: 20 }), 400, 300);
}

// A label on open artwork finds nothing: the layer stays where it is
{
  const art = canvas(WHITE);
  assert.strictEqual(findBubble(page(art), { x: 400, y: 500 }, { fontPixels: 20 }), null);
}

// A grey bubble with no pure light or dark pixel near the point
{
  const art = canvas(40);
  art.paint(inEllipse(400, 500, 140, 180), 150);
  nearlyCentred(findBubble(page(art), { x: 400, y: 500 }, { fontPixels: 20, radius: 60 }), 400, 500);
}

// A big stroke of the lettering still loses to the bubble: only one bigger than
// twice the text size could qualify, and the interior is checked by shape
{
  const art = canvas(128);
  art.paint(inEllipse(400, 500, 150, 220), WHITE);
  art.paint(inRect(380, 480, 420, 520), BLACK);
  nearlyCentred(findBubble(page(art), { x: 400, y: 500 }, { fontPixels: 24 }), 400, 500);
}

// An outline ring alone fills too little of its box to count
{
  const art = canvas(WHITE);
  art.paint(inEllipse(400, 500, 150, 220), BLACK);
  art.paint(inEllipse(400, 500, 144, 214), 90);
  const found = findBubble(page(art), { x: 400, y: 500 }, { fontPixels: 20 });
  assert.ok(found && found.value === 90, "the interior, not the ring");
}

// The counter of a glyph: the nearest light pixel is a closed speck
{
  const art = canvas(128);
  art.paint(inEllipse(400, 500, 150, 220), WHITE);
  art.paint(inRect(380, 480, 420, 520), BLACK);
  art.paint(inRect(397, 497, 403, 503), WHITE);
  nearlyCentred(findBubble(page(art), { x: 400, y: 500 }, { fontPixels: 24 }), 400, 500);
}

// A caption leaking through a thin white gap into the margin keeps its own box
{
  const art = canvas(WHITE);
  art.paint(inRect(100, 100, 700, 800), 128);
  art.paint(inRect(200, 200, 400, 600), WHITE);
  art.paint(inRect(399, 300, 700, 304), WHITE);
  nearlyCentred(findBubble(page(art), { x: 300, y: 400 }, { fontPixels: 24 }), 300, 400);
}

// A double bubble with lettering: each label gets its chamber, whatever the
// strokes do; two labels in one plain bubble stay together
{
  const art = canvas(128);
  art.paint(inEllipse(300, 300, 110, 140), WHITE);
  art.paint(inEllipse(400, 620, 130, 190), WHITE);
  art.paint(inRect(330, 400, 370, 480), WHITE);
  lettering(art.paint, 291, 220, 5, BLACK);
  lettering(art.paint, 391, 500, 7, BLACK);
  const canvasPage = page(art);
  const first = findBubble(canvasPage, { x: 300, y: 228 }, { fontPixels: 24 });
  const second = findBubble(canvasPage, { x: 400, y: 508 }, { fontPixels: 24 });
  assert.strictEqual(first.key, second.key, "one connected bubble");
  const parts = placeShared(canvasPage, first, [{ x: 300, y: 228 }, { x: 400, y: 508 }], 72);
  assert.ok(parts, "the neck cuts it");
  const middle = (part) => (isFinite(part.yMid) ? part.yMid : (part.top + part.bottom) / 2);
  assert.ok(Math.abs(middle(parts[0]) - 300) <= 20, "upper chamber " + middle(parts[0]));
  assert.ok(Math.abs(middle(parts[1]) - 620) <= 20, "lower chamber " + middle(parts[1]));
  // A path TypeR's engine accepts: a plain closed outline of few points
  const anchors = outlinePath(canvasPage, first).pathContents.pathComponents[0].subpathListKey[0].points;
  assert.ok(anchors.length > 8 && anchors.length < 400, anchors.length + " outline points");
  const plain = canvas(128);
  plain.paint(inEllipse(400, 500, 150, 220), WHITE);
  const single = page(plain);
  const bubble = findBubble(single, { x: 400, y: 400 }, {});
  assert.strictEqual(placeShared(single, bubble, [{ x: 400, y: 400 }, { x: 400, y: 600 }], 72), null);
  assert.strictEqual(chamberBoxes(single, bubble, [{ x: 400, y: 400 }, { x: 400, y: 600 }], 72), null);
}

// A tail does not pull the centre, as with TypeR's opening
{
  const art = canvas(128);
  art.paint(inEllipse(400, 400, 120, 160), WHITE);
  art.paint(inRect(500, 390, 700, 402), WHITE);
  const tailed = page(art);
  const bubble = findBubble(tailed, { x: 400, y: 400 }, {});
  const box = openedBox(tailed, bubble, { x: 400, y: 400 });
  assert.ok(box.right <= 530, "the tail is cut: " + box.right);
  assert.ok(Math.abs((box.left + box.right) / 2 - 400) <= 5, "centred on the body");
}

// Spikes of a flash bubble, wider than the leak test above: same
{
  const art = canvas(BLACK);
  art.paint(inEllipse(400, 400, 100, 180), WHITE);
  for (let i = 0; i < 3; i++) art.paint(inRect(480, 300 + i * 90, 660, 318 + i * 90), WHITE);
  const flash = page(art);
  const bubble = findBubble(flash, { x: 400, y: 400 }, {});
  const box = openedBox(flash, bubble, { x: 400, y: 400 });
  assert.ok(Math.abs((box.left + box.right) / 2 - 400) <= 8, "centred without the spikes: " + box.left + "-" + box.right);
}

// Reading RGB and RGBA pixels
{
  const rgb = toLuma(new Uint8Array([255, 255, 255, 0, 0, 0]), 3, 2, 1);
  assert.ok(rgb[0] >= 254);
  assert.strictEqual(rgb[1], 0);
  const rgba = toLuma(new Uint8Array([255, 255, 255, 9, 0, 0, 0, 9]), 4, 2, 1);
  assert.ok(rgba[0] >= 254);
  assert.strictEqual(rgba[1], 0);
  assert.deepStrictEqual(Array.from(toLuma(new Uint8Array([7, 8]), 1, 2, 1)), [7, 8]);
}

// Whitening: the bubble with its lettering, contracted, in its own colour
{
  const contains = (polygon, x, y) => {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [xi, yi] = polygon[i];
      const [xj, yj] = polygon[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const whiteBubble = () => {
    const art = canvas(128);
    art.paint(inEllipse(400, 500, 150, 220), BLACK);
    art.paint(inEllipse(400, 500, 145, 215), WHITE);
    lettering(art.paint, 391, 400, 7, BLACK);
    return page(art);
  };
  const white = whiteBubble();
  const plan = cleanOutline(white, findBubble(white, { x: 400, y: 408 }, { fontPixels: 24 }));
  assert.ok(!plan.skip, "a plain white bubble is whitened");
  assert.strictEqual(plan.inset, 3);
  assert.deepStrictEqual(plan.color, { red: 255, green: 255, blue: 255 });
  assert.ok(contains(plan.polygon, 400, 408) && contains(plan.polygon, 400, 560), "the lettering is inside the fill");
  assert.ok(!contains(plan.polygon, 400, 280 - 2) && !contains(plan.polygon, 560, 500), "the outline is outside it");
  assert.ok(plan.box.left >= 250 && plan.box.right <= 550 && plan.box.top >= 280 && plan.box.bottom <= 720);

  // The colour of the page, read from its RGB when there is one: off-white paper
  const paper = whiteBubble();
  paper.components = 3;
  paper.rgb = new Uint8Array(WIDTH * HEIGHT * 3);
  for (let at = 0; at < WIDTH * HEIGHT; at++) {
    const value = paper.luma[at];
    paper.rgb.set(value === WHITE ? [250, 246, 238] : [value, value, value], at * 3);
  }
  assert.deepStrictEqual(cleanOutline(paper, findBubble(paper, { x: 400, y: 408 }, { fontPixels: 24 })).color, { red: 250, green: 246, blue: 238 });

  // A black bubble keeps further from its outline
  const art = canvas(128);
  art.paint(inEllipse(400, 500, 150, 220), WHITE);
  art.paint(inEllipse(400, 500, 145, 215), BLACK);
  lettering(art.paint, 391, 400, 7, WHITE);
  const black = page(art);
  const dark = cleanOutline(black, findBubble(black, { x: 400, y: 408 }, { fontPixels: 24 }));
  assert.strictEqual(dark.inset, 5);
  assert.deepStrictEqual(dark.color, { red: 0, green: 0, blue: 0 });

  // Screentone (light but not plain) is left alone
  const tone = canvas(128);
  tone.paint(inEllipse(400, 500, 150, 220), BLACK);
  tone.paint(inEllipse(400, 500, 145, 215), 210);
  lettering(tone.paint, 391, 400, 7, BLACK);
  const toned = page(tone);
  assert.deepStrictEqual(cleanOutline(toned, findBubble(toned, { x: 400, y: 408 }, { fontPixels: 24 })), { skip: "cleanTone" });

  // A sound effect labelled on a black panel: the panel is found, but it holds
  // a white bubble, which is no lettering and must not be painted over
  const panel = canvas(128);
  panel.paint(inRect(150, 100, 650, 800), BLACK);
  panel.paint(inEllipse(400, 330, 110, 150), WHITE);
  lettering(panel.paint, 391, 260, 5, BLACK);
  const panelPage = page(panel);
  const panelBubble = findBubble(panelPage, { x: 400, y: 720 }, { fontPixels: 24 });
  assert.ok(panelBubble && panelBubble.high <= 55, "the black panel is taken for the bubble");
  assert.deepStrictEqual(cleanOutline(panelPage, panelBubble, { fontPixels: 24 }), { skip: "cleanNested" });
  // ...while the white bubble itself is whitened, lettering and all
  assert.ok(!cleanOutline(panelPage, findBubble(panelPage, { x: 400, y: 300 }, { fontPixels: 24 }), { fontPixels: 24 }).skip);

  // An open area along the page edges is left alone
  const open = canvas(WHITE);
  open.paint(inRect(0, 600, WIDTH, HEIGHT), 128);
  const edge = page(open);
  const region = { low: 200, high: 255, left: 0, top: 0, right: WIDTH, bottom: 600, seedX: 400, seedY: 300 };
  assert.deepStrictEqual(cleanOutline(edge, region), { skip: "cleanLarge" });
}

console.log("LabelPlus bubble finder tests passed");
