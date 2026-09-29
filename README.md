# Workrail

A Slack-style desktop hub for your workday: **Google Chat, Gmail, Google Calendar, GitHub reviews and Jira** in one window, with a **Home** view that tells you what to do next.

Built with Electron. Google apps run in their real web versions (your normal sign-in, no API keys); Workrail adds a Slack-like look to Chat and a set of local panels on top.

## Features

- **Chat, Slack-style**: dark top bar and sidebar, compact messages, DMs without bubbles, ⌘K quick switcher, ⌥↑/⌥↓ to move between conversations, native notifications, dock badge.
- **Left rail**: Home, Chat, Mail, Calendar, Reviews, Jira, with unread badges (⌘1–⌘6).
- **Home**: what needs you now (meetings about to start, unread DMs, failing CI, approved PRs, overdue tickets, reviews waiting for days), your day as a timeline with free slots, reviews to do, your pull requests, your Jira tickets, unread conversations and important mail.
- **Reviews**: pull requests waiting for your review (via the GitHub CLI), people before bots, stale ones folded away, per-repo hiding.
- **Jira**: tickets assigned to you with status, sprint and due date, linked to your pull requests by issue key (`[PROJ-123]` in the PR title).
- **Meetings**: next-meeting pill in Chat's top bar, a reminder notification with a *Join Meet* button, a weekday morning summary.

## Requirements

- macOS (Windows and Linux are planned).
- [Node.js](https://nodejs.org) 22+.
- Optional: [GitHub CLI](https://cli.github.com) signed in (`gh auth login`) for the Reviews and "My pull requests" sections.
- Optional: a Jira Cloud site (`yourcompany.atlassian.net`).

## Run

```bash
npm install
npm start          # run the app
npm run dev        # run with DevTools protocol on :9222 and live reload of the Chat theme
npm run dist       # build dist/Workrail-<version>-arm64.dmg (unsigned)
```

The build is not signed: on first launch, right-click the app → **Open**.

## Setup

1. **Google**: sign in once in the Chat view. Gmail and Calendar reuse the same session.
2. **Calendar** (meeting reminders, timeline, next-meeting pill): in Google Calendar → Settings → your calendar → *Integrate calendar*, copy the **secret address in iCal format** and paste it in Workrail → Settings. It is stored encrypted with the OS keychain.
3. **GitHub**: install the GitHub CLI and run `gh auth login`. Workrail calls `gh`; it never sees your token.
4. **Jira**: enter your site in Settings, then open the Jira view and sign in once. Tickets are read with that web session. An optional JQL filter narrows them down (e.g. `… AND project = PROJ`).

## Privacy

Everything stays on your machine. Workrail has no server and sends nothing anywhere: it talks directly to Google, GitHub (through `gh`) and your Jira site with your own sessions. Settings, sessions and caches live in the app's user-data folder (`~/Library/Application Support/Workrail` on macOS).

## How it works

- `src/main.js`: window, rail, services, menu, IPC.
- `src/views.js`: the app views (web views and local panels) and link routing.
- `src/inject/`: CSS and JS injected into Google Chat (theme, switcher, notifications, DOM tagging).
- `src/services/`: Gmail (Atom feed), GitHub (`gh api graphql`), Calendar (iCal via `node-ical`), Jira (REST with the web session).
- `src/priorities.js`: the rules behind Home's *Focus* list.
- `src/panels/`, `src/shell/`: local pages (Home, Reviews, Settings, rail).

Google Chat's markup is obfuscated and changes over time. All the selectors live in the `SEL` object at the top of `src/inject/app.js`, and the theme only targets Workrail's own `data-gslack*` attributes. To inspect the live page, run `npm run dev` and use `node scripts/dump-dom.mjs` (see the script header for options).

## Disclaimer

Workrail is an independent project, not affiliated with or endorsed by Google, Slack, Atlassian or GitHub. All trademarks belong to their respective owners.
