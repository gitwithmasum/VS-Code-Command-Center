# Masum Galaxy // Command Center

A futuristic VS Code developer command center with project launching, Git insights, quick actions, terminal controls, theme switching, workspace health, and productivity tools — all in a sleek Galaxy-inspired interface.

## Vision

**Masum Galaxy // Command Center** is designed to become the central control hub for the Masum Galaxy VS Code ecosystem.

The goal is to make common developer actions easier to reach while keeping the interface clean, futuristic, and useful for everyday coding.

## v1.0 starter

The first milestone includes:

- Command Palette entry: `Galaxy Command Center: Open Dashboard`
- Futuristic webview dashboard shell
- Current workspace name
- Quick actions for Terminal, Explorer, Source Control, and Theme Selector
- Foundation for Git insights, recent files, project health, and project launcher

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

## Run locally

Open the repository in VS Code, then install dependencies:

```powershell
npm.cmd install
```

Press `F5` to launch an **Extension Development Host**.

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

### v1.0 — Command Center Core

Dashboard, workspace info, quick actions, terminal control, source control access, and theme selector.

### v1.5 — Smart Workspace

Project detection, TODO counter, diagnostics, scripts, dependency status, and project health.

### v2.0 — Galaxy Workspace OS

Dev Modes, Focus Mode, extension hub, customizable widgets, Git visualizer, and deeper Galaxy ecosystem integration.

## Author

**Masum Billah** — [gitwithmasum](https://github.com/gitwithmasum)

## License

MIT
