# Changelog

## 4.0.0

- Promoted the extension to **Masum Galaxy // Developer OS** while preserving the existing extension ID for upgrade compatibility.
- Added a unified Developer OS kernel state above the existing dashboard modules.
- Added deterministic **OPERATIONAL / ATTENTION / DEGRADED** OS status with a weighted 0–100 score.
- Added a module registry that summarizes Project Doctor, Quality Gate, CI Intelligence, Release Center, Developer Knowledge Graph, Architecture Intelligence, Galaxy AI Agent, Task Orchestrator, and Git Workspace state.
- Added a four-stage boot sequence for Workspace, Health, Quality, and Delivery readiness.
- Added priority missions that route developers into existing safe workflows based on blocked, review, or unknown module state.
- Added direct module routing without inventing arbitrary shell commands or bypassing existing approvals.
- Added safe **Refresh OS** cache reset for architecture, knowledge, Doctor, CI, and GitHub collaboration state.
- Updated dashboard/panel branding to **Developer OS** while retaining existing command IDs and package name.
- Existing AI edit, commit, push, tag, and release confirmation gates remain authoritative.
- Added `src/features/developer-os.js` and `test/developer-os.test.js`.
- Added Developer OS module/tests to syntax, automated-test, and prepublish gates.
- Prepared v4.0.0 for Marketplace launch with a 30-keyword search set, concise Marketplace description, Free pricing label, gallery banner metadata, PNG extension icon, SUPPORT.md, and tighter VSIX exclusions.


## 3.7.0

- Added Release Center with deterministic READY / REVIEW / BLOCKED / TAGGED release verdicts.
- Added semantic-version validation and package.json ↔ package-lock.json version consistency checks.
- Added current-version CHANGELOG.md section detection and release-notes preview/copy.
- Added release gating for Git cleanliness/conflicts/upstream state, Quality Gate freshness, GitHub Actions coverage, and Project Doctor status.
- Added release-tag collision detection and verification that an existing version tag points to current HEAD.
- Added explicit Run Release Check workflow that runs local verification, Quality Gate, Project Doctor refresh, and CI refresh.
- Added safe Create Version Tag flow with modal confirmation and separate optional tag-push confirmation.
- Added draft GitHub release creation using verified current commit and CHANGELOG.md release notes.
- Draft release creation requires an existing current-HEAD version tag and a separate modal confirmation.
- Added Open Releases shortcut and next patch/minor/major version suggestions.
- Release Center never changes package versions automatically.
- Added `src/features/release-center.js` and `test/release-center.test.js`.
- Added Release Center module/tests to syntax, automated-test, and prepublish gates.


## 3.6.0

- Added Project Doctor with one-click local project health inspection.
- Added CRITICAL / WARNING / GOOD findings with an overall 0–100 Doctor score.
- Inspects environment availability for Git, Node.js, npm/pnpm/yarn, and Python when applicable.
- Detects package manager and lockfile consistency, installed dependency state, and package manifest validity.
- Reuses the explicit dependency-audit result without silently making network requests.
- Inspects Git conflicts, upstream state, behind status, and working-tree cleanliness.
- Checks common lint, test, and build script availability.
- Includes current VS Code error/warning diagnostics.
- Checks basic repository hygiene including .gitignore, README, and license files.
- Detects sensitive-looking root filenames and reports tracked/ignored Git state without reading secret contents.
- Added explicit Run Doctor and Scan Dependencies controls.
- Added `src/features/project-doctor.js` and `test/project-doctor.test.js`.
- Added Project Doctor module/tests to syntax, automated-test, and prepublish gates.


## 3.5.0

