// Claude Power Statusline: a two-row status line for Claude Code. https://github.com/7ahery/claude-power-statusline
// Standalone, zero dependencies. Inspired by kcchien/claude-code-statusline and claude-hud.
//
//  ▐◆ Opus 5.5  ◑ high▌ ctx ▐   67k/200k   ▌ │ 5h ▐ 22% ↻ 1h56m ▌ │ 7d ▐ 45% ↻ 3d11h ▌ │ ◷ 15m │ ● cache 92% → 8:18 PM
//  ▐◇ claude          ▌ “statusline” │ ⎇ main ● ↑1 │ +40 −2 │ ◐ web-fetch haiku-5.5 Fetch repo 32s │ ◓ Edit app.ts │ ✓ Bash 18 · Read 4 │ ✦ skill │ ◈ mcp
//
// Reading it:
//  • Gauges are capsules whose fill heats up green → amber → coral → red; the value sits inside.
//  • Row 2 is ranked: when the terminal is narrow, detail shrinks evenly first, then the least useful drops.
//
// Options (command-line flags, or the matching environment variables):
//  --cost        POWER_STATUSLINE_COST=1        show the session cost
//  --cost-rate   POWER_STATUSLINE_COST_RATE=1   also show cost per hour (needs --cost)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

// ── palette ──────────────────────────────────────────────────────
const P = {
  brand: [114, 102, 234], brandHi: [214, 209, 255], white: [255, 255, 255],
  ink: [228, 228, 240], sub: [158, 158, 182], dim: [104, 104, 128], faint: [70, 70, 92], track: [50, 50, 68],
  green: [123, 216, 143], teal: [94, 214, 194], amber: [245, 194, 107], coral: [242, 132, 112], red: [235, 80, 90],
  blue: [130, 170, 255], pink: [244, 154, 200], peach: [250, 179, 135],
  pill2Bg: [44, 41, 68], pill2Fg: [190, 184, 250],
};
const E = '\x1b[';
const fg = (c) => `${E}38;2;${c[0]};${c[1]};${c[2]}m`;
const bg = (c) => `${E}48;2;${c[0]};${c[1]};${c[2]}m`;
const RST = `${E}0m`, BOLD = `${E}1m`, NOBOLD = `${E}22m`, ITAL = `${E}3m`;
const paint = (c, s) => `${fg(c)}${s}${RST}`;
const SEP = ` ${fg(P.faint)}│${RST} `;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const clean = (s, max = 64) => {
  const t = String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

// Heat gradient: green → amber → coral → red, sampled continuously.
const STOPS = [[0, P.green], [0.55, P.amber], [0.8, P.coral], [1, P.red]];
function heat(t) {
  t = clamp(t, 0, 1);
  for (let i = 1; i < STOPS.length; i++) {
    const [t1, c1] = STOPS[i];
    if (t <= t1) {
      const [t0, c0] = STOPS[i - 1];
      const k = (t - t0) / (t1 - t0);
      return c0.map((v, j) => Math.round(v + (c1[j] - v) * k));
    }
  }
  return STOPS.at(-1)[1];
}

// Capsule gauge: gradient fill with the value printed inside, rounded with half-block caps.
// Dark bold text on the fill, light text on the track; half-cell precision where no text sits.
const ON_FILL = [24, 22, 34];
function gauge(frac, w, text) {
  frac = clamp(frac, 0, 1);
  let halves = Math.round(frac * w * 2);
  if (frac > 0 && halves === 0) halves = 1; // anything above zero is visible
  const chars = [...text].slice(0, w);
  const start = Math.floor((w - chars.length) / 2);
  const bgs = [];
  let s = '';
  for (let i = 0; i < w; i++) {
    const ch = i >= start && i < start + chars.length ? chars[i - start] : ' ';
    const full = halves >= 2 * (i + 1), half = halves === 2 * i + 1;
    if (full || (half && ch !== ' ')) {
      bgs.push(heat((i + 0.5) / w));
      s += `${bg(bgs[i])}${fg(ON_FILL)}${BOLD}${ch}`;
    } else if (half) {
      bgs.push(P.track);
      s += `${bg(P.track)}${fg(heat((i + 0.5) / w))}▌`;
    } else {
      bgs.push(P.track);
      s += `${bg(P.track)}${fg(P.ink)}${NOBOLD}${ch}`;
    }
  }
  return `${RST}${fg(bgs[0])}▐${s}${RST}${fg(bgs[w - 1])}▌${RST}`;
}
const flag = (arg, env) => process.argv.includes(arg) || /^(1|true|yes|on)$/i.test(process.env[env] ?? '');
const SHOW_COST = flag('--cost', 'POWER_STATUSLINE_COST');
const SHOW_COST_RATE = SHOW_COST && flag('--cost-rate', 'POWER_STATUSLINE_COST_RATE');

// Display width, ignoring ANSI/OSC-8 and counting wide glyphs as 2.
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, '');
function width(s) {
  let w = 0;
  for (const ch of strip(s)) {
    const cp = ch.codePointAt(0);
    if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) continue;
    const wide = (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)
      || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0x1f300 && cp <= 0x1faff);
    w += wide ? 2 : 1;
  }
  return w;
}

