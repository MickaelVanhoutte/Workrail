// New release check: asks GitHub for the latest published release of this
// app (anonymous request, nothing sent about the user) and reports when it
// is newer than the running version. Only notifies: installers are not
// signed, so updating stays a manual download.
const { net } = require('electron');
const pkg = require('../../package.json');

const INTERVAL = 6 * 3600 * 1000;

// "https://github.com/owner/repo.git" → "owner/repo"
function repoSlug(url = pkg.repository?.url || pkg.homepage || '') {
  return String(url).match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/)?.[1] || null;
}

// Semver-ish compare of "v1.2.3" / "1.2.3-beta.1"; pre-releases sort before
// their release.
function compare(a, b) {
  const parse = (v) => {
    const [main, pre] = String(v).trim().replace(/^v/, '').split('-', 2);
    return { nums: main.split('.').map((n) => parseInt(n, 10) || 0), pre: pre || null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

function start({ current, enabled, onUpdate }) {
  const slug = repoSlug();
  let timer = null;

  const check = async () => {
    clearTimeout(timer);
    timer = setTimeout(check, INTERVAL);
    if (!slug || !enabled()) return onUpdate(null);
    try {
      // /latest skips drafts and pre-releases.
      const res = await net.fetch(`https://api.github.com/repos/${slug}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rel = await res.json();
      const version = String(rel.tag_name || '').replace(/^v/, '');
      const url = /^https:\/\/github\.com\//.test(rel.html_url) ? rel.html_url : `https://github.com/${slug}/releases/latest`;
      onUpdate(version && compare(version, current) > 0 ? { version, url } : null);
    } catch (err) {
      console.error('[updates]', err.message);
    }
  };

  check();
  return { refresh: check, stop: () => clearTimeout(timer) };
}

module.exports = { start, compare, repoSlug };
