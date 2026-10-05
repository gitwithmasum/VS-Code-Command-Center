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
