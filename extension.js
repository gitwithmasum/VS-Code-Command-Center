const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function runGit(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return '';
  }
}

function getWorkspaceRoot(extensionUri) {
  return vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || extensionUri?.fsPath || '';
}

async function getGitState(extensionUri) {
  const fallback = { branch: 'No Git repo', changes: 0, sync: 'Offline' };
  const cwd = getWorkspaceRoot(extensionUri);
  if (!cwd) return fallback;

  const inside = runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') return fallback;

  const branch =
    runGit(cwd, ['branch', '--show-current']) ||
    runGit(cwd, ['rev-parse', '--short', 'HEAD']) ||
    'Detached';

  const status = runGit(cwd, ['status', '--porcelain']);
  const changes = status ? status.split(/\r?\n/).filter(Boolean).length : 0;

  let sync = 'Local';
  const upstream = runGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (upstream) {
    const counts = runGit(cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
    const [aheadRaw, behindRaw] = counts.split(/\s+/);
    const ahead = Number(aheadRaw || 0);
    const behind = Number(behindRaw || 0);
    sync = ahead || behind ? `↑${ahead} ↓${behind}` : 'Synced';
  }

  return { branch, changes, sync };
}

async function readJsonIfExists(filePath) {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function detectProject(extensionUri) {
  const root = getWorkspaceRoot(extensionUri);
  if (!root) {
    return { type: 'No workspace', actions: [] };
  }

  const packageJson = await readJsonIfExists(path.join(root, 'package.json'));
  const hasRequirements = fs.existsSync(path.join(root, 'requirements.txt'));
  const hasPyProject = fs.existsSync(path.join(root, 'pyproject.toml'));
  const hasPython = hasRequirements || hasPyProject;
  const actions = [];
  let type = 'General Workspace';

  if (packageJson) {
    const deps = {
      ...(packageJson.dependencies || {}),
      ...(packageJson.devDependencies || {})
    };

    if (packageJson.engines?.vscode || packageJson.contributes) {
      type = 'VS Code Extension';
      actions.push(
        { id: 'npmInstall', label: 'npm install', command: 'npm.cmd install' },
        { id: 'packageVsix', label: 'Package VSIX', command: 'npx.cmd vsce package' }
      );
    } else if (deps.next) {
      type = 'Next.js';
    } else if (deps.react) {
      type = deps.vite ? 'React / Vite' : 'React';
    } else {
      type = 'Node.js';
    }

    const scripts = packageJson.scripts || {};
    const preferredScripts = ['dev', 'start', 'build', 'test'];
    for (const script of preferredScripts) {
      if (scripts[script] && actions.length < 4) {
        actions.push({
          id: `npm-${script}`,
          label: `npm run ${script}`,
          command: `npm run ${script}`
        });
      }
    }
  }

  if (hasPython && !packageJson) {
    type = 'Python';
    actions.push(
      { id: 'runPython', label: 'Run Python File', vscodeCommand: 'python.execInTerminal' },
      { id: 'selectInterpreter', label: 'Select Interpreter', vscodeCommand: 'python.setInterpreter' }
    );
  }

  if (!actions.length) {
    actions.push(
      { id: 'terminal', label: 'Open Terminal', vscodeCommand: 'workbench.action.terminal.toggleTerminal' },
      { id: 'explorer', label: 'Open Explorer', vscodeCommand: 'workbench.view.explorer' }
    );
  }

  return { type, actions: actions.slice(0, 4) };
}

async function getProjectHealth(extensionUri) {
  const root = getWorkspaceRoot(extensionUri);
  let errors = 0;
  let warnings = 0;

  for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
    if (root && !uri.fsPath.toLowerCase().startsWith(root.toLowerCase())) continue;
    for (const diagnostic of diagnostics) {
      if (diagnostic.severity === vscode.DiagnosticSeverity.Error) errors++;
      if (diagnostic.severity === vscode.DiagnosticSeverity.Warning) warnings++;
    }
  }

  let todoCount = 0;
  if (vscode.workspace.workspaceFolders?.length) {
    const files = await vscode.workspace.findFiles(
      '**/*.{js,jsx,ts,tsx,py,html,css,scss,json,md}',
      '**/{node_modules,.git,dist,build,out,.next,coverage}/**',
      120
    );

    for (const uri of files) {
      if (todoCount >= 999) break;
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const matches = doc.getText().match(/\b(TODO|FIXME)\b/gi);
        if (matches) todoCount += matches.length;
      } catch {
        // Ignore unreadable files.
      }
    }
  }

  return {
    errors,
    warnings,
    todos: todoCount,
    status: errors === 0 ? (warnings === 0 ? 'Healthy' : 'Review') : 'Attention'
  };
}

