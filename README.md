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

## Stability + Modular Cleanup — v2.8.1

- Started modularizing the 200 KB+ extension host code into `src/core`
- Extracted workspace helpers and Git helpers
- Fixed JSON project metadata reads so Smart Project task detection and test-framework detection work reliably
- Command Center, Git, and provider terminals now open with the active workspace as their working directory
- Hardened last-commit parsing when commit subjects contain the `|` character
- Added confirmation before deleting workspace snapshots
- Improved VS Code command session counting and dashboard refresh after launched commands
- Added a prepublish syntax gate for the main extension and extracted core modules

## Galaxy CP Arena — v2.9

- Local contest countdown with custom duration
- Problem tracker for A–H with per-problem active time
- Problem states: Not Started, Solving, WA, TLE, RE, and AC
- Local Sample Judge for C/C++, Python, and JavaScript
- Native C/C++ compile support through gcc/g++ when installed
- Expected-vs-actual output comparison with PASS / WRONG ANSWER / TLE / runtime / compile verdicts
- Runtime display and stderr preview
- C++ / Python CP Snippet Vault
- AI Complexity analysis for selected code or the current source file
- AI Edge Case generator
- Panic Assist with three escalating hints from a copied problem statement instead of a full solution
- CP Focus Mode using VS Code Zen Mode
- Quick links for Codeforces, AtCoder, LeetCode, and CodeChef
- CP session state is stored locally in VS Code; no database is required

## CP Advanced Judge — v2.9.1

- Multi Test Case Runner using `---` as the case separator
- Optional expected outputs for run-only multi-case practice
- Compile once and reuse the same runner across a multi-case suite
- Verdict history for sample, multi-case, and stress-test runs
- Automatic WA / TLE / RE / CE problem-state tracking from local judge failures
- Official AC remains explicit because passing samples is not the same as an online-judge acceptance
- Stress Test workflow: current file = optimized solution, then choose generator + brute solution
- Up to 100 stress iterations with failing input and brute-vs-optimized output shown on mismatch
- C++17, Python 3, and JavaScript starter templates
- One-click New Problem File with a safe Save As flow
- Contest timing hardening when the timer expires before a problem switch

## Developer Analytics + Project Intelligence — v3.0

- 7-day and 30-day active coding-time analytics
- Coding streak and 30-day active-day count
- 30-day language-time distribution
- 7-day and 30-day local Git commit analytics
- Quality Gate history with average score and READY rate
- Daily Project Health trend with score, errors, warnings, and TODO/FIXME counts
- Competitive-programming performance analytics with judged-run pass rate, stress-test count, average runtime, and preserved official AC history
- New Developer Intelligence dashboard with compact activity bars and trend panels
- Export Developer Analytics as JSON
- Fixed active coding language tracking so analytics record the active editor language reliably
- New CP contests preserve long-term CP run/AC history; Reset Arena still clears the CP session intentionally
- Coding analytics are local VS Code activity data; project/Git/Quality/CP analytics are scoped to the current workspace
- No analytics database or cloud sync is required

## Workspace Architecture Intelligence — v3.1

- Local workspace structure map with top-level file/line counts
- Entry-point detection from common filenames and package.json entry fields
- Local module relationships for JS/TS imports, C/C++ quoted includes, and Python relative imports
- Central-module scoring using inbound/outbound local dependency links
- Dependency-cycle detection
- Large-source-file and static risk-hotspot panels
- Language/file distribution across the scanned workspace
- Find Feature search for symbols, concepts, filenames, and implementation clues
- Search results open directly at the matched file/line
- Optional AI Explain Matches summarizes only the local search snippets you explicitly choose to analyze
- Export Workspace Architecture as JSON
- Generated/vendor directories are ignored, scanning is capped, and results are cached for 90 seconds to reduce extension-host overhead

## Workspace Task Orchestrator — v3.2

- Auto-discovers all `package.json` scripts in the active workspace
- Classifies common build, test, lint, typecheck, dev, format, clean, and release tasks
- Command Graph detects script-to-script references and npm pre-script dependencies
- Run any discovered task directly from the dashboard
- Verify Pipeline runs available lint → typecheck → test → build steps sequentially and stops on failure
- Ship Pipeline runs Build → Test → Quality Gate → Smart Commit
- Saved workflows support sequential or parallel execution
- Sequential saved workflows stop on the first failure
- Workflow run history stores metadata only; captured command output remains in-memory
- Added shared Windows-safe process execution for npm.cmd / pnpm.cmd / yarn.cmd
- Windows command execution uses the system command processor only for .cmd/.bat executables while keeping shell=false for arbitrary commands
- Task results capture exit code, timeout state, duration, and bounded stdout/stderr

## Stability + Privacy Hardening — v3.2.1

- Recurring diagnostic history no longer stores raw diagnostic messages
- Existing raw diagnostic recurrence records are migrated on activation
- Quality Gate state resets when the active workspace changes
- Quality Gate blocks duplicate runs and prompts to save dirty workspace files first
- Smart Commit freshness now fingerprints staged changes instead of trusting time alone
- Smart Commit reruns verification when staged content changes
- Coverage weak-file paths now handle absolute and relative coverage keys correctly
- Failed task output stays local unless you explicitly approve AI analysis
- AI Fix edit prompts now define VS Code end-exclusive range semantics
- AI diff preview URIs preserve source filename extensions for better syntax highlighting
- Task Orchestrator supports Cancel Run and propagates cancellation through captured processes
- Startup diagnostics initialize recurrence signatures to avoid false recurrence increments
- AI rollback is blocked when the last apply belongs to a different workspace
- Added .vscodeignore so VSIX packaging excludes old VSIX files, editor-only config, coverage, logs, and Git metadata