// Fit ranked segments into a width. Shrinks evenly (everyone one step, lowest priority first),
// then drops the least important segments (pri ≥ 100 never drops).
function fit(segs, max) {
  const live = segs.filter((s) => s && s.v?.[0]).map((s) => ({ ...s, i: 0 }));
  const render = () => live.map((s) => s.v[s.i]).join(SEP);
  if (!(max > 0)) return render();
  while (width(render()) > max) {
    const shrink = live.filter((s) => s.i < s.v.length - 1).sort((a, b) => a.i - b.i || a.pri - b.pri)[0];
    if (shrink) { shrink.i++; continue; }
    const drop = live.filter((s) => s.pri < 100).sort((a, b) => a.pri - b.pri)[0];
    if (!drop) break;
    live.splice(live.indexOf(drop), 1);
  }
  return render();
}

// ── formatting ───────────────────────────────────────────────────
const fmtTok = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`);
const fmtLeft = (ms) => {
  const m = Math.ceil(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d${h % 24 ? `${h % 24}h` : ''}`;
  return `${h}h${m % 60 ? `${String(m % 60).padStart(2, '0')}m` : ''}`;
};
const fmtDur = (ms) => {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, '0')}m`;
};
const fmtElapsed = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60 ? `${s % 60}s` : ''}`;
  return `${Math.floor(s / 3600)}h${Math.floor(s / 60) % 60}m`;
};
const shortModel = (id) => {
  const m = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/i.exec(String(id ?? ''));
  return m ? `${m[1].toLowerCase()}-${m[2]}${m[3] ? `.${m[3]}` : ''}` : clean(id, 20) || null;
};
const tsToMs = (v) => (v == null ? null : v > 1e12 ? v : v * 1000);

// ── input ────────────────────────────────────────────────────────
let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch {}
let j;
try { j = JSON.parse(raw); } catch {
  process.stdout.write(`${fg(P.brand)}◆${RST} ${paint(P.dim, 'waiting for session…')}`);
  process.exit(0);
}
const now = Date.now();
const spin = ['◐', '◓', '◑', '◒'][Math.floor(now / 1000) % 4];
const cols = Number.parseInt(process.env.COLUMNS ?? '', 10);
const maxW = cols > 0 ? cols - 4 : 0; // Claude Code pads the status line by 2 on each side
// ── transcript: tools, skills, MCP, agents ───────────────────────
// Incremental: parsed state is cached in %TEMP% with a byte offset, so each run only reads lines
// appended since the last run. Cost stays flat no matter how long the session gets.
const NOT_TOOLS = new Set(['Skill', 'TodoWrite', 'TaskCreate', 'TaskUpdate']);
const STATE_V = 3;
const freshState = (file) => ({ v: STATE_V, file, offset: 0, ctx: null, counts: {}, errors: 0, running: {},
  skills: [], mcp: [], agents: {}, completions: {}, agentIds: {} });

