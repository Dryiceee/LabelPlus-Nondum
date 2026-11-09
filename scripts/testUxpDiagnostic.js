const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { createDiagnosticLog } = require('../uxp-src/host/diagnosticLog');
const root = path.resolve(__dirname, '..');
const log = createDiagnosticLog({ photoshop: '27.7' }, ['C:\\Users\\Alice']);
log.note('error', 'C:\\Users\\Alice\\x and C:/Users/Alice/y');
assert(!log.snapshot().includes('Alice'));
log.note('error', 'C:/USERS/ALICE/x https://example.test/?token=SECRET');
assert(!log.snapshot().includes('ALICE') && !log.snapshot().includes('SECRET'));
log.note('huge', 'x'.repeat(10000));
assert.strictEqual(JSON.parse(log.snapshot()).events[2].detail.length, 1800);
for (let i = 0; i < 1100; i++) log.note('test', i);
assert.strictEqual(JSON.parse(log.snapshot()).events.length, 1000);
assert.strictEqual(JSON.parse(log.snapshot()).dropped, 103);

// The inline diagnostic must parse even if the main bundle does not.
const inline = fs.readFileSync(path.join(root, 'uxp-src/web/diagnosticBoot.js'), 'utf8');
require('acorn').parse(inline, { ecmaVersion: 5 });
const sent = [];
const handlers = {};
const webWindow = { uxpHost: { postMessage: message => sent.push(JSON.parse(message)) }, addEventListener: (name, fn) => { handlers[name] = fn; } };
vm.runInNewContext(inline, { window: webWindow, navigator: { userAgent: 'WebView2 test' }, document: { addEventListener: (name, fn) => { handlers[name] = fn; } } });
assert.strictEqual(sent[0].stage, 'html.script');
handlers.error({ target: { src: 'index.js' } });
assert.match(sent[1].detail, /index.js/);
handlers.unhandledrejection({ reason: new Error('parse failure') });
assert.strictEqual(sent[2].detail, 'parse failure');
handlers.DOMContentLoaded();
assert.strictEqual(sent[3].stage, 'html.dom-ready');

async function testNative() {
  const nodes = {};
  for (const name of ['typer-debug', 'typer-debug-export', 'typer-debug-status', 'typer-status']) nodes[name] = { style: {} };
  const writes = [];
  let saved = null;
  let failSave = false;
  let failAutoWrite = false;
  const file = { nativePath: 'C:\\Users\\Alice\\diagnostics\\log.json', write: async text => { if (failAutoWrite) throw new Error('automatic write denied'); writes.push(JSON.parse(text)); } };
  const uxp = { host: { version: '27.7', uiLocale: 'en_US' }, versions: { uxp: '9.3' }, storage: { formats: { utf8: 'utf8' }, localFileSystem: {
    getDataFolder: async () => ({ getEntry: async () => ({ createFile: async () => file }) }),
    getPluginFolder: async () => ({ getEntry: async () => ({ read: async () => '{"build":"test"}' }) }),
    getFileForSaving: async () => ({ nativePath: 'report.json', write: async text => { if (failSave) throw new Error('denied'); saved = JSON.parse(text); } })
  } } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'uxp-src/host/diagnostics.js'), 'utf8'), {
    module, require: name => ({ uxp, os: { platform: () => 'win32', homedir: () => 'C:\\Users\\Alice' }, './diagnosticLog': { createDiagnosticLog } })[name],
    document: { getElementById: id => nodes[id] }, window: { addEventListener() {} }, setTimeout: () => 1, Date
  });
  const diagnostic = module.exports;
  diagnostic.start();
  for (let i = 0; i < 15; i++) await Promise.resolve();
  diagnostic.note('webview.loaderror', 'runtime unavailable');
  await diagnostic.flush();
  assert(writes.length);
  assert(writes[writes.length - 1].events.some(event => event.stage === 'webview.loaderror'));
  assert(!JSON.stringify(writes).includes('Alice'));
  failAutoWrite = true;
  diagnostic.note('test.disk.failure', 'simulated');
  await diagnostic.flush();
  assert.match(nodes['typer-debug-status'].textContent, /Use Export diagnostic/);
  await nodes['typer-debug-export'].onclick();
  assert(saved.events.some(event => event.stage === 'report.export'));
  assert(saved.events.some(event => event.stage === 'journal.write.error'), 'export still works when automatic logging fails');
  assert.strictEqual(nodes['typer-debug-export'].disabled, false);
  failSave = true;
  await nodes['typer-debug-export'].onclick();
  assert.match(nodes['typer-debug-status'].textContent, /denied/);
  assert.strictEqual(nodes['typer-debug-export'].disabled, false);
  diagnostic.fatal(new Error('module initialization failed'));
  assert.match(nodes['typer-status'].textContent, /module initialization failed/);
}

testNative().then(() => { console.log('UXP diagnostic log, early script and native export tests passed'); }).catch(error => { console.error(error); process.exitCode = 1; });