- Added Developer Knowledge Graph with a local project-wide symbol and dependency index.
- Added function/class symbol extraction for JavaScript/TypeScript, Python, and common compiled languages.
- Added heuristic cross-file symbol reference detection and Who Calls This? navigation.
- Added File Impact analysis with direct and transitive reverse-dependency tracing up to three levels.
- Added Feature / Flow search across filenames, symbols, and semantic project layers.
- Added semantic layer detection for Authentication, Database, API/HTTP, UI, Tests, and Configuration.
- Added direct file navigation from Knowledge Graph results.
- Knowledge Graph analysis stays local and does not send source code to AI.
- Added 90-second workspace-scoped graph caching and explicit Rebuild Graph control.
- Added `src/features/knowledge-graph.js` and `test/knowledge-graph.test.js`.
- Added Knowledge Graph module/tests to syntax, automated-test, and prepublish gates.


## 3.4.0

- Added Galaxy AI Agent Mode with natural-language developer goals.
- Added AI-generated plan-only workflow with a fixed safe action whitelist.
- Added deterministic local fallback planning when no language model is available or AI output is invalid.
- Added step-by-step Agent execution with visible PENDING / RUNNING / PASS / FAILED / SKIPPED state.
- Added explicit approval for verification and AI-context steps.
- Added write-risk classification for Smart Commit and Push If Ready, while preserving their existing confirmation gates.
- Agent does not support arbitrary shell commands or silent source edits.
- Agent fix actions create proposals only; Apply remains a separate existing user-controlled action.
- Agent plan state is memory-only and is not persisted.
- Added `src/features/agent.js` and `test/agent.test.js`.
- Added Agent module and tests to syntax, automated-test, and prepublish coverage.


## 3.3.1

- Added GitHub branch-protection awareness to Ready-to-Push.
- Detects protected current branches and pull-request requirements when GitHub exposes the protection endpoint.
- Protected branches that require a pull request now produce REVIEW instead of READY for direct push.
- Shows branch-protection state in the CI Intelligence summary.
- Added automated tests for branch-protection normalization and readiness behavior.

## 3.3.0

- Added CI Intelligence + Ready-to-Push Center.
- Added local GitHub Actions workflow detection and workflow job/script parsing.
- Added local-to-CI script mapping.
- Added current-branch GitHub Actions run and job status through VS Code GitHub authentication.
- Added failing-job visibility.
- Added Git ahead/behind, upstream, clean-tree, conflict, and push-commit readiness signals.
- Added deterministic READY / REVIEW / BLOCKED push-readiness evaluation.
- Added Run Ready Check: local verification → Quality Gate → CI refresh.
- Added Push If Ready with mandatory final confirmation.
- Added `src/features/ci.js` and `test/ci.test.js`.
- Added CI module/test files to the syntax and prepublish gates.
- Added GitHub Actions workflow for syntax checks, automated tests, and VSIX packaging.


## 3.2.2

- Extracted Quality Gate pure logic to `src/features/quality.js`.
- Extracted CP judge pure logic to `src/features/cp-core.js`.
- Reduced duplicate quality/privacy/coverage logic inside `extension.js`.
- Changed JavaScript CP execution to use the actual `node` command.
- Added built-in Node automated tests for Quality, Orchestrator, Architecture, and CP core logic.
- Added `npm test`.
- Updated `vscode:prepublish` to run `npm run check && npm test`.
- Added syntax checks for new modules and test files.
- Excluded test files from packaged VSIX output.


## 3.2.1

- Removed raw diagnostic-message persistence from recurring-error history and added migration for existing records.
- Added workspace-isolated Quality Gate state reset.
- Added dirty-workspace-file protection before Quality Gate verification.
- Added staged-diff fingerprint validation for Smart Commit freshness.
- Fixed relative coverage-path handling.
- Changed failed task AI analysis to explicit opt-in.
- Clarified VS Code end-exclusive AI edit ranges and improved diff-preview syntax detection.
- Added Task Orchestrator cancellation support.
- Prevented startup diagnostics from being counted as new recurring errors.
- Scoped AI rollback backups to the workspace where the apply occurred.
- Added .vscodeignore to clean VSIX packaging and remove the packaging warning.


## 3.2.0