async function getRecentFiles() {
  if (!vscode.workspace.workspaceFolders?.length) return [];

  const files = await vscode.workspace.findFiles(
    '**/*.{js,jsx,ts,tsx,py,html,css,scss,json,md,yml,yaml}',
    '**/{node_modules,.git,dist,build,out,.next,coverage}/**',
    80
  );

  const records = [];
  for (const uri of files) {
    try {
      const stat = await fs.promises.stat(uri.fsPath);
      records.push({ uri, mtime: stat.mtimeMs });
    } catch {
      // Ignore files that disappear during scan.
    }
  }

  records.sort((a, b) => b.mtime - a.mtime);

  return records.slice(0, 6).map(({ uri }) => ({
    label: path.basename(uri.fsPath),
    relative: vscode.workspace.asRelativePath(uri, false),
    uri: uri.toString()
  }));
}

async function getWorkspaceState(extensionUri, version = 'dev') {
  const [git, project, health, recentFiles] = await Promise.all([
    getGitState(extensionUri),
    detectProject(extensionUri),
    getProjectHealth(extensionUri),
    getRecentFiles()
  ]);

  let workspaceName = 'No workspace open';
  if (vscode.workspace.workspaceFolders?.[0]?.name) {
    workspaceName = vscode.workspace.workspaceFolders[0].name;
  } else if (extensionUri?.fsPath) {
    workspaceName = path.basename(extensionUri.fsPath);
  }

  return {
    workspaceName,
    version,
    repoPath: getWorkspaceRoot(extensionUri),
    project,
    health,
    recentFiles,
    ...git
  };
}

function renderRecentFiles(files) {
  if (!files.length) {
    return '<p class="muted">No workspace files available yet.</p>';
  }

  return files
    .map(
      (file) => `
        <button class="file-row" data-file-uri="${escapeHtml(file.uri)}" title="${escapeHtml(file.relative)}">
          <span class="file-icon">◇</span>
          <span class="file-copy">
            <strong>${escapeHtml(file.label)}</strong>
            <small>${escapeHtml(file.relative)}</small>
          </span>
        </button>`
    )
    .join('');
}

function renderSmartActions(actions) {
  return actions
    .map((action) => {
      const command = action.command ? escapeHtml(action.command) : '';
      const vscodeCommand = action.vscodeCommand ? escapeHtml(action.vscodeCommand) : '';
      return `
        <button class="smart-action" data-terminal-command="${command}" data-vscode-command="${vscodeCommand}">
          <span>▶</span> ${escapeHtml(action.label)}
        </button>`;
    })
    .join('');
}