function ingest(st, text) {
  const skills = new Set(st.skills), mcp = new Set(st.mcp);
  for (const line of text.split('\n')) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const t = e.timestamp ? Date.parse(e.timestamp) : NaN;
    const at = Number.isFinite(t) ? t : null; // untimestamped copies must not count as "now"
    // A new prompt means anything still marked running was interrupted.
    if (e.type === 'user' && typeof e.message?.content === 'string' && e.isSidechain !== true) st.running = {};
    if (e.type === 'assistant' && e.isSidechain !== true) {
      const u = e.message?.usage;
      const n = u ? (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) : 0;
      if (n > 0) st.ctx = n;
    }
    if (e.type === 'system' && e.subtype === 'compact_boundary') st.ctx = e.compactMetadata?.postTokens ?? null;
    if (e.type === 'queue-operation' && e.operation === 'enqueue' && typeof e.content === 'string') {
      const taskId = /<task-id>([^<]+)<\/task-id>/.exec(e.content)?.[1];
      const tuid = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(e.content)?.[1] ?? (taskId && st.agentIds[taskId]);
      if (tuid && at && !(tuid in st.completions)) st.completions[tuid] = at;
    }
    // Only real turns count; other record types (e.g. api-request-blob) replay old tool calls.
    if ((e.type !== 'user' && e.type !== 'assistant') || !Array.isArray(e.message?.content)) continue;
    for (const b of e.message.content) {
      if (b?.type === 'tool_use' && b.id && b.name) {
        const inp = b.input ?? {};
        const m = /^mcp__(.+?)__(.+)$/.exec(b.name);
        if (m) mcp.add(m[1]);
        if (b.name === 'Skill' && inp.skill) skills.add(String(inp.skill));
        if (b.name === 'Agent' || b.name === 'Task') {
          st.agents[b.id] = { type: String(inp.subagent_type ?? 'agent'), model: inp.model ?? null,
            desc: inp.description ?? null, start: at ?? Date.now(), end: null, bg: inp.run_in_background === true };
        } else if (!NOT_TOOLS.has(b.name)) {
          const tg = inp.file_path ?? inp.path ?? inp.pattern ?? null;
          st.running[b.id] = { name: b.name, target: typeof tg === 'string' ? tg.slice(-200) : null };
        }
      }
      if (b?.type === 'tool_result' && b.tool_use_id) {
        const tool = st.running[b.tool_use_id];
        if (tool) {
          delete st.running[b.tool_use_id];
          st.counts[tool.name] = (st.counts[tool.name] ?? 0) + 1;
          if (b.is_error) st.errors++;
        }
        const a = st.agents[b.tool_use_id];
        if (a) {
          const r = e.toolUseResult ?? {};
          if (r.agentId) st.agentIds[r.agentId] = b.tool_use_id;
          if (r.resolvedModel) a.model = r.resolvedModel;
          if (r.isAsync === true || r.status === 'async_launched') a.bg = true;
          if (!a.bg && !a.end) a.end = at ?? a.start;
        }
      }
    }
  }
  st.skills = [...skills];
  st.mcp = [...mcp];
  const ids = Object.keys(st.agents); // keep the cache small
  for (const id of ids.slice(0, Math.max(0, ids.length - 30))) delete st.agents[id];
}

function loadTranscript(file) {
  if (!file) return freshState(file);
  const key = crypto.createHash('md5').update(file).digest('hex').slice(0, 16);
  const cacheFile = path.join(os.tmpdir(), `claude-statusline-tr-${key}.json`);
  let st;
  try { st = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}
  if (!st || st.v !== STATE_V || st.file !== file) st = freshState(file);
  let size;
  try { size = fs.statSync(file).size; } catch { return st; }
  if (size < st.offset) st = freshState(file); // transcript was rewritten
  if (size === st.offset) return st;
  let buf;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      buf = Buffer.allocUnsafe(size - st.offset);
      buf = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, st.offset));
    } finally { fs.closeSync(fd); }
  } catch { return st; }
  const end = buf.lastIndexOf(0x0a); // only consume complete lines
  if (end < 0) return st;
  ingest(st, buf.toString('utf8', 0, end));
  st.offset += end + 1;
  try { // atomic replace, so a cancelled run can't leave a half-written cache
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(st));
    fs.renameSync(tmp, cacheFile);
  } catch {}
  return st;
}

const st = loadTranscript(j.transcript_path);
const tr = {
  contextTokens: st.ctx,
  running: Object.values(st.running),
  counts: Object.entries(st.counts),
  errors: st.errors,
  skills: st.skills,
  mcp: st.mcp,
  agents: Object.entries(st.agents).map(([id, a]) => {
    const end = a.end ?? (a.bg ? st.completions[id] ?? null : null);
    return { ...a, start: new Date(a.start), end: end != null ? new Date(end) : null };
  }),
};

