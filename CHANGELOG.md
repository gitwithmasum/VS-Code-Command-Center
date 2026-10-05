# Changelog

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
