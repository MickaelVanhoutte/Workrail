# Workrail

A Slack-style desktop hub for your workday: **Google Chat, Gmail, Google Calendar, GitHub reviews and Jira** in one window, with a **Home** view that tells you what to do next.

Built with Electron, for **macOS, Windows and Linux**. Google apps run in their real web versions (your normal sign-in, no API keys); Workrail adds a Slack-like look to Chat and a set of local panels on top.

## Features

- **Chat, Slack-style**: dark top bar and sidebar, compact messages, DMs without bubbles, quick switcher, keyboard navigation between conversations, native notifications, unread badge.
- **Left rail**: Home, Chat, Mail, Calendar, Reviews, Jira, with unread badges.
- **Home**: what needs you now (meetings about to start, unread DMs, failing CI, approved PRs, overdue tickets, reviews waiting for days), your day as a timeline with free slots, reviews to do, your pull requests, your Jira tickets, unread conversations and important mail.
- **Reviews**: pull requests waiting for your review (via the GitHub CLI), people before bots, stale ones folded away, per-repo hiding.
- **Jira**: tickets assigned to you with status, sprint and due date, linked to your pull requests by issue key (`[PROJ-123]` in the PR title).
- **Meetings**: next-meeting pill in Chat's top bar, a reminder notification before each meeting, a weekday morning summary.

## Install

