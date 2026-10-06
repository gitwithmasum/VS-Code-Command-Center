# Masum Galaxy // Command Center

A futuristic VS Code developer command center with project launching, Git insights, quick actions, terminal controls, theme switching, workspace health, and productivity tools — all in a sleek Galaxy-inspired interface.

## Vision

**Masum Galaxy // Command Center** is designed to become the central control hub for the Masum Galaxy VS Code ecosystem.

The goal is to make common developer actions easier to reach while keeping the interface clean, futuristic, and useful for everyday coding.

## v1.1 — Activity Bar + Live Git Telemetry

The first milestone includes:

- Dedicated **Galaxy Command Center** Activity Bar icon
- Futuristic sidebar control panel
- Full Command Center webview dashboard
- Live workspace name
- Live Git branch, working change count, and sync telemetry
- Quick actions for Terminal, Explorer, Source Control, Theme Selector, and refresh
- Foundation for Recent Files, Project Launcher, Project Health, and Dev Modes

## Smart Workspace — v1.3

The dashboard now includes:

- Project type detection
- Project Health: errors, warnings, TODO/FIXME count
- Recent workspace files with one-click opening
- Smart project actions that adapt to Node.js, React/Vite, Next.js, Python, and VS Code extension projects
- Live Git branch, change count, and sync state

## Project Launcher — v1.4

The dashboard can now remember and launch projects:

- Recent projects managed by Command Center
- Favorite/pinned projects
- One-click project switching
- Open Project folder picker
- Favorite Current Project action

## Advanced Workspace Intelligence — v1.5

- Health score from diagnostics, warnings, TODO/FIXME, and dependency state
- Node.js, npm, Python, Git, and VS Code environment status
- Dev server monitor for common localhost ports
- One-click Open Browser for detected local servers

## Git + Command Workflow — v1.6

- Git Control Center with staged, unstaged, untracked, sync, and last commit status
- Pull, Push, Sync, and Stage All controls
- Recent Command History
- Pinned Commands
- One-click rerun and custom command pinning

## Developer Modes + Theme Matrix — v1.7

- Frontend, Python, AI/ML, Debug, Study, and Focus modes
- Focus Mode powered by VS Code Zen Mode
- Installed-theme discovery
- One-click Theme Matrix switching
- Active mode and current theme indicators

## Galaxy Workspace OS — v2.0

- AI HUD for selected code, diagnostics, and Git commit prompts
- Optional VS Code Chat launcher
- Galaxy Extension Hub with installed-extension detection
- Marketplace access for the gitwithmasum ecosystem
- Customizable dashboard widgets with persistent visibility choices

The AI HUD only prepares context and copies prompts locally. It does not send project code or diagnostics to an external AI service by itself.

## Productivity State — v2.1

- Project-specific notes and next-task reminders
- Live coding session duration, files touched, commands run, and saves
- Lightweight workspace snapshots
- Safe restore of theme, mode label, dashboard visibility, pinned commands, project note, and active file
- Snapshot restore does not switch Git branches or modify project file contents

## Repository Collaboration Hub — v2.2

- Unified local Git and remote-host repository control
- GitHub, GitLab, Bitbucket, Azure DevOps, and generic Git remote detection
- Fetch, Pull, Push, Sync, Stage/Unstage, Commit
- Branch creation and switching
- Initialize repository, manage origin, open remote, and clone repository
- Secure GitHub account connection through VS Code Authentication
- Recently updated GitHub repositories with Open and Clone actions

GitHub account-level integration uses the user's existing VS Code authentication session and does not store the token in extension files. GitLab, Bitbucket, Azure DevOps, and other Git hosts already work for standard Git remote operations; deeper account-level APIs can be added provider-by-provider.

## Galaxy Focus + AI Debug — v2.5