// ── git (cached 5s per directory) ────────────────────────────────
const cwd = j.workspace?.current_dir ?? j.cwd ?? '';
function gitStatus(dir) {
  if (!dir) return null;
  const cache = path.join(os.tmpdir(), `claude-statusline-git-${Buffer.from(dir).toString('base64url').slice(-40)}.json`);
  try { if (now - fs.statSync(cache).mtimeMs < 5000) return JSON.parse(fs.readFileSync(cache, 'utf8')); } catch {}
  let res = null;
  try {
    const outp = execFileSync('git', ['-C', dir, '--no-optional-locks', 'status', '--porcelain=v2', '--branch'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500, windowsHide: true });
    let branch = '', oid = '', ahead = 0, behind = 0, dirty = false;
    for (const l of outp.split('\n')) {
      if (l.startsWith('# branch.head ')) branch = l.slice(14);
      else if (l.startsWith('# branch.oid ')) oid = l.slice(13, 20);
      else if (l.startsWith('# branch.ab ')) { const [a, b] = l.slice(12).split(' '); ahead = +a; behind = -b; }
      else if (l && !l.startsWith('#')) dirty = true;
    }
    res = { branch: branch === '(detached)' ? oid : branch, dirty, ahead, behind };
  } catch {}
  try { fs.writeFileSync(cache, JSON.stringify(res)); } catch {}
  return res;
}

// ── pills (row anchors, padded to the same width so both rows share a grid) ──
const model = clean(j.model?.display_name || j.model?.id || '─', 32);
const EFFORT = { low: '○', medium: '◔', high: '◑', xhigh: '◕', max: '●', ultracode: '✸' };
const lvl = j.effort?.level ? clean(String(j.effort.level).toLowerCase(), 12) : '';
const p1Text = `◆ ${model}${lvl ? `  ${EFFORT[lvl] ?? '◌'} ${lvl}` : ''}`;
const p1 = `${BOLD}${fg(P.white)}◆ ${model}${NOBOLD}${lvl ? `  ${fg(P.brandHi)}${EFFORT[lvl] ?? '◌'} ${lvl}` : ''}`;
const proj = clean(cwd ? path.basename(cwd) || cwd : '~', 26);
const p2Text = `◇ ${proj}`;
const url = cwd ? `file:///${cwd.replace(/\\/g, '/').replace(/^\//, '')}` : '';
const p2 = `${fg(P.pill2Fg)}${url ? `\x1b]8;;${url}\x1b\\` : ''}◇ ${proj}${url ? '\x1b]8;;\x1b\\' : ''}`;
const pillW = Math.max(width(p1Text), width(p2Text));
const pill = (content, cw, bgc) =>
  `${fg(bgc)}▐${bg(bgc)}${content}${' '.repeat(Math.max(0, pillW - cw))}${RST}${fg(bgc)}▌${RST}`;
const pill1 = pill(p1, width(p1Text), P.brand);
const pill2 = pill(p2, width(p2Text), P.pill2Bg);
const restW = maxW > 0 ? maxW - (pillW + 3) : 0;

// ═════════════════════════════ ROW 1 · session vitals ═════════════════════════════
const r1 = [];

// Context window
const cw = j.context_window ?? {};
const size = num(cw.context_window_size) ?? 0;
const cu = cw.current_usage;
const tokens = cu ? (cu.input_tokens ?? 0) + (cu.cache_creation_input_tokens ?? 0) + (cu.cache_read_input_tokens ?? 0)
  : tr.contextTokens ?? 0;
const pct = clamp(Math.floor(num(cw.used_percentage) ?? (size ? (tokens / size) * 100 : 0)), 0, 100);
{
  const warn = pct >= 90 ? paint(P.red, ' ▲') : pct >= 80 ? paint(P.amber, ' ▲') : '';
  const full = size ? `${fmtTok(tokens)}/${fmtTok(size)}` : tokens ? fmtTok(tokens) : `${pct}%`;
  const short = tokens ? fmtTok(tokens) : `${pct}%`;
  const g = (w) => gauge(pct / 100, w, full.length + 2 <= w ? full : short);
  const lab = paint(P.dim, 'ctx ');
  r1.push({ pri: 100, v: [`${lab}${g(16)}${warn}`, `${lab}${g(12)}${warn}`, `${g(10)}${warn}`] });
}