## Modular Core + Automated Tests — v3.2.2

- Extracted Quality Gate pure logic into `src/features/quality.js`
- Extracted CP judge normalization/verdict/case logic into `src/features/cp-core.js`
- Quality module now owns scoring, coverage normalization, staged-change fingerprinting, and diagnostic privacy migration helpers
- CP core now owns output normalization, PASS/WA/TLE/RE mapping, multi-case splitting, and tracker-status mapping
- JavaScript CP runner now invokes the actual `node` command instead of the VS Code extension-host executable
- Added built-in Node test suite with no extra test-framework dependency
- Added Quality Gate tests for READY/REVIEW/BLOCKED scoring, coverage normalization, fingerprint changes, and privacy migration
- Added Task Orchestrator tests for package-manager detection, task classification, command-graph edges, Verify order, and Ship order
- Added Architecture Intelligence tests for entry points, local relationships, cycles, risk hotspots, and feature search
- Added CP core tests for output normalization, verdicts, multi-case parsing, and no auto-AC behavior
- `npm test` runs all core tests with Node's built-in test runner
- `vscode:prepublish` now runs syntax checks and automated tests before a VSIX can be packaged
- Test files are excluded from the final VSIX package through `.vscodeignore`

## CI Intelligence + Ready-to-Push Center — v3.3

- Detects local GitHub Actions workflows from `.github/workflows/*.yml|yaml`
- Extracts workflow job IDs and referenced npm / pnpm / yarn scripts
- Maps local Task Orchestrator scripts against scripts referenced by CI
- Loads current-branch GitHub Actions runs through the existing VS Code GitHub sign-in
- Loads job-level status for the latest relevant workflow run
- Surfaces failing CI jobs directly in the Command Center
- Tracks Git branch, upstream, ahead/behind, dirty state, conflicts, and commits ready to push
- Combines Git, local task results, Quality Gate freshness, workflow presence, and GitHub Actions into READY / REVIEW / BLOCKED
- Quality Gate must match the current Git HEAD/staged fingerprint to count as fresh
- Run Ready Check executes available local verification tasks, then Quality Gate, then refreshes CI
- Push If Ready refuses to push unless the readiness verdict is READY and always shows a final modal confirmation
- Open Actions jumps directly to the repository Actions page
- Added `src/features/ci.js` with automated CI-readiness tests
- Added repository GitHub Actions workflow: install → syntax check → automated tests → VSIX package artifact
- Detects GitHub branch protection for the current branch when the connected account can read it
- Protected branches that require pull requests remain REVIEW for direct-push readiness instead of being marked READY

### Ready-to-Push verdict

- **READY** — no blocking Git state, current Quality Gate is fresh/READY, local verification passed, and CI baseline/current run is passing.
- **REVIEW** — something is incomplete but not proven broken, such as no upstream, uncommitted files, missing CI result, or stale local verification.
- **BLOCKED** — merge conflicts, branch behind upstream, failed local workflow, BLOCKED Quality Gate, or failed GitHub Actions.

## Galaxy AI Agent Mode — v3.4

- New memory-only Galaxy AI Agent dashboard
- Enter a natural-language developer goal such as `prepare this project for release`
- AI creates a plan only; it does not directly execute arbitrary model-generated commands
- Every plan is normalized against a fixed action whitelist
- Unknown or invented actions are discarded
- Local deterministic fallback planning works when no VS Code language model is available or an AI plan cannot be parsed safely
- Supported actions include workspace inspection, Verify Pipeline, Quality Gate, CI refresh, staged-change review, diagnostic analysis, AI fix proposal, Smart Commit Gate, and Push If Ready
- Agent execution is step-by-step through `Run Next Step`
- Verification/AI steps require explicit approval before execution
- Commit and push steps are classified as write actions and require agent approval plus their existing downstream confirmation gates
- Agent never gets a free-form shell execution capability
- AI Fix actions create reviewable proposals only; they do not silently apply source changes
- Agent plans, goals, step results, and model state are kept in memory only and are not persisted to a database or coding history
- New `src/features/agent.js` pure core validates plans, action risk, progression, fallback planning, and completion state
- Added automated Agent tests to the existing `npm test` and prepublish gates

## Developer Knowledge Graph — v3.5

- Builds a local project-wide graph from the existing Architecture Intelligence scan
- Indexes functions/classes and local import relationships
- **Who Calls This?** finds cross-file references to a uniquely indexed symbol
- **File Impact** traces direct and transitive reverse dependencies to show what a change may affect
- **Find Feature / Flow** searches filenames, symbols, and semantic project layers
- Detects likely Authentication, Database, API/HTTP, UI, Tests, and Configuration layers
- Opens matched files directly from the dashboard
- Symbol references are intentionally labeled heuristic; the graph does not pretend to be a compiler/type checker
- Source code stays local; this feature does not send project content to an AI service
- Graph results are workspace-scoped and cached for 90 seconds, with an explicit Rebuild Graph action

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
