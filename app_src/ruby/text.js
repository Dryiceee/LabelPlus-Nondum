// Ruby (行间注): characters of a text layer's string.
//
// Photoshop counts a text layer's ranges (textStyleRange from/to) in UTF-16
// units; the ruby editor counts characters (code points), so a character
// outside the BMP is one character. Lines end with \r (\n and \u0003 in some
// descriptors).

export const chars = (text) => Array.from(String(text || ""));

const BREAK = /^[\r\n\u0003]$/;
const BLANK = /^[\s\u0003​-‍⁠﻿]$/u;

export const isLineBreak = (ch) => BREAK.test(ch);

// Characters that draw nothing: Create Work Path gives them no outline
export const isBlank = (ch) => !ch || BLANK.test(ch);

// UTF-16 offset of each character, plus the total length at the end
export function utf16Offsets(list) {
  const offsets = [];
  let at = 0;
  list.forEach((ch) => {
    offsets.push(at);
    at += ch.length;
  });
  offsets.push(at);
  return offsets;
}

// Full-width: CJK ideographs, kana, CJK punctuation, full-width forms. They
// take one em along the line; everything else counts as narrow.
const FULL_WIDTH = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f],
  [0xff00, 0xff60], [0xffe0, 0xffe6], [0x20000, 0x2fffd], [0x30000, 0x3fffd],
  [0x2014, 0x2014], [0x2025, 0x2026], [0x2018, 0x201d], [0x00b7, 0x00b7],
];

export function isFullWidth(ch) {
  const code = String(ch || "").codePointAt(0);
  if (code === undefined) return false;
  for (const [from, to] of FULL_WIDTH) if (code >= from && code <= to) return true;
  return false;
}

// Rough advance along the line, in ems (the editor's estimate; Apply measures)
export const advance = (ch) => (isBlank(ch) ? (ch === "　" ? 1 : 0.3) : isFullWidth(ch) ? 1 : 0.55);