function getDashboardHtml(state) {
  const workspace = escapeHtml(state.workspaceName);
  const branch = escapeHtml(state.branch);
  const sync = escapeHtml(state.sync);
  const version = escapeHtml(state.version || 'dev');
  const projectType = escapeHtml(state.project.type);
  const healthStatus = escapeHtml(state.health.status);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Masum Galaxy // Command Center</title>
<style>
  :root{
    color-scheme:dark;
    --bg:#02040d;
    --panel:#050817;
    --cyan:#00f7ff;
    --blue:#2b8cff;
    --purple:#8b5cff;
    --magenta:#ff4fd8;
    --text:#d9f7ff;
    --muted:#76909f;
    --line:rgba(0,247,255,.22);
    --soft:rgba(0,247,255,.045);
  }
  *{box-sizing:border-box}
  body{
    margin:0;min-height:100vh;color:var(--text);
    font-family:Inter,Segoe UI,sans-serif;
    background:
      radial-gradient(circle at 18% 12%,rgba(0,247,255,.09),transparent 28%),
      radial-gradient(circle at 82% 0%,rgba(139,92,255,.14),transparent 27%),
      linear-gradient(180deg,#02040d,#030611 65%,#02040d);
  }
  body:before{
    content:"";position:fixed;inset:0;pointer-events:none;
    background-image:
      linear-gradient(rgba(0,247,255,.025) 1px,transparent 1px),
      linear-gradient(90deg,rgba(0,247,255,.025) 1px,transparent 1px);
    background-size:38px 38px;
  }
  .shell{padding:30px;position:relative}
  .top{display:flex;justify-content:space-between;gap:24px;align-items:center;padding-bottom:22px;border-bottom:1px solid var(--line)}
  .brand,.label{font-size:10px;letter-spacing:.17em;color:var(--cyan);margin:0 0 9px}
  h1{margin:0;font-size:clamp(30px,4vw,52px);background:linear-gradient(90deg,var(--cyan),var(--blue),var(--purple),var(--magenta));-webkit-background-clip:text;color:transparent}
  h2,h3,p{margin-top:0}
  .online{color:var(--cyan);font-size:11px;letter-spacing:.13em;white-space:nowrap}
  .orb{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:8px;background:var(--cyan);box-shadow:0 0 16px var(--cyan)}
  .telemetry{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:1px;margin:22px 0;border:1px solid var(--line);border-radius:14px;overflow:hidden;background:var(--line)}
  .telemetry>div{background:rgba(3,6,17,.96);padding:14px 16px;min-width:0}
  .telemetry span{display:block;font-size:9px;letter-spacing:.15em;color:var(--muted);margin-bottom:6px}
  .telemetry strong{display:block;color:var(--cyan);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}
  .card{min-height:190px;padding:22px;border:1px solid var(--line);border-radius:18px;background:linear-gradient(145deg,rgba(5,8,23,.95),rgba(8,12,31,.82));box-shadow:0 16px 45px rgba(0,0,0,.2)}
  .card.wide{grid-column:1/-1}
  .muted{color:var(--muted)}
  .metric{display:flex;justify-content:space-between;gap:16px;padding:11px 0;border-bottom:1px solid rgba(0,247,255,.08)}
  .metric strong{color:var(--purple)}
  .actions,.smart-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
  button{padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:var(--soft);color:var(--text);cursor:pointer;text-align:left;transition:.16s ease}
  button:hover{transform:translateY(-1px);border-color:var(--cyan);box-shadow:0 0 20px rgba(0,247,255,.12)}
  button span{color:var(--cyan);margin-right:6px}
  button.wide{grid-column:1/-1}
  .health-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
  .health-box{padding:14px;border:1px solid rgba(139,92,255,.18);border-radius:12px;background:rgba(139,92,255,.035)}
  .health-box span{display:block;color:var(--muted);font-size:10px;letter-spacing:.1em;margin-bottom:7px}
  .health-box strong{font-size:20px;color:var(--text)}
  .health-box.status strong{color:var(--cyan);font-size:16px}
  .files{display:grid;gap:8px}
  .file-row{display:flex;align-items:center;width:100%;gap:10px}
  .file-icon{font-size:18px}
  .file-copy{min-width:0;display:flex;flex-direction:column}
  .file-copy strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .file-copy small{margin-top:3px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .project-pill{display:inline-flex;align-items:center;gap:8px;padding:8px 11px;border:1px solid rgba(0,247,255,.18);border-radius:999px;color:var(--cyan);font-size:11px;margin:10px 0 18px}
  @media(max-width:900px){.telemetry{grid-template-columns:repeat(2,1fr)}.health-grid{grid-template-columns:repeat(2,1fr)}}
  @media(max-width:820px){.grid,.telemetry{grid-template-columns:1fr}.top{align-items:flex-start;flex-direction:column}.card.wide{grid-column:auto}}
</style>
</head>
<body>
<main class="shell">
  <header class="top">
    <div>
      <p class="brand">MASUM GALAXY</p>
      <h1>// COMMAND CENTER</h1>
    </div>
    <div class="online"><span class="orb"></span>SYSTEM ONLINE · v${version}</div>
  </header>

  <section class="telemetry">
    <div><span>WORKSPACE</span><strong>${workspace}</strong></div>
    <div><span>PROJECT TYPE</span><strong>${projectType}</strong></div>
    <div><span>BRANCH</span><strong>${branch}</strong></div>
    <div><span>CHANGES</span><strong>${state.changes}</strong></div>
    <div><span>SYNC</span><strong>${sync}</strong></div>
  </section>

  <section class="grid">
    <article class="card">
      <div class="label">MISSION CONTROL</div>
      <h2>${workspace}</h2>
      <div class="project-pill">◉ ${projectType}</div>
      <p class="muted">Workspace intelligence is active. Use the smart actions below to run common project tasks without hunting through menus.</p>
    </article>

    <article class="card">
      <div class="label">QUICK ACTIONS</div>
      <div class="actions">
        <button data-command="terminal"><span>⌁</span>Open Terminal</button>
        <button data-command="explorer"><span>◫</span>Explorer</button>
        <button data-command="sourceControl"><span>⑂</span>Source Control</button>
        <button data-command="theme"><span>✦</span>Theme Selector</button>
        <button class="wide" data-command="refresh"><span>↻</span>Refresh Intelligence</button>
      </div>
    </article>

    <article class="card wide">
      <div class="label">PROJECT HEALTH</div>
      <div class="health-grid">
        <div class="health-box"><span>ERRORS</span><strong>${state.health.errors}</strong></div>
        <div class="health-box"><span>WARNINGS</span><strong>${state.health.warnings}</strong></div>
        <div class="health-box"><span>TODO / FIXME</span><strong>${state.health.todos}</strong></div>
        <div class="health-box status"><span>STATUS</span><strong>${healthStatus}</strong></div>
      </div>
    </article>

    <article class="card">
      <div class="label">SMART PROJECT ACTIONS</div>
      <div class="smart-grid">
        ${renderSmartActions(state.project.actions)}
      </div>
    </article>

    <article class="card">
      <div class="label">GIT TELEMETRY</div>
      <div class="metric"><span>Active Branch</span><strong>${branch}</strong></div>
      <div class="metric"><span>Working Changes</span><strong>${state.changes}</strong></div>
      <div class="metric"><span>Remote State</span><strong>${sync}</strong></div>
    </article>

    <article class="card wide">
      <div class="label">RECENT FILES</div>
      <div class="files">
        ${renderRecentFiles(state.recentFiles)}
      </div>
    </article>
  </section>
</main>

<script>
  const vscode = acquireVsCodeApi();

  document.querySelectorAll('[data-command]').forEach((button) => {
    button.addEventListener('click', () => {
      vscode.postMessage({ command: button.dataset.command });
    });
  });

  document.querySelectorAll('[data-terminal-command]').forEach((button) => {
    button.addEventListener('click', () => {
      const terminalCommand = button.dataset.terminalCommand;
      const vscodeCommand = button.dataset.vscodeCommand;
      if (terminalCommand) vscode.postMessage({ command: 'runTerminal', value: terminalCommand });
      if (vscodeCommand) vscode.postMessage({ command: 'runVsCodeCommand', value: vscodeCommand });
    });
  });

  document.querySelectorAll('[data-file-uri]').forEach((button) => {
    button.addEventListener('click', () => {
      vscode.postMessage({ command: 'openFile', value: button.dataset.fileUri });
    });
  });
</script>
</body>
</html>`;
}

async function runAction(command, value) {
  switch (command) {
    case 'terminal':
      return vscode.commands.executeCommand('workbench.action.terminal.toggleTerminal');
    case 'explorer':
      return vscode.commands.executeCommand('workbench.view.explorer');
    case 'sourceControl':
      return vscode.commands.executeCommand('workbench.view.scm');
    case 'theme':
      return vscode.commands.executeCommand('workbench.action.selectTheme');
    case 'runTerminal': {
      const terminal = vscode.window.createTerminal({ name: 'Galaxy Command Center' });
      terminal.show();
      terminal.sendText(value, true);
      return;
    }
    case 'runVsCodeCommand':
      return vscode.commands.executeCommand(value);
    case 'openFile': {
      const uri = vscode.Uri.parse(value);
      const document = await vscode.workspace.openTextDocument(uri);
      return vscode.window.showTextDocument(document, { preview: false });
    }
    default:
      return undefined;
  }
}

class GalaxySidebarProvider {
  constructor(extensionUri) {
    this.extensionUri = extensionUri;
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };

    const render = async () => {
      const version =
        vscode.extensions.getExtension('gitwithmasum.masum-galaxy-command-center')
          ?.packageJSON?.version || 'dev';
      const state = await getWorkspaceState(this.extensionUri, version);

      webviewView.webview.html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
body{font-family:var(--vscode-font-family);padding:12px;color:var(--vscode-foreground)}
.brand{color:#00f7ff;font-size:11px;letter-spacing:.16em}
.card{border:1px solid rgba(0,247,255,.2);border-radius:10px;padding:10px;margin-top:10px}
.row{display:flex;justify-content:space-between;gap:8px;margin-top:6px;font-size:11px}
button{width:100%;margin-top:8px;padding:8px;border:1px solid rgba(0,247,255,.22);background:transparent;color:var(--vscode-foreground);border-radius:8px;cursor:pointer}
</style>
</head>
<body>
<div class="brand">MASUM GALAXY // COMMAND CENTER</div>
<div class="card">
  <strong>${escapeHtml(state.workspaceName)}</strong>
  <div class="row"><span>Type</span><span>${escapeHtml(state.project.type)}</span></div>
  <div class="row"><span>Branch</span><span>${escapeHtml(state.branch)}</span></div>
  <div class="row"><span>Errors</span><span>${state.health.errors}</span></div>
  <div class="row"><span>Warnings</span><span>${state.health.warnings}</span></div>
</div>
<button onclick="send('openDashboard')">Open Full Dashboard</button>
<button onclick="send('terminal')">Terminal</button>
<button onclick="send('sourceControl')">Source Control</button>
<script>
const vscode=acquireVsCodeApi();
function send(command){vscode.postMessage({command});}
</script>
</body>
</html>`;
    };

    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (message.command === 'openDashboard') {
        await vscode.commands.executeCommand('galaxyCommandCenter.open');
        return;
      }
      await runAction(message.command, message.value);
    });

    render();
  }

  async refresh() {
    if (!this.view) return;
    await vscode.commands.executeCommand('workbench.view.extension.galaxyCommandCenter');
  }
}