- Added Workspace Task Orchestrator + Command Graph.
- Added package.json script discovery and task classification.
- Added script dependency edges from npm/pnpm/yarn script references and npm pre-scripts.
- Added Verify Pipeline with failure-aware sequential execution.
- Added Ship Pipeline: Build → Test → Quality Gate → Smart Commit.
- Added saved sequential/parallel workflows with run/delete controls.
- Added task-run history with metadata-only persistence.
- Added shared Windows-safe captured process runner for .cmd/.bat package-manager executables.
- Rewired Smart Developer tasks and Quality Gate checks to use the shared process runner.
- Added `src/core/process.js` and `src/features/orchestrator.js` to the prepublish syntax gate.


## 3.1.0

- Added Workspace Architecture Intelligence.
- Added local project structure, language, entry-point, and source-size analysis.
- Added local dependency relationships for JS/TS, C/C++, and Python relative imports.
- Added central-module scoring and dependency-cycle detection.
- Added large-file and static risk-hotspot reporting.
- Added Find Feature workspace search with direct file/line navigation.
- Added opt-in AI Explain Matches grounded only in local search snippets.
- Added Workspace Architecture JSON export.
- Added scanner caps, ignored generated/vendor directories, and a 90-second architecture cache.
- Added `src/features/architecture.js` to the prepublish syntax gate.


## 3.0.0

- Added Developer Analytics + Project Intelligence dashboard.
- Added 7-day / 30-day active coding-time analytics and coding streaks.
- Added 30-day language-time distribution.
- Added local Git commit analytics for the current workspace.
- Added persistent Quality Gate history with average score and READY-rate analytics.
- Added daily Project Health history and trend comparison.
- Added CP performance analytics, preserved CP history across new contests, and tracked explicit official AC results.
- Added JSON export for developer analytics.
- Fixed active coding language tracking in the coding-history heartbeat.
- Added `src/features/analytics.js` to the prepublish syntax gate.


## 2.9.1

- Added CP Multi Test Case Runner with `---` case separators.
- Added optional expected-output mode for input-only multi-case execution.
- Added verdict history for sample, suite, and stress runs.
- Added automatic local-judge failure tracking for WA, TLE, RE, and CE states.
- Kept official AC explicit so sample success is not mistaken for judge acceptance.
- Added Stress Test workflow using generator, brute, and optimized solutions.
- Added mismatch reporting with failing input and compared outputs.
- Added C++17, Python 3, and JavaScript starter templates.
- Added New Problem File creation through VS Code Save As.
- Hardened contest timing around expiry and problem switching.


## 2.9.0

- Added Galaxy CP Arena.
- Added local contest countdown and A–H problem tracking with per-problem active time.
- Added problem states for Solving, WA, TLE, RE, AC, and reset.
- Added Local Sample Judge for C/C++, Python, and JavaScript.
- Added gcc/g++ native compile support, execution timeout, runtime measurement, output comparison, and verdict reporting.
- Added C++ / Python competitive-programming snippet vault.
- Added AI Complexity and AI Edge Case tools.
- Added Panic Assist with three escalating hints instead of a copy-paste final solution.
- Added CP Focus Mode and platform shortcuts for Codeforces, AtCoder, LeetCode, and CodeChef.
- Preserved the last active source-file context so CP tools continue to work while the dashboard webview is focused.
- Added the CP feature module to the prepublish syntax gate.


## 2.8.1

- Began modular cleanup by extracting workspace/runtime helpers and Git helpers into `src/core`.
- Fixed synchronous JSON metadata access used by Smart Project task detection and test-framework detection.
- Command Center terminals now use the active workspace as their current working directory.
- Fixed last-commit parsing for commit subjects containing pipe characters.
- Added modal confirmation before deleting workspace snapshots.
- Improved VS Code command session counting and dashboard refresh behavior.
- Added a VS Code prepublish syntax gate covering `extension.js` and the new core modules.


## 2.8.0