// Usage limits: % used and time until reset, inside the capsule
function limitSeg(label, w, pri) {
  const p = num(w?.used_percentage);
  if (p == null) return null;
  const u = clamp(p / 100, 0, 1);
  const reset = tsToMs(num(w.resets_at));
  const left = reset && reset > now ? fmtLeft(reset - now) : null;
  const lab = paint(P.dim, `${label} `);
  const val = u >= 1 ? 'limit' : `${Math.round(p)}%`;
  const full = left ? `${val} ↻ ${left}` : val;
  return { pri, v: [
    `${lab}${gauge(u, Math.max(11, full.length + 4), full)}`,
    `${lab}${gauge(u, 7, val)}`,
    `${lab}${paint(heat(u), val)}`,
  ] };
}
const rl = j.rate_limits ?? {};
r1.push(limitSeg('5h', rl.five_hour, 90));
r1.push(limitSeg('7d', rl.seven_day, 70));

// Cost + burn rate
const cost = num(j.cost?.total_cost_usd) ?? 0;
const dur = num(j.cost?.total_duration_ms) ?? 0;
{
  const costTxt = `${paint(P.dim, '$')}${paint(cost >= 10 ? P.coral : P.amber, cost.toFixed(2))}`;
  const perHour = SHOW_COST_RATE && dur > 10 * 60e3 && cost > 0 ? cost / (dur / 3600e3) : null;
  const rate = perHour != null ? paint(P.dim, ` · $${perHour >= 10 ? perHour.toFixed(0) : perHour.toFixed(2)}/h`) : '';
  if (SHOW_COST) r1.push({ pri: 80, v: [`${costTxt}${rate}`, costTxt] });
}

// Session time
if (dur >= 1000) r1.push({ pri: 55, v: [`${paint(P.dim, '◷')} ${paint(P.sub, fmtDur(dur))}`, paint(P.sub, fmtDur(dur))] });

// Prompt cache: warmth dot, hit rate, expiry
const pc = j.prompt_cache;
if (pc?.caching_observed) {
  const exp = tsToMs(num(pc.expires_at));
  const left = pc.warm && exp ? exp - now : 0;
  const ttl = pc.ttl === '1h' ? 3600e3 : 300e3;
  const dot = left <= 0 ? paint(P.dim, '○') : paint(left <= Math.max(60e3, ttl / 5) ? P.amber : P.green, '●');
  const hr = num(pc.hit_ratio);
  const hit = hr != null ? ` ${paint(P.sub, `${Math.round(clamp(hr, 0, 1) * 100)}%`)}` : '';
  const when = left > 0
    ? paint(P.dim, ` → ${new Date(exp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`)
    : paint(P.dim, ' cold');
  r1.push({ pri: 45, v: [`${dot} ${paint(P.dim, 'cache')}${hit}${when}`, `${dot}${hit || paint(P.dim, ' cache')}`] });
}

// ═════════════════════════════ ROW 2 · where & what ═════════════════════════════
const r2 = [];

if (j.session_name) {
  const n = clean(j.session_name, 30);
  r2.push({ pri: 60, v: [`${ITAL}${paint(P.sub, `“${n}”`)}`, `${ITAL}${paint(P.sub, `“${clean(n, 14)}”`)}`] });
}
if (j.agent?.name) r2.push({ pri: 92, v: [paint(P.peach, `⚙ ${clean(j.agent.name, 24)}`)] });

// Git
const g = gitStatus(cwd);
const branch = j.worktree?.branch || g?.branch;
if (branch) {
  const b = clean(branch, 32);
  const dirty = g?.dirty ? ` ${paint(P.amber, '●')}` : '';
  const ab = g ? paint(P.dim, `${g.ahead ? ` ↑${g.ahead}` : ''}${g.behind ? ` ↓${g.behind}` : ''}`) : '';
  const wt = j.worktree?.name ? ` ${paint(P.peach, `⊕ ${clean(j.worktree.name, 20)}`)}` : '';
  r2.push({ pri: 95, v: [
    `${paint(P.dim, '⎇')} ${paint(P.teal, b)}${dirty}${ab}${wt}`,
    `${paint(P.dim, '⎇')} ${paint(P.teal, clean(b, 16))}${dirty}`,
  ] });
}

