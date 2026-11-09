// The files of a LabelPlus-Nondum release, in Releases/, each with a .sha256:
// - LabelPlus-Nondum-win.ccx, LabelPlus-Nondum-mac.ccx: double-click to install
//   through Creative Cloud.
// - LabelPlus-Nondum.zip: the installers (install_win.cmd, install_mac.command)
//   with both packages, for a Photoshop without Creative Cloud, and the
//   updaters (installer/update_win.cmd, installer/update_mac.sh). get.ps1 and
//   get.sh download it.
// The names carry no version, so that .../releases/latest/download/<name>
// always finds the latest; the version is the release's tag (for example 1.0.0).
// Run through `npm run package:release`, after both packages are built and verified.
//
// The build keeps TypeR's package names (UXP-Windows.ccx, TypeR-UXP.ccx) because
// its update code knows them; only the published files carry the product name.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { zipSync, unzipSync } = require("fflate");

const root = path.resolve(__dirname, "..");
const pkg = require(path.join(root, "package.json"));
const releases = path.join(root, "Releases");
const PLUGIN_ID = "com.dryiceee.labelplus-nondum";
const packages = [
  ["UXP-Windows.ccx", "LabelPlus-Nondum-win.ccx"],
  ["TypeR-UXP.ccx", "LabelPlus-Nondum-mac.ccx"],
];

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const publish = (name, bytes) => {
  const target = path.join(releases, name);
  fs.writeFileSync(target, bytes);
  const hash = sha256(bytes);
  fs.writeFileSync(target + ".sha256", hash + "  " + name + "\n");
  console.log(name + "  " + (bytes.length / 1024 / 1024).toFixed(2) + " MB  sha256 " + hash);
};

const archive = {};
for (const [built, named] of packages) {
  const source = path.join(releases, built);
  if (!fs.existsSync(source)) throw new Error("Missing " + built + ": run the package builds first");
  const bytes = fs.readFileSync(source);
  const manifest = JSON.parse(Buffer.from(unzipSync(bytes, { filter: (entry) => entry.name === "manifest.json" })["manifest.json"]).toString("utf8"));
  if (manifest.id !== PLUGIN_ID || manifest.version !== pkg.version) throw new Error(built + " is not LabelPlus-Nondum " + pkg.version);
  publish(named, bytes);
  archive[named] = bytes;
}

// The installers find the package of their system next to them (installer/install.ps1,
// installer/install_mac.sh); the macOS scripts keep their executable mode
// The updaters (installer/update_win.cmd, installer/update_mac.sh) run the
// one-line installers, get.ps1 and get.sh, kept beside them
const archived = {
  "install_win.cmd": "install_win.cmd",
  "install_mac.command": "install_mac.command",
  "installer/install.ps1": "installer/install.ps1",
  "installer/install_mac.sh": "installer/install_mac.sh",
  "installer/update_win.cmd": "installer/update_win.cmd",
  "installer/update_mac.sh": "installer/update_mac.sh",
  "installer/get.ps1": "get.ps1",
  "installer/get.sh": "get.sh",
  "README.md": "README.md",
  "LICENSE.md": "LICENSE.md",
  "CHANGELOG.md": "CHANGELOG.md",
};
for (const [name, source] of Object.entries(archived)) archive[name] = fs.readFileSync(path.join(root, source));
const entries = {};
Object.keys(archive).forEach((name) => {
  entries[name] = /\.(sh|command)$/.test(name) ? [archive[name], { os: 3, attrs: 0o100755 << 16 }] : archive[name];
});
publish("LabelPlus-Nondum.zip", Buffer.from(zipSync(entries, { level: 9 })));
