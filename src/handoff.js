// Hand work to an AI coding agent: open a terminal in the right repository
// with the agent started on a prepared prompt (review a PR, fix CI,
// implement a ticket). Works with any CLI agent (presets below or a custom
// command) and the usual terminals of each OS.
//
// Safety: prompts contain third-party text (PR titles, ticket descriptions).
// They are written to a file and read into a variable by the launcher, then
// passed to the agent as ONE argument: never parsed by a shell.
const { app } = require('electron');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const HOME = os.homedir();

// Command templates: `{prompt}` is replaced by the prompt (single argument).
// Flags checked against each tool's docs (see README).
const AGENTS = [
  { id: 'claude', name: 'Claude Code', bin: 'claude', args: ['{prompt}'] },
  { id: 'copilot', name: 'Copilot CLI', bin: 'copilot', args: ['-i', '{prompt}'] },
  { id: 'opencode', name: 'OpenCode', bin: 'opencode', args: ['--prompt', '{prompt}'] },
  { id: 'codex', name: 'Codex CLI', bin: 'codex', args: ['{prompt}'] },
  { id: 'gemini', name: 'Gemini CLI', bin: 'gemini', args: ['-i', '{prompt}'] },
  // Aider has no "interactive with a first message": --message runs it once.
  { id: 'aider', name: 'Aider', bin: 'aider', args: ['--message', '{prompt}'] },
];

const TERMINALS = {
  darwin: [
    { id: 'warp', name: 'Warp', app: '/Applications/Warp.app' },
    { id: 'iterm', name: 'iTerm', app: '/Applications/iTerm.app' },
    { id: 'terminal', name: 'Terminal', app: '/System/Applications/Utilities/Terminal.app' },
  ],
  win32: [
    { id: 'wt', name: 'Windows Terminal', bin: 'wt' },
    { id: 'powershell', name: 'PowerShell window', bin: 'powershell' },
  ],
  linux: [
    { id: 'x-terminal-emulator', name: 'Default terminal', bin: 'x-terminal-emulator' },
    { id: 'gnome-terminal', name: 'GNOME Terminal', bin: 'gnome-terminal' },
    { id: 'konsole', name: 'Konsole', bin: 'konsole' },
    { id: 'xfce4-terminal', name: 'Xfce Terminal', bin: 'xfce4-terminal' },
    { id: 'xterm', name: 'xterm', bin: 'xterm' },
  ],
}[process.platform] || [];

const run = (file, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 15000, ...opts }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
});

// --- finding binaries ---------------------------------------------------------

const EXTRA_BIN_DIRS = IS_WIN
  ? [path.join(process.env.APPDATA || '', 'npm'), path.join(process.env.LOCALAPPDATA || '', 'Programs')]
  : [path.join(HOME, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/snap/bin', path.join(HOME, '.npm-global/bin'), path.join(HOME, '.bun/bin')];

const binCache = new Map();
async function findBin(name) {
  if (binCache.has(name)) return binCache.get(name);
  const exts = IS_WIN ? ['.exe', '.cmd', '.bat', ''] : [''];
  let found = null;
  for (const dir of EXTRA_BIN_DIRS) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      if (fs.existsSync(p)) { found = p; break; }
    }
    if (found) break;
  }
  if (!found) {
    try {
      const out = IS_WIN
        ? await run('where', [name])
        : await run(process.env.SHELL || '/bin/sh', ['-lc', `command -v ${name}`]);
      found = out.split(/\r?\n/)[0].trim() || null;
    } catch {
      found = null;
    }
  }
  binCache.set(name, found);
  return found;
}

// Split a custom template ("mytool --ask {prompt}") into argv, honouring
// simple quotes. Done here, never by a shell.
function splitTemplate(template) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(template))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

async function detectAgents() {
  const found = [];
  for (const a of AGENTS) {
    const bin = await findBin(a.bin);
    if (bin) found.push({ ...a, path: bin });
  }
  return found;
}

// The agent to use: settings.agent ('auto' = first installed preset,
// 'custom' = settings.agentCommand, or a preset id).
async function resolveAgent({ agent = 'auto', agentCommand = '' } = {}) {
  if (agent === 'custom') {
    const argv = splitTemplate(agentCommand);
    if (!argv.length || !argv.includes('{prompt}')) return null;
    const bin = path.isAbsolute(argv[0]) ? argv[0] : await findBin(argv[0]);
    return bin ? { id: 'custom', name: path.basename(argv[0]), path: bin, args: argv.slice(1) } : null;
  }
  const installed = await detectAgents();
  if (agent === 'auto') return installed[0] || null;
  return installed.find((a) => a.id === agent) || null;
}

async function detectTerminals() {
  const out = [];
  for (const t of TERMINALS) {
    if (t.app ? fs.existsSync(t.app) : await findBin(t.bin)) out.push(t);
  }
  return out;
}

// --- repository index -----------------------------------------------------------

function defaultCodeFolders() {
  const names = ['workspace', 'Workspace', 'dev', 'Dev', 'code', 'Code', 'projects', 'Projects', 'src', 'git', 'repos'];
  const list = names.map((n) => path.join(HOME, n));
  if (IS_WIN) list.push(path.join(HOME, 'source', 'repos'));
  // Case-insensitive file systems list the same folder twice.
  const seen = new Set();
  return list.filter((p) => {
    if (!fs.existsSync(p)) return false;
    const real = fs.realpathSync.native(p).toLowerCase();
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  });
}