async function openDashboard(context) {
  try {
    const panel = vscode.window.createWebviewPanel(
      'galaxyCommandCenter',
      'Masum Galaxy // Command Center',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    const render = async () => {
      const state = await getWorkspaceState(
        context.extensionUri,
        context.extension.packageJSON.version
      );
      panel.webview.html = getDashboardHtml(state);
    };

    panel.webview.onDidReceiveMessage(async (message) => {
      if (message.command === 'refresh') {
        await render();
        return;
      }
      await runAction(message.command, message.value);
    });

    await render();
    panel.reveal(vscode.ViewColumn.One);
    vscode.window.setStatusBarMessage('Galaxy Command Center ready', 2200);
  } catch (error) {
    console.error('[Galaxy Command Center] Dashboard failed:', error);
    vscode.window.showErrorMessage(
      'Galaxy Command Center failed to open. Check the Extension Host console for details.'
    );
  }
}

async function activate(context) {
  console.log('[Galaxy Command Center] Extension activated');

  const sidebarProvider = new GalaxySidebarProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'galaxyCommandCenter.sidebar',
      sidebarProvider
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('galaxyCommandCenter.open', async () => {
      await openDashboard(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('galaxyCommandCenter.refresh', async () => {
      await sidebarProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('galaxyCommandCenter.diagnose', async () => {
      const state = await getWorkspaceState(
        context.extensionUri,
        context.extension.packageJSON.version
      );
      const message =
        `Galaxy Command Center active | workspace=${state.workspaceName} | type=${state.project.type} | branch=${state.branch} | errors=${state.health.errors} | warnings=${state.health.warnings}`;
      console.log('[Galaxy Command Center] Diagnose:', message);
      vscode.window.showInformationMessage(message);
    })
  );

  const statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusItem.text = '$(rocket) Galaxy';
  statusItem.tooltip = 'Open Masum Galaxy // Command Center';
  statusItem.command = 'galaxyCommandCenter.open';
  statusItem.show();
  context.subscriptions.push(statusItem);

  if (context.extensionMode === vscode.ExtensionMode.Development) {
    await openDashboard(context);
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