Download the file for your system from the [latest release](https://github.com/MickaelVanhoutte/Workrail/releases/latest).

| System | File |
|---|---|
| macOS (Apple Silicon) | `Workrail-<version>-mac-arm64.dmg` |
| Windows 10/11 (64-bit) | `Workrail-<version>-win-x64.exe` |
| Linux (64-bit), any distribution | `Workrail-<version>-linux-x86_64.AppImage` |
| Linux (64-bit), Debian / Ubuntu | `Workrail-<version>-linux-amd64.deb` |

The builds are **not code-signed**, so each system warns you the first time.

### macOS

1. Open the `.dmg` and drag **Workrail** to **Applications**.
2. First launch: in Applications, **right-click Workrail → Open**, then confirm. (If macOS still refuses: System Settings → Privacy & Security → **Open Anyway**.)
3. Allow notifications when asked.

### Windows

1. Run the `.exe`. If SmartScreen shows *"Windows protected your PC"*, click **More info → Run anyway**.
2. Choose the install folder (per-user install, no admin rights needed). A desktop and Start-menu shortcut are created.
3. Closing the window keeps Workrail running in the **notification area** (system tray): click its icon to bring it back, right-click → **Quit** to exit.

### Linux

**AppImage** (works on most distributions):

```bash
chmod +x Workrail-*-linux-x86_64.AppImage
./Workrail-*-linux-x86_64.AppImage
```

If it does not start, install FUSE 2 (Ubuntu 22.04+: `sudo apt install libfuse2`).

**Debian / Ubuntu package**:

```bash
sudo apt install ./Workrail-*-linux-amd64.deb
```

Then start **Workrail** from your applications menu (or run `workrail`).

Notes:

- A **keyring** (GNOME Keyring or KWallet, unlocked) is required to store the calendar address securely; without one, Workrail refuses to save it rather than keeping it in clear.
- Closing the window keeps Workrail in the system tray, if your desktop has one (GNOME needs the *AppIndicator* extension).

## First run

1. **Google**: sign in once in the Chat view. Gmail and Calendar reuse the same session.
2. **Calendar** (timeline, reminders, next-meeting pill): in Google Calendar → Settings → your calendar → *Integrate calendar*, copy the **secret address in iCal format** and paste it in Workrail → **Settings**. It is stored encrypted with your system keychain. Never share it: anyone with it can read your calendar (you can reset it from the same place).
3. **GitHub** (Reviews, "My pull requests"): install the [GitHub CLI](https://cli.github.com) and sign in:

   | System | Install |
   |---|---|
   | macOS | `brew install gh` |
   | Windows | `winget install GitHub.cli` |
   | Linux | `sudo apt install gh`, or see [cli.github.com](https://github.com/cli/cli#installation) |

   then `gh auth login`. Workrail runs `gh`; it never sees your token. Restart Workrail after installing `gh`.
4. **Jira** (optional): in **Settings**, enter your site (`yourcompany.atlassian.net`), then open the Jira view and sign in once. An optional JQL filter narrows your tickets down, e.g. `assignee = currentUser() AND statusCategory != Done AND project = PROJ`.
5. In Settings you can also hide repositories from Reviews (`my-org/old-team-*`), set the meeting reminder and the morning summary time.

## Keyboard shortcuts

| Action | macOS | Windows / Linux |
|---|---|---|
| Home, Chat, Mail, Calendar, Reviews, Jira | ⌘1 … ⌘6 | Ctrl+1 … Ctrl+6 |
| Quick switcher (Chat) | ⌘K | Ctrl+K |
| Previous / next conversation (next unread with ⇧) | ⌥↑ / ⌥↓ | Alt+↑ / Alt+↓ |
| Settings | ⌘, | Ctrl+, |
| Back / forward | ⌘[ / ⌘] | Ctrl+[ / Ctrl+] |
| Toggle the Slack theme in Chat | ⌘⇧, | Ctrl+Shift+, |
| Quit | ⌘Q | Ctrl+Q |

## Troubleshooting

- **"This browser or app may not be secure" at Google sign-in**: retry from the Chat view; Workrail presents itself as regular Chrome. Some company sign-in pages need a second attempt.
- **Reviews say "GitHub CLI not found"**: install `gh`, run `gh auth login` in a terminal, restart Workrail.
- **No notifications**: allow them for Workrail in your system settings (Windows: Settings → System → Notifications; macOS: System Settings → Notifications).
- **Calendar address refused on Linux**: install and unlock GNOME Keyring or KWallet, then restart Workrail.
- **Jira shows "Sign in"**: open the Jira view from the rail and sign in once; tickets appear within a minute.

## Privacy

Everything stays on your machine. Workrail has no server and sends nothing anywhere: it talks directly to Google, GitHub (through `gh`) and your Jira site with your own sessions. Settings, sessions and caches live in the app's user-data folder:

- macOS: `~/Library/Application Support/Workrail`
- Windows: `%APPDATA%\Workrail`
- Linux: `~/.config/Workrail`

## Development

Requires [Node.js](https://nodejs.org) 22+.

```bash
npm install
npm start          # run the app
npm run dev        # DevTools protocol on :9222 + live reload of the Chat theme
npm run smoke      # start, check that the window and Home load, exit (used by CI)
npm run dist       # installer for the current system, in dist/
npm run icons      # re-render the app icon PNGs from scripts/make-icons.cjs
```

`npm run dist:mac`, `dist:win` and `dist:linux` build a given target (Linux builds also work from macOS).

### How it works

- `src/main.js`: window, rail, tray, services, menu, IPC. `src/platform.js`: per-OS differences.
- `src/views.js`: the app views (web views and local panels) and link routing.
- `src/inject/`: CSS and JS injected into Google Chat (theme, switcher, notifications, DOM tagging).
- `src/services/`: Gmail (Atom feed), GitHub (`gh api graphql`), Calendar (iCal via `node-ical`), Jira (REST with the web session).
- `src/priorities.js`: the rules behind Home's *Focus* list.
- `src/panels/`, `src/shell/`: local pages (Home, Reviews, Settings, rail).

Google Chat's markup is obfuscated and changes over time. All the selectors live in the `SEL` object at the top of `src/inject/app.js`, and the theme only targets Workrail's own `data-gslack*` attributes. To inspect the live page, run `npm run dev` and use `node scripts/dump-dom.mjs` (see the script header for options).

### Releasing

1. Bump `version` in `package.json` and commit.
2. Tag and push: `git tag v0.2.0 && git push origin main --tags`.
3. The **Build & release** workflow builds and smoke-tests on macOS, Windows and Linux and attaches the installers to a **draft** release.
4. Review the draft on GitHub and publish it.

The workflow can also be run by hand (Actions → Build & release → Run workflow) to get the installers as build artifacts without releasing.

## License

[MIT](LICENSE).

## Disclaimer

Workrail is an independent project, not affiliated with or endorsed by Google, Slack, Atlassian or GitHub. All trademarks belong to their respective owners.
