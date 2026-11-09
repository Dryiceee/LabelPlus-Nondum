// LabelPlus-Nondum's Windows installer: which version is recommended, the
// transaction (testInstallWindows.ps1) and what the release ships. The arrow
// menu itself needs a terminal and is tested by hand. LabelPlus-Nondum is
// Windows only: elsewhere, only the files are checked.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const windows = process.platform === 'win32';

const runInstaller = (args, env) => spawnSync(
  'powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'installer', 'install.ps1'), ...args],
  { encoding: 'utf8', input: '', env: { ...process.env, TYPER_INSTALL_SOURCE: root, ...env } },
);

const recommendation = (versions) => {
  // Windows PowerShell 5.1 drops empty environment values. A separator alone
  // represents an explicitly empty fixture without searching the real machine.
  const result = runInstaller([], { TYPER_INSTALL_PROBE: 'recommendation', TYPER_PHOTOSHOP_VERSIONS: versions === '' ? ';' : versions });
  assert.strictEqual(result.status, 0, result.stderr + result.stdout);
  return /recommended=(.*)/.exec(result.stdout)[1].trim();
};

if (windows) {
  assert.strictEqual(recommendation('Photoshop 2026=27.7.0'), 'uxp');
  assert.strictEqual(recommendation('Photoshop 2025=26.0.0'), 'uxp', 'the first version UXP runs on');
  assert.strictEqual(recommendation('Photoshop 2024=25.12.0'), 'legacy', 'too old for UXP');
  assert.strictEqual(recommendation('Photoshop 2021=22.5.0;Photoshop 2026=27.7.0'), 'uxp', 'the newest one decides');
  assert.strictEqual(recommendation('Photoshop 2026=27.7.0;Photoshop 2021=22.5.0'), 'uxp', 'in any order');
  assert.strictEqual(recommendation(''), '', 'no Photoshop, no recommendation');
  assert.strictEqual(recommendation('Photoshop='), '', 'a version that cannot be read');

  // The search itself never stops the installer, whatever this machine has
  const searched = runInstaller([], { TYPER_INSTALL_PROBE: 'recommendation', TYPER_PHOTOSHOP_VERSIONS: undefined });
  assert.strictEqual(searched.status, 0, searched.stderr + searched.stdout);

  // What install_win.cmd and get.ps1 ask for: the plugin, never TypeR's Legacy panel
  const chosen = runInstaller(['-Uxp'], { TYPER_INSTALL_PROBE: 'choice', TYPER_PHOTOSHOP_VERSIONS: 'Photoshop 2026=27.7.0' });
  assert.strictEqual(chosen.status, 0, chosen.stderr + chosen.stdout);
  assert.match(chosen.stdout, /edition=uxp/);

  // The transaction, through isolated PowerShell fixtures, including a
  // simulated open Photoshop. Never touches Adobe installs.
  const checked = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'testInstallWindows.ps1')], { encoding: 'utf8', env: process.env });
  assert.strictEqual(checked.status, 0, checked.stderr + checked.stdout);
  process.stdout.write(checked.stdout);
}

// At the root of the release archive, one file to run
const archived = /const archived = \{([\s\S]*?)\};/.exec(fs.readFileSync(path.join(__dirname, 'packageRelease.js'), 'utf8'))[1];
assert.deepStrictEqual(archived.match(/^\s*"([^"/]+\.(?:cmd|command|sh|ps1))":/gm).map((line) => line.trim()), ['"install_win.cmd":']);

// The PowerShell messages exist in every language
const winBytes = fs.readFileSync(path.join(root, 'installer', 'install.ps1'));
assert.deepStrictEqual([...winBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'Windows PowerShell 5.1 misreads accents without a byte order mark');
const winText = winBytes.toString('utf8');
for (const name of ['title', 'uxp_name', 'legacy_name', 'recommended', 'keys', 'cancelled', 'ps_found', 'ps_none', 'uxp_too_old', 'status_update', 'status_current', 'status_newer', 'choose_update', 'updated']) {
  assert.strictEqual(winText.split(`$msg_${name} = `).length - 1, 5, name);
}
assert.ok(/^[\x00-\x7f]*$/.test(fs.readFileSync(path.join(root, 'get.ps1'), 'utf8')), 'get.ps1 stays ASCII');
assert.ok(/^[\x00-\x7f]*$/.test(fs.readFileSync(path.join(root, 'installer', 'update_win.cmd'), 'utf8')), 'update_win.cmd stays ASCII');

// The double-click installer and the one-line installer install the plugin only,
// from the package of the release archive, and never rename TypeR's own panel
assert.ok(fs.readFileSync(path.join(root, 'install_win.cmd'), 'utf8').includes('install.ps1" -Uxp %*'));
assert.ok(fs.readFileSync(path.join(root, 'get.ps1'), 'utf8').includes("install.ps1') -Uxp"));
assert.ok(fs.readFileSync(path.join(root, 'get.ps1'), 'utf8').includes('LabelPlus-Nondum.zip'));
assert.ok(winText.includes("Join-Path $ScriptDir 'LabelPlus-Nondum-win.ccx'"));
assert.ok(!/^\s*Rename-TypeRLegacyPanel\s*$/m.test(winText));
console.log('Installer tests passed' + (windows ? '' : ' (files only: the installer is for Windows)'));
