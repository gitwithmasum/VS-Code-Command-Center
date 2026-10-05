# Changelog

## 2.0.2

- Added direct AI HUD prompt preview inside the Command Center dashboard.
- Added Copy Prompt for re-copying the latest generated prompt without relying on Ctrl+V testing.
- AI prompt preview is kept in memory for the current VS Code session and is not persisted to disk.
- AI HUD now re-renders immediately after prompt generation.

## 2.0.1

- Fixed AI HUD code selection being lost when the Command Center webview takes focus.
- Added a cached editor/selection context so Explain Selection works after opening the dashboard.
- Diagnose File now also falls back to the last active code editor context.

## 2.0.0

- Added AI HUD that builds prompts from selected code, current-file diagnostics, and Git changes without automatically sending project data to any service.
- Added optional VS Code Chat launching when a compatible chat command is available.
- Added Galaxy Extension Hub with live detection of Masum/Galaxy extensions and Marketplace access.
- Added customizable dashboard widgets with multi-select visibility controls stored in extension state.
- Added a Command Palette action for dashboard customization.

## 1.7.0

- Added Developer Modes for Frontend, Python, AI/ML, Debug, Study, and Focus workflows.
- Added Focus Mode through VS Code Zen Mode without modifying project files.
- Added Theme Matrix that detects installed contributed color themes and applies them directly.
- Added active mode and current theme indicators to the dashboard.

## 1.6.0

- Added Git Control Center with staged, unstaged, untracked, sync, and last-commit telemetry.
- Added explicit Pull, Push, Sync, and Stage All controls.
- Added Command History for terminal and Git commands launched from Command Center.
- Added Pinned Commands with one-click rerun, pin/unpin, custom command entry, and history clearing.

## 1.5.0

- Added Advanced Project Health with dependency state, npm script count, and a 0-100 health score.
- Added Environment Status for Node.js, npm, Python, Git, and VS Code versions.
- Added Dev Server Monitor that scans common local development ports and can open detected servers in the browser.
- Fixed dashboard Project Launcher context handling so favorite actions refresh correctly.

## 1.4.0

- Added Project Launcher with Command Center-managed recent projects.
- Added favorite project pinning and unpinning.
- Added one-click project switching and an Open Project folder picker.
- Current workspaces are remembered automatically and shown in the dashboard launcher.
- Added futuristic launcher UI with current-project indicators.

## 1.3.1

- Removed wildcard `*` activation to avoid unnecessary startup performance cost.
- Added targeted activation for startup-finished, Command Center commands, and the sidebar view.
- Updated the local VSIX install workflow for version 1.3.1.

## 1.3.0

- Added Smart Workspace project-type detection for VS Code extensions, React/Vite, Next.js, Node.js, Python, and general workspaces.
- Added Project Health with live VS Code diagnostics, warnings, and TODO/FIXME counts.
- Added Recent Files based on workspace file modification time with one-click opening.
- Added context-aware Smart Project Actions such as npm install, dev, build, test, VSIX packaging, Python run, and interpreter selection.
- Upgraded the futuristic dashboard and sidebar to surface real project intelligence.

## 1.2.1

- Fixed Git telemetry in normal installed VS Code sessions.
- Git commands now prefer the currently open workspace folder instead of the extension installation directory.
- Branch, changes, and sync status now reflect the active project repository.

## 1.2.0

- Added an on-screen version badge so installed updates can be verified immediately.
- Added a reliable VSIX-based local install workflow for testing in normal VS Code.
- Recommended packaging/installing the extension instead of repeatedly relying on Extension Development Host sessions.

## 1.1.8

- Fixed dashboard telemetry using an invalid `this.extensionUri` reference inside `openDashboard()`.
- Dashboard now reads the actual extension repository path through `context.extensionUri`.
- Workspace name, branch, changes, and sync status now render from the correct repository context.

## 1.1.7

- Replaced VS Code Git API telemetry with direct Git CLI telemetry for local development reliability.
- Workspace name now falls back to the actual extension folder name using `context.extensionPath`.
- Branch, change count, and upstream sync status are now read directly from the repository path.
- Dashboard telemetry no longer depends on an open VS Code workspace.

## 1.1.6

- Replaced command-based delayed auto-open with a direct dashboard launch during extension activation.
- Added explicit auto-open success/failure logs to the Extension Host Debug Console.
- Added `Galaxy Command Center: Diagnose` for runtime diagnostics.
- Kept the dashboard command, status bar launcher, and Activity Bar launcher as manual fallbacks.

## 1.1.5

- Dashboard now opens automatically when the Extension Development Host starts.
- Removed the unreliable attempt to force-open a workspace folder in the development host.
- Git telemetry now prefers the extension repository path directly, even when no workspace is open.
- F5 development flow is now: launch host -> activate extension -> open dashboard automatically.

## 1.1.4

- Added direct repository detection using the extension installation folder.
- Git telemetry can now work even when the Extension Development Host has no open workspace.
- Workspace label now falls back to the extension folder name instead of showing 'No workspace open'.
- Reduced dependence on VS Code workspace state during local extension development.

## 1.1.3

- Added automatic workspace recovery in Extension Development Host.
- When the development host starts without a workspace, Galaxy Command Center now opens its own extension folder automatically.
- This removes the persistent 'No workspace open / No Git repo' state during local development.

## 1.1.2

- Simplified dashboard rendering to a self-contained webview for maximum reliability.
- Switched to always-on activation during development to eliminate command activation edge cases.
- Added explicit dashboard error handling and Extension Host console logging.
- Added a Galaxy status bar launcher as a second reliable way to open the dashboard.
- Kept Git telemetry graceful when Git is unavailable.

## 1.1.1

- Added a proper VS Code Extension Development Host launch configuration for reliable F5 testing.
- Added startup activation and explicit refresh-command activation.
- Added safe activation of VS Code's built-in Git extension before reading Git telemetry.
- Improved dashboard startup reliability during local development.

## 1.1.0

- Added a dedicated Galaxy Command Center Activity Bar container.
- Added a futuristic sidebar webview with workspace and Git telemetry.
- Added live Git branch, working change count, and ahead/behind sync status.
- Upgraded the full dashboard with a HUD-style telemetry strip, scanning effects, glow states, and refined cards.
- Added refresh controls for workspace telemetry.

## 1.0.0

- Created the initial Masum Galaxy // Command Center extension foundation.
- Added the Open Dashboard command.
- Added a futuristic webview dashboard shell.
- Added live workspace-name display.
- Added quick actions for Terminal, Explorer, Source Control, and Theme Selector.
- Added the initial roadmap for project launcher, Git insights, workspace health, and developer modes.