// Lines changed
const add = num(j.cost?.total_lines_added) ?? 0, rm = num(j.cost?.total_lines_removed) ?? 0;
if (add || rm) r2.push({ pri: 85, v: [`${paint(P.green, `+${add}`)} ${paint(P.coral, `−${rm}`)}`] });

// Agents: running, plus those finished in the last minute
{
  const agents = tr.agents;
  const running = agents.filter((a) => !a.end).slice(-3);
  const recent = agents.filter((a) => a.end && now - a.end.getTime() <= 60e3)
    .slice(-Math.max(0, Math.min(2, 3 - running.length)));
  const show = [...running, ...recent];
  if (show.length) {
    const fmt = (a, detail) => {
      const icon = a.end ? paint(P.green, '✓') : paint(P.peach, spin);
      const m = detail >= 1 && shortModel(a.model) ? ` ${paint(P.dim, shortModel(a.model))}` : '';
      const d = detail >= 2 && a.desc ? ` ${paint(P.sub, clean(a.desc, 28))}` : '';
      const el = paint(P.dim, ` ${fmtElapsed((a.end?.getTime() ?? now) - a.start.getTime())}`);
      return `${icon} ${paint(a.end ? P.sub : P.peach, clean(a.type, 22))}${m}${d}${el}`;
    };
    r2.push({ pri: 80, v: [2, 1, 0].map((d) => show.map((a) => fmt(a, d)).join('  ')) });
  }
}

// Tools: running now, then completed counts (+ errors)
{
  const short = (n) => clean(/^mcp__.+__.+$/.test(n) ? n.split('__').pop() : n, 22);
  const running = tr.running.slice(-2);
  if (running.length) {
    const fmt = (t, withTarget) => {
      const tg = withTarget && t.target ? ` ${paint(P.dim, clean(String(t.target).replace(/\\/g, '/').split('/').pop(), 22))}` : '';
      return `${paint(P.amber, spin)} ${paint(P.ink, short(t.name))}${tg}`;
    };
    r2.push({ pri: 75, v: [running.map((t) => fmt(t, true)).join('  '), running.map((t) => fmt(t, false)).join('  ')] });
  }
  const sorted = [...tr.counts].sort((a, b) => b[1] - a[1]);
  const errors = tr.errors;
  if (sorted.length) {
    const err = errors ? `  ${paint(P.coral, `✗ ${errors}`)}` : '';
    const list = (n) => {
      const items = sorted.slice(0, n).map(([name, k]) => `${paint(P.sub, short(name))} ${paint(P.dim, k)}`);
      if (sorted.length > n) items.push(paint(P.dim, `+${sorted.length - n}`));
      return `${paint(P.green, '✓')} ${items.join(paint(P.faint, ' · '))}${err}`;
    };
    const total = sorted.reduce((s, [, k]) => s + k, 0);
    r2.push({ pri: 40, v: [list(6), list(3), `${paint(P.green, '✓')} ${paint(P.sub, `${total} tools`)}${err}`] });
  }
}

// Skills + MCP servers
const names = (set, icon, col, pri) => {
  const arr = [...set].map((s) => clean(s, 28)).filter(Boolean);
  if (!arr.length) return null;
  const list = (n) => arr.slice(0, n).map((s) => paint(P.sub, s)).join(paint(P.faint, ', '))
    + (arr.length > n ? paint(P.dim, ` +${arr.length - n}`) : '');
  return { pri, v: [`${paint(col, icon)} ${list(4)}`, `${paint(col, icon)} ${list(1)}`, `${paint(col, icon)} ${paint(P.sub, arr.length)}`] };
};
r2.push(names(tr.skills, '✦', P.pink, 35));
r2.push(names(tr.mcp, '◈', P.blue, 35));

// ── output ───────────────────────────────────────────────────────
const row1 = `${pill1} ${fit(r1, restW)}`;
const rest2 = fit(r2, restW);
const out = [row1, rest2 ? `${pill2} ${rest2}` : pill2].join('\n');
process.stdout.on('error', () => {}); // reader went away (e.g. a newer refresh cancelled us)
try { process.stdout.write(out); } catch {}