// "git@github.com:owner/repo.git", "https://github.com/owner/repo" → owner/repo
function repoFromUrl(url) {
  const m = String(url).match(/github\.com[:/]+([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i);
  return m ? m[1].toLowerCase() : null;
}

function originOf(dir) {
  try {
    const cfg = fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8');
    const origin = cfg.split(/^\[/m).find((s) => s.startsWith('remote "origin"'));
    return origin ? repoFromUrl(origin.match(/url\s*=\s*(.+)/)?.[1] || '') : null;
  } catch {
    return null;
  }
}

const indexFile = () => path.join(app.getPath('userData'), 'repo-index.json');
let repoIndex = null;

function scan(folders) {
  const map = {};
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === '.git')) {
      const repo = originOf(dir);
      if (repo && !map[repo]) map[repo] = dir;
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') walk(path.join(dir, e.name), depth + 1);
    }
  };
  folders.forEach((f) => walk(f, 0));
  return map;
}

function loadIndex(folders, { rescan = false } = {}) {
  if (!rescan && repoIndex) return repoIndex;
  if (!rescan) {
    try {
      repoIndex = JSON.parse(fs.readFileSync(indexFile(), 'utf8'));
      return repoIndex;
    } catch {
      // no cache yet
    }
  }
  repoIndex = scan(folders);
  fs.writeFile(indexFile(), JSON.stringify(repoIndex), () => {});
  return repoIndex;
}

function findRepo(repo, folders) {
  const key = repo.toLowerCase();
  let dir = loadIndex(folders)[key];
  if (dir && fs.existsSync(dir)) return dir;
  dir = loadIndex(folders, { rescan: true })[key];
  return dir || null;
}

// --- launching -------------------------------------------------------------------

// POSIX single-quote escaping; PowerShell single-quote escaping.
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Returns the launcher file path. `pre` = commands before the agent
// (e.g. gh pr checkout), as argv arrays.
function writeLauncher({ dir, agent, prompt, pre = [] }) {
  const folder = path.join(os.tmpdir(), 'workrail-handoff');
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  // Prompts hold PR / ticket text: don't keep them around. The terminal has
  // long read its script by then.
  for (const f of fs.readdirSync(folder)) {
    const file = path.join(folder, f);
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > 6 * 3600 * 1000) fs.rmSync(file);
    } catch {
      // already gone
    }
  }
  const id = crypto.randomBytes(6).toString('hex');
  const promptFile = path.join(folder, `${id}.prompt.txt`);
  // Windows .cmd shims (npm-installed agents) cut arguments at newlines.
  const text = IS_WIN && /\.(cmd|bat)$/i.test(agent.path) ? prompt.replace(/\s*\r?\n\s*/g, ' ') : prompt;
  fs.writeFileSync(promptFile, text, { mode: 0o600 });

  if (IS_WIN) {
    const args = agent.args.map((a) => (a === '{prompt}' ? '$p' : psq(a))).join(' ');
    const lines = [
      '$ErrorActionPreference = "Continue"',
      `Set-Location -LiteralPath ${psq(dir)}`,
      ...pre.map((argv) => `& ${argv.map(psq).join(' ')}`),
      `$p = Get-Content -Raw -LiteralPath ${psq(promptFile)}`,
      `& ${psq(agent.path)} ${args}`,
    ];
    const file = path.join(folder, `${id}.ps1`);
    fs.writeFileSync(file, lines.join('\r\n'));
    return file;
  }
  const args = agent.args.map((a) => (a === '{prompt}' ? '"$P"' : shq(a))).join(' ');
  const lines = [
    '#!/bin/sh',
    `cd ${shq(dir)} || exit 1`,
    ...pre.map((argv) => `${argv.map(shq).join(' ')} || true`),
    `P="$(cat ${shq(promptFile)})"`,
    `exec ${shq(agent.path)} ${args}`,
  ];
  const file = path.join(folder, `${id}${IS_MAC ? '.command' : '.sh'}`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o700 });
  return file;
}

function detach(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', ...opts });
  child.unref();
}

async function openTerminal(terminalId, script, dir) {
  const available = await detectTerminals();
  const term = available.find((t) => t.id === terminalId) || available[0];
  if (!term) throw new Error('No terminal found');
  if (IS_MAC) {
    if (term.id === 'iterm') {
      return run('osascript', ['-e', `tell application "iTerm" to create window with default profile command "/bin/sh ${script.replace(/"/g, '\\"')}"`]);
    }
    // Warp and Terminal run .command files they are asked to open.
    return run('open', ['-a', term.app, script]);
  }
  if (IS_WIN) {
    const ps = ['powershell', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', script];
    if (term.id === 'wt') return detach('wt', ['-d', dir, ...ps]);
    return detach('cmd', ['/c', 'start', '""', ...ps], { windowsVerbatimArguments: false });
  }
  const sh = ['/bin/sh', script];
  if (term.id === 'gnome-terminal') return detach('gnome-terminal', ['--working-directory', dir, '--', ...sh]);
  return detach(term.bin, ['-e', ...sh]);
}

module.exports = {
  AGENTS, detectAgents, resolveAgent, detectTerminals, defaultCodeFolders,
  findRepo, loadIndex, writeLauncher, openTerminal, splitTemplate, findBin, repoFromUrl,
};
