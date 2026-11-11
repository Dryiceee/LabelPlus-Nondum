# Changelog

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
