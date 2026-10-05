const vscode = require('vscode');
const path = require('path');
const { execFileSync } = require('child_process');

function escapeHtml(value) {
  return String(value)
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

async function getGitState(extensionUri) {
  const fallback = { branch: 'No Git repo', changes: 0, sync: 'Offline' };
  if (!extensionUri?.fsPath) return fallback;

  const cwd = extensionUri.fsPath;
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

async function getWorkspaceState(extensionUri, version = 'dev') {
  const git = await getGitState(extensionUri);

  let workspaceName = 'No workspace open';
  if (vscode.workspace.workspaceFolders?.[0]?.name) {
    workspaceName = vscode.workspace.workspaceFolders[0].name;
  } else if (extensionUri?.fsPath) {
    workspaceName = path.basename(extensionUri.fsPath);
  }

  return {
    workspaceName,
    version,
    ...git
  };
}

function getDashboardHtml(state) {
  const workspace = escapeHtml(state.workspaceName);
  const branch = escapeHtml(state.branch);
  const sync = escapeHtml(state.sync);
  const version = escapeHtml(state.version || 'dev');

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
    --purple:#8b5cff;
    --magenta:#ff4fd8;
    --text:#d9f7ff;
    --muted:#76909f;
    --line:rgba(0,247,255,.22);
  }
  *{box-sizing:border-box}
  body{
    margin:0;
    min-height:100vh;
    color:var(--text);
    font-family:Inter,Segoe UI,sans-serif;
    background:
      radial-gradient(circle at 18% 12%,rgba(0,247,255,.09),transparent 28%),
      radial-gradient(circle at 82% 0%,rgba(139,92,255,.14),transparent 27%),
      linear-gradient(180deg,#02040d,#030611 65%,#02040d);
  }
  body:before{
    content:"";
    position:fixed;
    inset:0;
    pointer-events:none;
    background-image:
      linear-gradient(rgba(0,247,255,.025) 1px,transparent 1px),
      linear-gradient(90deg,rgba(0,247,255,.025) 1px,transparent 1px);
    background-size:38px 38px;
  }
  .shell{padding:30px;position:relative}
  .top{
    display:flex;
    justify-content:space-between;
    gap:24px;
    align-items:center;
    padding-bottom:22px;
    border-bottom:1px solid var(--line);
  }
  .brand{font-size:11px;letter-spacing:.18em;color:var(--cyan);margin:0 0 8px}
  h1{
    margin:0;
    font-size:clamp(30px,4vw,52px);
    background:linear-gradient(90deg,var(--cyan),#2b8cff,var(--purple),var(--magenta));
    -webkit-background-clip:text;
    color:transparent;
  }
  .online{color:var(--cyan);font-size:11px;letter-spacing:.13em}
  .orb{
    display:inline-block;
    width:9px;height:9px;border-radius:50%;
    margin-right:8px;
    background:var(--cyan);
    box-shadow:0 0 16px var(--cyan);
  }
  .telemetry{
    display:grid;
    grid-template-columns:repeat(4,minmax(0,1fr));
    gap:1px;
    margin:22px 0;
    border:1px solid var(--line);
    border-radius:14px;
    overflow:hidden;
    background:var(--line);
  }
  .telemetry>div{background:rgba(3,6,17,.96);padding:14px 16px;min-width:0}
  .telemetry span{display:block;font-size:9px;letter-spacing:.15em;color:var(--muted);margin-bottom:6px}
  .telemetry strong{display:block;color:var(--cyan);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}
  .card{
    min-height:190px;
    padding:22px;
    border:1px solid var(--line);
    border-radius:18px;
    background:linear-gradient(145deg,rgba(5,8,23,.95),rgba(8,12,31,.82));
    box-shadow:0 16px 45px rgba(0,0,0,.2);
  }
  .label{font-size:10px;letter-spacing:.16em;color:var(--cyan);margin-bottom:10px}
  .muted{color:var(--muted)}
  .metric{
    display:flex;
    justify-content:space-between;
    gap:16px;
    padding:11px 0;
    border-bottom:1px solid rgba(0,247,255,.08);
  }
  .metric strong{color:var(--purple)}
  .actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
  button{
    padding:12px 14px;
    border:1px solid var(--line);
    border-radius:10px;
    background:rgba(0,247,255,.035);
    color:var(--text);
    cursor:pointer;
    text-align:left;
  }
  button:hover{border-color:var(--cyan);box-shadow:0 0 20px rgba(0,247,255,.12)}
  button.wide{grid-column:1/-1}
  @media(max-width:820px){
    .grid,.telemetry{grid-template-columns:1fr}
    .top{align-items:flex-start;flex-direction:column}
  }
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
      <div><span>BRANCH</span><strong>${branch}</strong></div>
      <div><span>CHANGES</span><strong>${state.changes}</strong></div>
      <div><span>SYNC</span><strong>${sync}</strong></div>
    </section>

    <section class="grid">
      <article class="card">
        <div class="label">MISSION CONTROL</div>
        <h2>${workspace}</h2>
        <p class="muted">Dashboard runtime is active and connected to this VS Code window.</p>
      </article>

      <article class="card">
        <div class="label">QUICK ACTIONS</div>
        <div class="actions">
          <button data-command="terminal">Open Terminal</button>
          <button data-command="explorer">Explorer</button>
          <button data-command="sourceControl">Source Control</button>
          <button data-command="theme">Theme Selector</button>
          <button class="wide" data-command="refresh">Refresh Telemetry</button>
        </div>
      </article>

      <article class="card">
        <div class="label">GIT TELEMETRY</div>
        <div class="metric"><span>Active Branch</span><strong>${branch}</strong></div>
        <div class="metric"><span>Working Changes</span><strong>${state.changes}</strong></div>
        <div class="metric"><span>Remote State</span><strong>${sync}</strong></div>
      </article>

      <article class="card">
        <div class="label">NEXT SYSTEMS</div>
        <p class="muted">Recent Files • Project Launcher • Project Health • Dev Modes</p>
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
</script>
</body>
</html>`;
}

async function runAction(command) {
  switch (command) {
    case 'terminal':
      return vscode.commands.executeCommand('workbench.action.terminal.toggleTerminal');
    case 'explorer':
      return vscode.commands.executeCommand('workbench.view.explorer');
    case 'sourceControl':
      return vscode.commands.executeCommand('workbench.view.scm');
    case 'theme':
      return vscode.commands.executeCommand('workbench.action.selectTheme');
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
      const state = await getWorkspaceState(this.extensionUri, vscode.extensions.getExtension('gitwithmasum.masum-galaxy-command-center')?.packageJSON?.version || 'dev');
      webviewView.webview.html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
body{font-family:var(--vscode-font-family);padding:12px;color:var(--vscode-foreground)}
.brand{color:#00f7ff;font-size:11px;letter-spacing:.16em}
.card{border:1px solid rgba(0,247,255,.2);border-radius:10px;padding:10px;margin-top:10px}
button{width:100%;margin-top:8px;padding:8px;border:1px solid rgba(0,247,255,.22);background:transparent;color:var(--vscode-foreground);border-radius:8px;cursor:pointer}
</style>
</head>
<body>
<div class="brand">MASUM GALAXY // COMMAND CENTER</div>
<div class="card">
  <div>Workspace: <strong>${escapeHtml(state.workspaceName)}</strong></div>
  <div>Branch: <strong>${escapeHtml(state.branch)}</strong></div>
  <div>Changes: <strong>${state.changes}</strong></div>
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
      await runAction(message.command);
    });

    render();
  }

  refresh() {
    if (this.view) {
      vscode.commands.executeCommand('workbench.view.extension.galaxyCommandCenter');
    }
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

    panel.reveal(vscode.ViewColumn.One);

    const render = async () => {
      const state = await getWorkspaceState(context.extensionUri, context.extension.packageJSON.version);
      panel.webview.html = getDashboardHtml(state);
    };

    panel.webview.onDidReceiveMessage(async (message) => {
      if (message.command === 'refresh') {
        await render();
        return;
      }
      await runAction(message.command);
    });

    await render();
    vscode.window.setStatusBarMessage('Galaxy Command Center opened', 2500);
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
      sidebarProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('galaxyCommandCenter.diagnose', async () => {
      const state = await getWorkspaceState(context.extensionUri, context.extension.packageJSON.version);
      const message =
        `Galaxy Command Center active | mode=${context.extensionMode} | workspace=${state.workspaceName} | branch=${state.branch} | changes=${state.changes}`;
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
    console.log('[Galaxy Command Center] Development mode detected. Auto-opening dashboard...');
    try {
      await openDashboard(context);
      console.log('[Galaxy Command Center] Dashboard auto-open completed');
    } catch (error) {
      console.error('[Galaxy Command Center] Dashboard auto-open failed:', error);
      vscode.window.showErrorMessage(
        'Galaxy Command Center could not auto-open the dashboard. Check Debug Console.'
      );
    }
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
