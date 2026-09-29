// One-click GitHub actions through the gh CLI: approve, merge, re-run failed
// jobs, and the failing log excerpt of a GitHub Actions run. Confirmation
// happens in main.js before any of these run.
const { resolveGh, run } = require('./github');

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const METHODS = { MERGE: '--merge', SQUASH: '--squash', REBASE: '--rebase' };

function check(repo, number) {
  if (!REPO_RE.test(repo) || !Number.isInteger(number) || number <= 0) throw new Error('Invalid pull request');
}

async function gh(args) {
  const bin = await resolveGh();
  if (!bin) throw new Error('GitHub CLI (gh) not found');
  try {
    return await run(bin, args, { timeout: 60000 });
  } catch (err) {
    throw new Error((err.stderr || err.message || '').trim().split('\n').slice(-3).join(' ') || 'gh failed');
  }
}

async function approve(repo, number) {
  check(repo, number);
  await gh(['pr', 'review', String(number), '--repo', repo, '--approve']);
}

async function merge(repo, number, method = 'MERGE') {
  check(repo, number);
  await gh(['pr', 'merge', String(number), '--repo', repo, METHODS[method] || '--merge']);
}

async function rerunFailed(repo, runId) {
  if (!REPO_RE.test(repo) || !/^\d+$/.test(String(runId))) throw new Error('Invalid run');
  await gh(['run', 'rerun', String(runId), '--repo', repo, '--failed']);
}

// What went wrong in a failed GitHub Actions run: the "##[error]" messages
// and the meaningful lines before the last one. `--log-failed` prints
// "job<TAB>step<TAB>line".
const cache = new Map(); // runId → excerpt
const ERROR_RE = /\berror\b|\bfailed\b|exception|✗|✖|panic|assertion/i;

async function failedLog(repo, runId) {
  if (!REPO_RE.test(repo) || !/^\d+$/.test(String(runId))) throw new Error('Invalid run');
  if (cache.has(runId)) return cache.get(runId);
  let out;
  try {
    out = await gh(['run', 'view', String(runId), '--repo', repo, '--log-failed']);
  } catch (err) {
    // Logs are deleted after the retention period (HTTP 410).
    if (/410|expired|not found/i.test(err.message)) return { job: '', step: '', errors: [], text: '', expired: true };
    throw err;
  }
  const rows = out.split(/\r?\n/).filter(Boolean).map((l) => {
    const [job, step, ...rest] = l.split('\t');
    const text = rest.join('\t')
      .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, '') // timestamp prefix
      .replace(/\x1b\[[0-9;]*m/g, ''); // ANSI colours
    return { job, step, text };
  });
  // "##[error]" annotations are the real messages; keep the last few.
  const errors = [...new Set(rows.filter((r) => r.text.includes('##[error]'))
    .map((r) => r.text.replace(/.*##\[error\]/, '').trim()).filter(Boolean))].slice(-5);
  // Context: the meaningful lines leading up to the last error, without the
  // runner's group markers and env/config dumps.
  const noise = (t) => /^##\[(group|endgroup|command)\]|^\s*(shell|env|with):\s*$|^\s+[A-Za-z0-9_-]+:\s|\*\*\*|^\s*$/.test(t);
  const lastIndex = (pred) => rows.map(pred).lastIndexOf(true);
  let anchor = lastIndex((r) => r.text.includes('##[error]'));
  if (anchor < 0) anchor = lastIndex((r) => ERROR_RE.test(r.text));
  if (anchor < 0) anchor = rows.length - 1;
  const context = rows.slice(0, anchor + 1).filter((r) => !noise(r.text) && !r.text.includes('##[error]')).slice(-15);
  let text = context.map((r) => r.text).join('\n');
  if (text.length > 4000) text = `…${text.slice(-4000)}`;
  const at = rows[anchor] || {};
  const excerpt = { job: at.job || '', step: at.step || '', errors, text };
  cache.set(runId, excerpt);
  return excerpt;
}

module.exports = { approve, merge, rerunFailed, failedLog };