- Added Quality Gate + Auto Verify with READY / REVIEW / BLOCKED status and a 0–100 score.
- Added Apply Only vs Apply & Verify for AI Fix Studio proposals.
- Added automatic diagnostics, lint, typecheck, test, and build verification after Apply & Verify.
- Added Before → After error reporting for AI fixes.
- Added coverage summary and weak-file detection from coverage-summary.json.
- Added explicit npm audit and outdated dependency scanning.
- Added local recurring-error tracking.
- Added safe Revert Last AI Apply with stale-content protection.
- Added Smart Commit Gate requiring a fresh READY quality result.
- Added Explain Current File to Smart Developer Assistant.


## 2.7.0

- Added AI Fix Studio with safe proposal, diff review, and explicit apply workflow.
- Added diagnostic-based AI code-fix proposals.
- Added selected-code refactor proposals.
- Added AI-generated test-file proposals with existing-file overwrite protection.
- Added immutable original/proposed virtual documents for diff review.
- Added stale-source protection so changed files cannot receive outdated AI proposals.
- AI proposals are never applied automatically.


## 2.6.0

- Added Smart Developer Assistant for test, build, lint, and typecheck workflows.
- Added captured task output with automatic AI analysis when a Command Center task fails.
- Added Clipboard Error Analyzer for runtime errors and stack traces.
- Added AI-assisted Git conflict review.
- Added staged-diff AI commit review.
- Added copy support for Smart Developer Assistant output and analysis.
- Kept terminal/runtime capture explicit: Command Center does not scrape unrelated terminal sessions.


## 2.5.0

- Added active coding-time history with daily goals, language time, file activity, edits, and saves.
- Added 25-minute, 50-minute, and custom focus timers with pause, resume, and stop controls.
- Added focus timer and coding-goal progress to the Galaxy status bar.
- Added AI Debug Assistant using available VS Code language models.
- Added error/warning detection, diagnostic navigation, and VS Code Quick Fix integration.
- Added opt-in Auto Analyze with throttling and limited nearby-code context.
- Fixed no-workspace detection so the installed extension directory is no longer treated as the active project.
- Coding history remains local and does not persist source-code contents.


## 2.3.0

- Added GitHub Issues, Pull Requests, and Actions workflow status for the current GitHub repository.
- Added Create GitHub Repository and Publish Current Project workflows.
- Added Create GitHub Issue and Create Pull Request actions.
- Added provider-native GitLab integration through the official `glab` CLI when installed and authenticated.
- Added provider-native Bitbucket bridge through Atlassian `twg` CLI commands when installed.
- Added GitLab repository listing, Open, and Clone actions through `glab`.
- Kept GitLab, Bitbucket, Azure DevOps, and generic remotes fully compatible with Fetch, Pull, Push, Sync, branches, origin, clone, and Open Remote.
- Added a warning before publishing when common root-level sensitive files are detected.


## 2.2.1

- Improved Windows reliability for Fetch, Pull, Push, and Sync by preferring VS Code's built-in Git commands.
- Added a shell-independent sync fallback that runs pull then push without relying on `&&` syntax.
- Repository controls now refresh the dashboard state after Git actions.

## 2.2.0

- Replaced the basic Git panel with a unified Repository Control Hub.
- Added remote-provider detection for GitHub, GitLab, Bitbucket, Azure DevOps, and generic Git remotes.
- Added Fetch, Pull, Push, Sync, Stage All, Unstage All, Commit, branch create/switch, origin management, repository initialization, remote opening, and repository cloning.
- Added secure GitHub sign-in through VS Code Authentication without persisting tokens in extension files.
- Added a GitHub repository list for recently updated owner/collaborator/organization repositories with Open and Clone actions.
- Generic Git controls continue to work with non-GitHub remotes after origin is configured.

## 2.1.0

- Added project-specific notes stored per workspace.
- Added live coding-session stats for session duration, files touched, Command Center commands run, and saves.
- Added lightweight workspace snapshots with theme, active developer mode, dashboard widget visibility, pinned commands, project note, and active file.
- Added snapshot restore and delete controls without changing Git branches or project file contents.

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
