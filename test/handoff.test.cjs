// Launcher safety: a hostile prompt must reach the agent as one argument,
// byte for byte, without the shell running anything. Runs on every OS in CI
// (`node test/handoff.test.cjs`).
const Module = require('module');
const orig = Module._load;
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
Module._load = function (req, ...rest) {
  if (req === 'electron') return { app: { getPath: () => os.tmpdir() } };
  return orig.call(this, req, ...rest);
};
const h = require('../src/handoff.js');
const assert = (ok, msg) => { if (!ok) { console.error('FAIL:', msg); process.exit(1); } console.log('ok -', msg); };

const marker = path.join(os.tmpdir(), `workrail-pwned-${process.pid}`);
const prompt = `Review "PR" it's $HOME \`touch ${marker}\` $(touch ${marker}) ; rm -rf / & | > x\nline 2 'quoted' %PATH% $env:USERPROFILE`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
const out = path.join(dir, 'received.txt');

// Fake agent: writes its first argument to a file.
const isWin = process.platform === 'win32';
const fakeAgent = path.join(dir, isWin ? 'agent.ps1' : 'agent.sh');
if (isWin) {
  fs.writeFileSync(fakeAgent, `param([string]$a) [IO.File]::WriteAllText('${out}', $a)`);
} else {
  fs.writeFileSync(fakeAgent, `#!/bin/sh\nprintf '%s' "$1" > '${out}'\n`, { mode: 0o755 });
}
const agent = { path: fakeAgent, args: ['{prompt}'] };
const launcher = h.writeLauncher({ dir, agent, prompt });
if (isWin) execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher]);
else execFileSync('/bin/sh', [launcher]);

assert(!fs.existsSync(marker), 'no command from the prompt was executed');
const promptFile = fs.readdirSync(path.dirname(launcher)).map((f) => path.join(path.dirname(launcher), f))
  .find((f) => f.startsWith(launcher.replace(/\.(command|sh|ps1)$/, '')) && f.endsWith('.prompt.txt'));
assert(fs.readFileSync(out, 'utf8') === prompt, 'agent received the exact prompt as one argument');
assert(JSON.stringify(h.splitTemplate('my tool --ask "{prompt}" -x')) === JSON.stringify(['my', 'tool', '--ask', '{prompt}', '-x']), 'custom template split');
assert(h.repoFromUrl('git@github.com:Org/Repo.git') === 'org/repo' && h.repoFromUrl('https://github.com/org/repo') === 'org/repo', 'origin URL parsing');
[launcher, promptFile].filter(Boolean).forEach((f) => fs.rmSync(f, { force: true }));
fs.rmSync(dir, { recursive: true, force: true });
console.log('all handoff tests passed');
