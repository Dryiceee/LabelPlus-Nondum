// The files of a LabelPlus-Nondum release, in Releases/, each with a .sha256:
// - LabelPlus-Nondum-win.ccx: double-click to install through Creative Cloud.
// - LabelPlus-Nondum.zip: the installer (install_win.cmd) with the package, for
//   a Photoshop without Creative Cloud, and the updater (installer/update_win.cmd).
//   get.ps1 downloads it.
// LabelPlus-Nondum is Windows only.
// The names carry no version, so that .../releases/latest/download/<name>
// always finds the latest; the version is the release's tag (for example 1.0.0).
// Run through `npm run package:release`, after both packages are built and verified.
//
// The build keeps TypeR's package name (UXP-Windows.ccx) because
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

// The installer finds the package next to it (installer/install.ps1). The
// updater (installer/update_win.cmd) runs the one-line installer, get.ps1,
// kept beside it.
const archived = {
  "install_win.cmd": "install_win.cmd",
  "installer/install.ps1": "installer/install.ps1",
  "installer/update_win.cmd": "installer/update_win.cmd",
  "installer/get.ps1": "get.ps1",
  "README.md": "README.md",
  "LICENSE.md": "LICENSE.md",
  "CHANGELOG.md": "CHANGELOG.md",
};
for (const [name, source] of Object.entries(archived)) archive[name] = fs.readFileSync(path.join(root, source));
publish("LabelPlus-Nondum.zip", Buffer.from(zipSync(archive, { level: 9 })));
