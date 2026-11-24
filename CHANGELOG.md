# Changelog

## 1.2.2

- SFX editor: several layers at once. Select text layers (or SFX layers made earlier) and click the lightning button: all of them open together. Each is drawn on the page; click one, or pick it from the layer list (PageUp / PageDown), to edit it. Each keeps its own settings and undo. Apply writes every layer in one history step, so one undo reverts them all; Cancel leaves them all as they were. Layers in the selection that are not text or SFX layers are left out, with a note in the editor.
- A text layer scaled with free transform now gives the size the Character panel shows (75.4 pt, not the 18 pt Photoshop stores before the transform), leading and baseline shift included: in a style made from the layer, in the style editor and in FontScanR.

## 1.2.0

- SFX editor (the lightning button at the bottom of the panel), modelled on TypeR Studio's SFX tool: lays out the selected Chinese text layer as a sound effect along a line, an arc or a hand-drawn path, with spacing, character rotation and first/last character sizes, and per-character move, rotate and resize.
- Select characters with a marquee, a click or Shift+click to edit just those. The diamond in the middle of a selection bends only that stretch; an end square dragged with a selection bends the path where the selection starts, and the characters before it stay put.
- Bends add Bézier anchors: click one to show its handles, drag them into an S curve, Alt+drag to move one side only. Reshaping the path leaves the characters outside the changed part where they are.
- Apply replaces the text layer by one native shape layer in its place, drawn from Photoshop's own outlines of the font (holes kept); the fill colour and anchors stay editable in Photoshop. One undo reverts an Apply; Cancel leaves the document as it was.
- The settings are saved with the PSD in the layer's metadata, so the layer opens again in the editor; a layer moved in Photoshop is followed.

## 1.1.1

- Folder locks: every folder, Unsorted included, locks and unlocks from its header or its right-click menu. A locked folder keeps its styles: none can be deleted, edited or moved in or out.
- Unsorted is a folder like the others, with every folder action. Styles without a folder land in it.
- Right-click a folder to delete it; Shift+click deletes its styles too.
- Several styles at once: Ctrl+click adds or removes one, Shift+click takes a run of one folder. The chosen styles move by drag, and copy, paste and delete together from the right-click menu.
- FontScanR names the proposed styles after the fonts' Chinese names in a Chinese interface, and keeps every layer style of the scanned layers (drop shadow, glows, overlays…), as a style made from a layer does.
- Layer styles set to use the global light are read with the document's angle, so a style made from a layer shows and applies the angle Photoshop shows. Styles saved before keep the old angle until read again.
- The LabelPlus window no longer has "Try on the open document".

## 1.1.0

1.0.0 has no update in the panel: update it once by hand, with `installer\update_win.cmd` from LabelPlus-Nondum.zip or by installing again. From 1.1.0 on, new versions are offered in the panel.

- Page bar under Align: pick a folder of PSDs (the last LabelPlus import's, or any) and turn through it with ◀ ▶ or a page list. The project goes by the name of the folder holding it; recent projects are listed when none is open.
- A page turn saves the page left behind and keeps it open, so its history stays. A reminder comes five pages before the limit (20 open pages by default, set in Settings); past it, the page looked at longest ago is saved and closed. Files opened by hand count too.
- Several projects at once: the bar follows the active document, the limit counts every project, and closing a project asks first.
- Previous and next page shortcuts, the last page of each project remembered, and the first page opened after a LabelPlus import (a setting).
- PSDs a LabelPlus import is about to overwrite are closed first without saving, after asking.
- Updates: LabelPlus-Nondum checks this repository's releases once a day and offers to install a newer version. Automatic installation stays off unless you turn it on in Settings.

## 1.0.0

First release of LabelPlus-Nondum, built on TypeR 3.0.1. Windows only.

- Import a LabelPlus translation into a whole chapter of PSDs: one layer group per LabelPlus group, vertical point text, the translator's line breaks kept, each page opened once.
- A style per group, chosen in the import window, which holds the full style editor.
- Centring in the bubble from the label point: tails are ignored, connected bubbles are split by label, and text that does not fit stays centred at its size.
- Whitening per group: the bubble and its lettering filled with the bubble's own colour on a layer of its own. Screentone, grey and nested areas are left alone and reported.
- Text replacements as options, with defaults and your own rules.
- Align in the main panel centres each selected text layer on its own bubble.
- Styles keep every layer style (drop shadow, glows, overlays…) beside the stroke, and a style can be made from a selected text layer.
- Settings reduced to General, Shortcuts, Appearance and Data; TypeR's script, smart paste, guides and help are hidden or removed.
- Simplified Chinese interface.

TypeR's own history is at https://github.com/ScanR/TypeR/blob/master/CHANGELOG.md.
