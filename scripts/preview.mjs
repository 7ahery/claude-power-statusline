// Renders the real status line against demo data and writes assets/preview.svg.
// Usage: npm run preview
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();

// ── demo workspace: a dirty git repo ────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'power-statusline-demo-'));
const repo = path.join(tmp, 'payments-api');
fs.mkdirSync(repo);
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
fs.writeFileSync(path.join(repo, 'session.ts'), 'export {}\n');

// ── demo transcript ─────────────────────────────────────────────
const lines = [{ type: 'user', timestamp: iso(47 * 60e3), message: { content: 'Refactor the auth session layer' } }];
let n = 0;
const tool = (name, input, { error = false, done = true, ago = 60e3 } = {}) => {
  const id = `toolu_demo_${n++}`;
  lines.push({ type: 'assistant', timestamp: iso(ago), message: { content: [{ type: 'tool_use', id, name, input }] } });
  if (done) lines.push({ type: 'user', timestamp: iso(ago - 1000), message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: error }] } });
};
const times = (k, f) => { for (let i = 0; i < k; i++) f(i); };
times(22, () => tool('Read', { file_path: 'src/x.ts' }));
times(14, () => tool('Edit', { file_path: 'src/x.ts' }));
times(9, (i) => tool('Bash', { command: 'npm test' }, { error: i === 0 }));
times(6, () => tool('Grep', { pattern: 'session' }));
times(3, () => tool('Write', { file_path: 'src/y.ts' }));
tool('Skill', { skill: 'tdd' });
tool('mcp__github__create_pull_request', {});
tool('mcp__linear__get_issue', {});
lines.push({ type: 'assistant', timestamp: iso(47e3), message: { content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent',
  input: { subagent_type: 'Explore', model: 'claude-haiku-5-5', description: 'Map auth middleware call sites' } }] } });
tool('Edit', { file_path: 'src/auth/session.ts' }, { done: false, ago: 2e3 });
const transcript = path.join(tmp, 'transcript.jsonl');
fs.writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

// ── demo session payload ────────────────────────────────────────
const sec = (ms) => Math.floor((now + ms) / 1000);
const stdin = {
  session_name: 'auth refactor',
  transcript_path: transcript,
  cwd: repo,
  workspace: { current_dir: repo },
  model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
  effort: { level: 'high' },
  context_window: { context_window_size: 200000, used_percentage: 46,
    current_usage: { input_tokens: 2100, cache_creation_input_tokens: 4900, cache_read_input_tokens: 85000 } },
  cost: { total_cost_usd: 4.12, total_duration_ms: 47 * 60e3 + 12e3, total_lines_added: 248, total_lines_removed: 61 },
  rate_limits: { five_hour: { used_percentage: 38, resets_at: sec(2 * 3600e3 + 14 * 60e3) },
    seven_day: { used_percentage: 61, resets_at: sec(3 * 86400e3 + 6 * 3600e3) } },
  prompt_cache: { warm: true, caching_observed: true, ttl: '1h', expires_at: sec(52 * 60e3), hit_ratio: 0.94 },
};
const ansi = execFileSync(process.execPath, [path.join(root, 'statusline.mjs')],
  { input: JSON.stringify(stdin), env: { ...process.env, COLUMNS: '150' }, encoding: 'utf8' });
fs.rmSync(tmp, { recursive: true, force: true });

// ── ANSI → SVG ──────────────────────────────────────────────────
const rows = [[]];
let st = { fg: null, bg: null, bold: false, ital: false };
for (let i = 0; i < ansi.length; i++) {
  const ch = ansi[i];
  if (ch === '\x1b' && ansi[i + 1] === ']') { i = ansi.indexOf('\x1b\\', i) + 1; continue; } // OSC 8 link
  if (ch === '\x1b' && ansi[i + 1] === '[') {
    const end = ansi.indexOf('m', i);
    const p = ansi.slice(i + 2, end).split(';').map(Number);
    for (let k = 0; k < p.length; k++) {
      if (p[k] === 0) st = { fg: null, bg: null, bold: false, ital: false };
      else if (p[k] === 1) st = { ...st, bold: true };
      else if (p[k] === 22) st = { ...st, bold: false };
      else if (p[k] === 3) st = { ...st, ital: true };
      else if (p[k] === 38 || p[k] === 48) {
        const rgb = `rgb(${p[k + 2]},${p[k + 3]},${p[k + 4]})`;
        st = p[k] === 38 ? { ...st, fg: rgb } : { ...st, bg: rgb };
        k += 4;
      }
    }
    i = end;
    continue;
  }
  if (ch === '\n') { rows.push([]); continue; }
  rows.at(-1).push({ ch: String.fromCodePoint(ansi.codePointAt(i)), ...st });
  if (ansi.codePointAt(i) > 0xffff) i++;
}

const CW = 8.4, LH = 22, FS = 14, PADX = 22, PADY = 18;
const cols = Math.max(...rows.map((r) => r.length));
const W = Math.ceil(cols * CW + PADX * 2), H = rows.length * LH + PADY * 2;
const INK = 'rgb(228,228,240)';
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const out = [];
out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Claude Power Statusline">`);
out.push(`<rect width="${W}" height="${H}" rx="12" fill="#13131b"/>`);
out.push(`<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="11.5" fill="none" stroke="#2a2a3c"/>`);
rows.forEach((row, r) => {
  const y = PADY + r * LH;
  row.forEach((c, x) => {
    const X = PADX + x * CW;
    if (c.bg) out.push(`<rect x="${X.toFixed(1)}" y="${y}" width="${(CW + 0.3).toFixed(1)}" height="${LH}" fill="${c.bg}"/>`);
    if (c.ch === '▐') out.push(`<rect x="${(X + CW / 2).toFixed(1)}" y="${y}" width="${(CW / 2 + 0.3).toFixed(1)}" height="${LH}" fill="${c.fg ?? INK}"/>`);
    if (c.ch === '▌') out.push(`<rect x="${X.toFixed(1)}" y="${y}" width="${(CW / 2 + 0.3).toFixed(1)}" height="${LH}" fill="${c.fg ?? INK}"/>`);
  });
  // text runs: same style, explicit x per glyph so fallback fonts can't drift the grid
  let run = null;
  const flush = () => {
    if (!run) return;
    const attrs = `${run.bold ? ' font-weight="700"' : ''}${run.ital ? ' font-style="italic"' : ''}`;
    out.push(`<text x="${run.xs.join(' ')}" y="${y + 15}" fill="${run.fg}"${attrs}>${esc(run.text)}</text>`);
    run = null;
  };
  row.forEach((c, x) => {
    if (c.ch === ' ' || c.ch === '▐' || c.ch === '▌') { flush(); return; }
    const fg = c.fg ?? INK;
    if (!run || run.fg !== fg || run.bold !== c.bold || run.ital !== c.ital) { flush(); run = { fg, bold: c.bold, ital: c.ital, xs: [], text: '' }; }
    run.xs.push((PADX + x * CW).toFixed(1));
    run.text += c.ch;
  });
  flush();
});
out.push('</svg>');
const svg = out.join('\n').replace('<rect width', `<style>text{font-family:ui-monospace,'SF Mono','Cascadia Code',Menlo,Consolas,monospace;font-size:${FS}px}</style>\n<rect width`);
fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
fs.writeFileSync(path.join(root, 'assets', 'preview.svg'), `${svg}\n`);
console.log(`wrote assets/preview.svg (${W}×${H})`);