- Active coding-time tracking instead of simple VS Code-open time
- Daily coding goal with progress percentage
- Focus timers: 25 minutes, 50 minutes, or custom duration
- Status-bar focus timer and daily-progress display
- Local 30-day coding history with file, language, edit, and save metadata
- AI Debug Assistant powered by available VS Code language models
- Workspace error/warning detection with file navigation and VS Code Quick Fix
- Optional Auto Analyze mode with a 30-second throttle
- Auto Analyze is off by default and only sends the selected diagnostic plus a small nearby code snippet
- No database is required and source-code history is not persisted

## Smart Developer Assistant — v2.6

- Run detected test, build, lint, and typecheck scripts directly from Command Center
- Capture command output without scraping the VS Code terminal
- Automatically analyze failed project checks with an available VS Code language model
- Analyze copied runtime errors and stack traces from the clipboard
- AI-assisted Git conflict review
- AI review of staged changes before commit
- Copy Smart Developer Assistant analysis/output
- Explicit, user-triggered context sharing for clipboard, conflict, and staged-diff reviews

## AI Fix Studio — v2.7

- Generate a minimal AI fix for the highest-priority current diagnostic
- Refactor an explicit editor selection without auto-writing the file
- Generate a new test file proposal using the detected project test framework
- Review every proposal in VS Code's diff editor before applying
- Explicit confirmation before applying AI changes
- Stale-source protection blocks Apply if the source file changed after generation
- Generated tests never overwrite an existing file
- AI edits remain proposals until the user chooses Apply

## Quality Gate + Auto Verify — v2.8

- Apply Only or Apply & Verify for reviewed AI proposals
- Automatic diagnostics + lint + typecheck + test + build verification after Apply & Verify
- Quality Gate score with READY / REVIEW / BLOCKED status
- Before → After error comparison for AI fixes
- Test coverage summary with weak files when coverage-summary.json is available
- Explicit npm dependency audit + outdated package scan
- Local recurring-error tracking
- Revert Last AI Apply with stale-content protection
- Smart Commit Gate that requires a fresh READY quality result before creating a commit
- Explain Current File AI walkthrough
- No dependency upgrade or source-code rollback happens without explicit user action

## Planned modules

- Project Launcher
- Git Control and branch status
- Recent Files
- Quick Actions
- Theme Matrix
- Project Health
- Dev Modes
- Focus Mode
- Galaxy Extension Hub

## Local install (recommended)

For reliable testing, package and install the extension into normal VS Code instead of repeatedly using the Extension Development Host.

```powershell
npm.cmd install
npx.cmd vsce package
code --install-extension .\masum-galaxy-command-center-1.2.0.vsix --force
```

After installation, reload VS Code and run:

```text
Galaxy Command Center: Open Dashboard
```

The dashboard shows its installed version in the top-right status area.

## Run locally

Open the repository in VS Code, then install dependencies:

```powershell
npm.cmd install
```

Press `F5` to launch an **Extension Development Host**. The current `VS-Code-Command-Center` workspace opens automatically in the development host, so workspace and Git telemetry are available immediately.

Then open the Command Palette:

```text
Ctrl + Shift + P
```

Run:

```text
Galaxy Command Center: Open Dashboard
```

## Project structure

```text
VS-Code-Command-Center/
├── package.json
├── extension.js
├── README.md
├── CHANGELOG.md
├── LICENSE
└── webview/
    ├── index.html
    ├── styles.css
    └── app.js
```

## Roadmap

### v1.1 — Command Center Core

Dashboard, Activity Bar control panel, live Git telemetry, workspace info, quick actions, terminal control, source control access, and theme selector.

### v1.5 — Smart Workspace

Project detection, TODO counter, diagnostics, scripts, dependency status, and project health.

### v2.0 — Galaxy Workspace OS

Dev Modes, Focus Mode, extension hub, customizable widgets, Git visualizer, and deeper Galaxy ecosystem integration.

## Author

**Masum Billah** — [gitwithmasum](https://github.com/gitwithmasum)

## License

MIT
