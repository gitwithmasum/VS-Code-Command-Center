const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

function getGitState() {
  const fallback = { branch: 'No Git repo', changes: 0, sync: 'Offline' };
  try {
    const gitExtension = vscode.extensions.getExtension('vscode.git');
    if (!gitExtension) return fallback;

    const git = gitExtension.isActive
      ? gitExtension.exports.getAPI(1)
      : undefined;

    if (!git || !git.repositories.length) return fallback;

    const repo = git.repositories[0];
    const branch = repo.state.HEAD?.name || 'Detached';
    const changes =
      repo.state.workingTreeChanges.length +
      repo.state.indexChanges.length +
      repo.state.mergeChanges.length;

    const ahead = repo.state.HEAD?.ahead || 0;
    const behind = repo.state.HEAD?.behind || 0;
    const sync = ahead || behind ? `↑${ahead} ↓${behind}` : 'Synced';

    return { branch, changes, sync };
  } catch {
    return fallback;
  }
}

function getWorkspaceState() {
  return {
    workspaceName: vscode.workspace.workspaceFolders?.[0]?.name || 'No workspace open',
    ...getGitState()
  };
}

function renderDashboardHtml(panel, extensionPath) {
  const webviewDir = path.join(extensionPath, 'webview');
  const html = fs.readFileSync(path.join(webviewDir, 'index.html'), 'utf8');
  const stylesUri = panel.webview.asWebviewUri(
    vscode.Uri.file(path.join(webviewDir, 'styles.css'))
  );
  const scriptUri = panel.webview.asWebviewUri(
    vscode.Uri.file(path.join(webviewDir, 'app.js'))
  );

  const state = getWorkspaceState();

  return html
    .replaceAll('{{stylesUri}}', stylesUri.toString())
    .replaceAll('{{scriptUri}}', scriptUri.toString())
    .replaceAll('{{workspaceName}}', escapeHtml(state.workspaceName))
    .replaceAll('{{gitBranch}}', escapeHtml(state.branch))
    .replaceAll('{{gitChanges}}', String(state.changes))
    .replaceAll('{{gitSync}}', escapeHtml(state.sync));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
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
    case 'openDashboard':
      return vscode.commands.executeCommand('galaxyCommandCenter.open');
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

    const update = () => {
      const state = getWorkspaceState();
      webviewView.webview.html = this.getHtml(state);
    };

    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (message.command === 'refresh') {
        update();
        return;
      }
      await runAction(message.command);
    });

    update();
  }

  refresh() {
    if (!this.view) return;
    const state = getWorkspaceState();
    this.view.webview.html = this.getHtml(state);
  }

  getHtml(state) {
    const workspace = escapeHtml(state.workspaceName);
    const branch = escapeHtml(state.branch);
    const sync = escapeHtml(state.sync);

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  :root {
    color-scheme: dark;
    --cyan:#00f7ff;
    --purple:#8b5cff;
    --panel:rgba(5,8,23,.88);
    --line:rgba(0,247,255,.22);
    --muted:#7e98a8;
  }
  *{box-sizing:border-box}
  body{
    margin:0;
    padding:14px;
    color:var(--vscode-foreground);
    font-family:var(--vscode-font-family);
    background:
      radial-gradient(circle at 80% 0%,rgba(139,92,255,.12),transparent 34%),
      radial-gradient(circle at 10% 20%,rgba(0,247,255,.08),transparent 30%),
      transparent;
  }
  .brand{font-size:11px;letter-spacing:.18em;color:var(--cyan);margin-bottom:5px}
  h2{font-size:16px;margin:0 0 14px}
  .online{display:flex;align-items:center;gap:8px;font-size:10px;color:var(--cyan);margin-bottom:14px}
  .orb{width:8px;height:8px;border-radius:50%;background:var(--cyan);box-shadow:0 0 12px var(--cyan);animation:pulse 1.8s infinite}
  .card{padding:12px;border:1px solid var(--line);border-radius:12px;background:var(--panel);margin-bottom:10px}
  .label{font-size:9px;letter-spacing:.15em;color:var(--cyan);margin-bottom:7px}
  .value{font-weight:600;word-break:break-word}
  .row{display:flex;justify-content:space-between;gap:8px;padding:5px 0;color:var(--muted);font-size:11px}
  .row strong{color:var(--vscode-foreground)}
  button{width:100%;margin:4px 0;padding:9px;border-radius:8px;border:1px solid var(--line);background:rgba(0,247,255,.04);color:var(--vscode-foreground);cursor:pointer}
  button:hover{border-color:var(--cyan);box-shadow:0 0 14px rgba(0,247,255,.12)}
  @keyframes pulse{50%{opacity:.45;transform:scale(.82)}}
</style>
</head>
<body>
  <div class="brand">MASUM GALAXY</div>
  <h2>// COMMAND CENTER</h2>
  <div class="online"><span class="orb"></span>SYSTEM ONLINE</div>

  <div class="card">
    <div class="label">WORKSPACE</div>
    <div class="value">${workspace}</div>
  </div>

  <div class="card">
    <div class="label">GIT TELEMETRY</div>
    <div class="row"><span>Branch</span><strong>${branch}</strong></div>
    <div class="row"><span>Changes</span><strong>${state.changes}</strong></div>
    <div class="row"><span>Sync</span><strong>${sync}</strong></div>
  </div>

  <div class="card">
    <div class="label">QUICK CONTROL</div>
    <button onclick="send('openDashboard')">Open Full Dashboard</button>
    <button onclick="send('terminal')">Terminal</button>
    <button onclick="send('sourceControl')">Source Control</button>
    <button onclick="send('theme')">Theme Selector</button>
    <button onclick="send('refresh')">Refresh Status</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    function send(command){ vscode.postMessage({command}); }
  </script>
</body>
</html>`;
  }
}

function activate(context) {
  const sidebarProvider = new GalaxySidebarProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'galaxyCommandCenter.sidebar',
      sidebarProvider
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('galaxyCommandCenter.open', () => {
      const panel = vscode.window.createWebviewPanel(
        'galaxyCommandCenter',
        'Masum Galaxy // Command Center',
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true
        }
      );

      const refresh = () => {
        panel.webview.html = renderDashboardHtml(panel, context.extensionPath);
      };

      refresh();

      panel.webview.onDidReceiveMessage(async (message) => {
        if (message.command === 'refresh') {
          refresh();
          return;
        }
        await runAction(message.command);
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('galaxyCommandCenter.refresh', () => {
      sidebarProvider.refresh();
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
