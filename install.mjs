#!/usr/bin/env node
// Claude Power Statusline installer: copies the status line into your Claude config dir
// and wires up settings.json.
//
//   npx github:7ahery/claude-power-statusline                  install or update
//   npx github:7ahery/claude-power-statusline --refresh 5      refresh every 5s instead of 2s
//   npx github:7ahery/claude-power-statusline --cost           also show session cost (--cost-rate adds $/h)
//   npx github:7ahery/claude-power-statusline --uninstall      remove and restore your previous status line
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'Claude Power Statusline';
const DIR = 'power-statusline';
const purple = (s) => `\x1b[38;2;114;102;234m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const fail = (msg) => { console.error(`\x1b[31m✗\x1b[0m ${msg}`); process.exit(1); };

const [major] = process.versions.node.split('.').map(Number);
if (major < 18) fail(`${NAME} needs Node 18 or newer (found ${process.versions.node}).`);

const args = process.argv.slice(2);
const uninstall = args.includes('--uninstall');
const refreshArg = args.indexOf('--refresh');
const refresh = refreshArg >= 0 ? Number(args[refreshArg + 1]) : 2;
if (!Number.isInteger(refresh) || refresh < 1) fail('--refresh takes a whole number of seconds (1 or more).');
const passThrough = ['--cost', '--cost-rate'].filter((f) => args.includes(f)); // baked into the command

const envDir = process.env.CLAUDE_CONFIG_DIR?.trim();
const configDir = envDir ? envDir.replace(/^~(?=$|[\\/])/, os.homedir()) : path.join(os.homedir(), '.claude');
const homeDir = path.join(configDir, DIR);
const script = path.join(homeDir, 'statusline.mjs');
const previousFile = path.join(homeDir, 'previous-statusline.json');
const settingsPath = path.join(configDir, 'settings.json');
const fwd = (p) => p.replace(/\\/g, '/');
const pretty = (p) => fwd(p).replace(fwd(os.homedir()), '~');
const isOurs = (sl) => typeof sl?.command === 'string' && fwd(sl.command).includes(`${DIR}/statusline.mjs`);

function readSettings() {
  if (!fs.existsSync(settingsPath)) return {};
  try { return JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
  catch (e) { fail(`Could not parse ${settingsPath}: ${e.message}`); }
}
function writeSettings(settings) {
  fs.mkdirSync(configDir, { recursive: true });
  const backup = `${settingsPath}.bak.${DIR}`;
  if (fs.existsSync(settingsPath) && !fs.existsSync(backup)) fs.copyFileSync(settingsPath, backup);
  const tmp = `${settingsPath}.${DIR}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  fs.renameSync(tmp, settingsPath);
}

const settings = readSettings();

if (uninstall) {
  if (isOurs(settings.statusLine)) {
    let previous = null;
    try { previous = JSON.parse(fs.readFileSync(previousFile, 'utf8')); } catch {}
    if (previous) settings.statusLine = previous; else delete settings.statusLine;
    writeSettings(settings);
  }
  fs.rmSync(homeDir, { recursive: true, force: true });
  console.log(`${purple('◆')} ${NAME} removed. ${dim('Your previous status line is restored.')}`);
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(homeDir, { recursive: true });
fs.copyFileSync(path.join(here, 'statusline.mjs'), script);
if (settings.statusLine && !isOurs(settings.statusLine)) {
  fs.writeFileSync(previousFile, `${JSON.stringify(settings.statusLine, null, 2)}\n`);
}
// Absolute node path: Claude Code's shell may not share your interactive PATH (nvm, fnm, volta…).
settings.statusLine = {
  type: 'command',
  command: [`"${fwd(process.execPath)}"`, `"${fwd(script)}"`, ...passThrough].join(' '),
  refreshInterval: refresh,
};
writeSettings(settings);

console.log(`
${purple('◆')} ${NAME} installed

  ${dim('script  ')} ${pretty(script)}
  ${dim('settings')} ${pretty(settingsPath)} ${dim(`(refresh every ${refresh}s)`)}

  Send a message in Claude Code to see it. Run this again any time to update.
  ${dim('If you switch Node versions, re-run it so the path to node stays valid.')}
`);
