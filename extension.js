const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const net = require('net');
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


function runVersionCommand(command, args = []) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim().split(/\r?\n/)[0];
  } catch {
    return 'Not found';
  }
}

function getEnvironmentStatus() {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  let python = runVersionCommand('python', ['--version']);
  if (python === 'Not found' && process.platform === 'win32') {
    python = runVersionCommand('py', ['--version']);
  }

  return {
    node: process.version,
    npm: runVersionCommand(npmCommand, ['--version']),
    python,
    git: runVersionCommand('git', ['--version']).replace(/^git version\s+/i, ''),
    vscode: vscode.version
  };
}

function isPortOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(280);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

async function getDevServerStatus() {
  const commonPorts = [3000, 3001, 4173, 4200, 5000, 5173, 8000, 8080];
  const checks = await Promise.all(
    commonPorts.map(async (port) => ({ port, open: await isPortOpen(port) }))
  );
  const ports = checks.filter((item) => item.open).map((item) => item.port);

  return {
    running: ports.length > 0,
    ports,
    primaryUrl: ports.length ? `http://localhost:${ports[0]}` : ''
  };
}

function getWorkspaceRoot(extensionUri) {
  return vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || extensionUri?.fsPath || '';
}

async function getGitState(extensionUri) {
  const fallback = {
    branch: 'No Git repo',
    changes: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    sync: 'Offline',
    lastCommitHash: '',
    lastCommitSubject: '',
    lastCommitWhen: ''
  };
  const cwd = getWorkspaceRoot(extensionUri);
  if (!cwd) return fallback;

  const inside = runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') return fallback;

  const branch =
    runGit(cwd, ['branch', '--show-current']) ||
    runGit(cwd, ['rev-parse', '--short', 'HEAD']) ||
    'Detached';

  const status = runGit(cwd, ['status', '--porcelain']);
  const statusLines = status ? status.split(/\r?\n/).filter(Boolean) : [];
  const changes = statusLines.length;
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;

  for (const line of statusLines) {
    if (line.startsWith('??')) {
      untracked++;
      continue;
    }
    const indexState = line[0] || ' ';
    const workTreeState = line[1] || ' ';
    if (indexState !== ' ') staged++;
    if (workTreeState !== ' ') unstaged++;
  }

  const lastCommitRaw = runGit(cwd, ['log', '-1', '--pretty=format:%h|%s|%cr']);
  const [lastCommitHash = '', lastCommitSubject = '', lastCommitWhen = ''] =
    lastCommitRaw ? lastCommitRaw.split('|') : [];

  let sync = 'Local';
  const upstream = runGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (upstream) {
    const counts = runGit(cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
    const [aheadRaw, behindRaw] = counts.split(/\s+/);
    const ahead = Number(aheadRaw || 0);
    const behind = Number(behindRaw || 0);
    sync = ahead || behind ? `↑${ahead} ↓${behind}` : 'Synced';
  }

  return {
    branch,
    changes,
    staged,
    unstaged,
    untracked,
    sync,
    lastCommitHash,
    lastCommitSubject,
    lastCommitWhen
  };
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

  const packageJsonPath = root ? path.join(root, 'package.json') : '';
  const hasPackageJson = Boolean(packageJsonPath && fs.existsSync(packageJsonPath));
  const dependencies =
    hasPackageJson
      ? (fs.existsSync(path.join(root, 'node_modules')) ? 'Installed' : 'Missing')
      : 'N/A';

  const packageJson = hasPackageJson ? await readJsonIfExists(packageJsonPath) : null;
  const scripts = packageJson?.scripts ? Object.keys(packageJson.scripts).length : 0;

  let score = 100;
  score -= Math.min(errors * 15, 60);
  score -= Math.min(warnings * 3, 24);
  score -= Math.min(todoCount, 10);
  if (dependencies === 'Missing') score -= 15;
  score = Math.max(0, Math.min(100, score));

  const status =
    score >= 90 ? 'Healthy' :
    score >= 70 ? 'Review' :
    'Attention';

  return {
    errors,
    warnings,
    todos: todoCount,
    dependencies,
    scripts,
    score,
    status
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


function normalizeProjectRecord(fsPath) {
  if (!fsPath) return null;
  return {
    name: path.basename(fsPath),
    path: fsPath
  };
}

async function rememberCurrentProject(context) {
  const currentPath = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
  if (!currentPath) return;

  const current = normalizeProjectRecord(currentPath);
  const recent = context.globalState.get('galaxy.recentProjects', []);
  const next = [
    current,
    ...recent.filter((item) => item?.path && item.path.toLowerCase() !== currentPath.toLowerCase())
  ].slice(0, 8);

  await context.globalState.update('galaxy.recentProjects', next);
}

function getProjectLauncherState(context) {
  const favorites = context.globalState.get('galaxy.favoriteProjects', []);
  const recent = context.globalState.get('galaxy.recentProjects', []);
  const currentPath = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || '';

  return {
    currentPath,
    favorites,
    recent
  };
}

async function toggleFavoriteProject(context, fsPath) {
  if (!fsPath) return;

  const favorites = context.globalState.get('galaxy.favoriteProjects', []);
  const exists = favorites.some(
    (item) => item?.path && item.path.toLowerCase() === fsPath.toLowerCase()
  );

  const next = exists
    ? favorites.filter((item) => item?.path && item.path.toLowerCase() !== fsPath.toLowerCase())
    : [normalizeProjectRecord(fsPath), ...favorites].filter(Boolean).slice(0, 12);

  await context.globalState.update('galaxy.favoriteProjects', next);
}

async function openProjectFolder(fsPath) {
  if (!fsPath) return;
  const uri = vscode.Uri.file(fsPath);
  await vscode.commands.executeCommand('vscode.openFolder', uri, false);
}

async function chooseProjectFolder() {
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Open Project'
  });

  if (!selected?.[0]) return;
  await vscode.commands.executeCommand('vscode.openFolder', selected[0], false);
}

function renderProjectList(items, currentPath, favorites = false) {
  if (!items?.length) {
    return '<p class="muted">No projects saved yet.</p>';
  }

  return items
    .map((item) => {
      const isCurrent =
        currentPath &&
        item.path &&
        item.path.toLowerCase() === currentPath.toLowerCase();

      return `
        <div class="project-row">
          <button class="project-main" data-project-path="${escapeHtml(item.path)}">
            <span class="project-dot">${isCurrent ? '●' : '○'}</span>
            <span class="project-copy">
              <strong>${escapeHtml(item.name)}</strong>
              <small>${escapeHtml(item.path)}</small>
            </span>
          </button>
          ${favorites ? `
            <button class="project-star" data-favorite-path="${escapeHtml(item.path)}" title="Remove favorite">★</button>
          ` : ''}
        </div>`;
    })
    .join('');
}


function getCommandState(context) {
  return {
    history: context?.globalState.get('galaxy.commandHistory', []) || [],
    pinned: context?.globalState.get('galaxy.pinnedCommands', []) || []
  };
}

async function recordCommand(context, command) {
  const clean = String(command || '').trim();
  if (!context || !clean) return;

  const history = context.globalState.get('galaxy.commandHistory', []);
  const next = [
    { command: clean, time: Date.now() },
    ...history.filter((item) => item?.command !== clean)
  ].slice(0, 12);

  await context.globalState.update('galaxy.commandHistory', next);
}

async function togglePinnedCommand(context, command) {
  const clean = String(command || '').trim();
  if (!context || !clean) return;

  const pinned = context.globalState.get('galaxy.pinnedCommands', []);
  const exists = pinned.includes(clean);
  const next = exists
    ? pinned.filter((item) => item !== clean)
    : [clean, ...pinned].slice(0, 12);

  await context.globalState.update('galaxy.pinnedCommands', next);
}

async function promptPinnedCommand(context) {
  const command = await vscode.window.showInputBox({
    title: 'Pin Command',
    prompt: 'Enter a terminal command to pin in Galaxy Command Center',
    placeHolder: 'npm run dev'
  });

  if (!command?.trim()) return false;
  await togglePinnedCommand(context, command.trim());
  return true;
}

async function clearCommandHistory(context) {
  if (!context) return;
  await context.globalState.update('galaxy.commandHistory', []);
}

function renderCommandHistory(history, pinned) {
  if (!history.length) {
    return '<p class="muted">Run a smart action or terminal command to build history.</p>';
  }

  return history
    .slice(0, 8)
    .map((item) => {
      const isPinned = pinned.includes(item.command);
      return `
        <div class="command-row">
          <button class="command-main" data-run-command="${escapeHtml(item.command)}">
            <span>›</span>
            <code>${escapeHtml(item.command)}</code>
          </button>
          <button class="command-pin" data-pin-command="${escapeHtml(item.command)}" title="${isPinned ? 'Unpin command' : 'Pin command'}">
            ${isPinned ? '★' : '☆'}
          </button>
        </div>`;
    })
    .join('');
}

function renderPinnedCommands(pinned) {
  if (!pinned.length) {
    return '<p class="muted">No pinned commands yet.</p>';
  }

  return pinned
    .map(
      (command) => `
        <div class="command-row">
          <button class="command-main" data-run-command="${escapeHtml(command)}">
            <span>▶</span>
            <code>${escapeHtml(command)}</code>
          </button>
          <button class="command-pin" data-pin-command="${escapeHtml(command)}" title="Unpin command">★</button>
        </div>`
    )
    .join('');
}

async function getWorkspaceState(extensionUri, version = 'dev', context) {
  const [git, project, health, recentFiles, devServer] = await Promise.all([
    getGitState(extensionUri),
    detectProject(extensionUri),
    getProjectHealth(extensionUri),
    getRecentFiles(),
    getDevServerStatus()
  ]);
  const environment = getEnvironmentStatus();

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
    environment,
    devServer,
    recentFiles,
    commands: context ? getCommandState(context) : { history: [], pinned: [] },
    launcher: context ? getProjectLauncherState(context) : { currentPath: '', favorites: [], recent: [] },
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
  const dependencyStatus = escapeHtml(state.health.dependencies);
  const serverStatus = state.devServer.running ? 'RUNNING' : 'OFFLINE';
  const serverUrl = escapeHtml(state.devServer.primaryUrl || '');
  const lastCommit = state.lastCommitHash
    ? `${escapeHtml(state.lastCommitHash)} · ${escapeHtml(state.lastCommitSubject)} · ${escapeHtml(state.lastCommitWhen)}`
    : 'No commit data';

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
  .launcher-head{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:12px}
  .launcher-actions{display:flex;gap:8px;flex-wrap:wrap}
  .launcher-actions button{padding:9px 11px}
  .project-columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
  .project-group{border:1px solid rgba(0,247,255,.11);border-radius:14px;padding:12px;background:rgba(0,247,255,.018)}
  .project-group-title{font-size:10px;letter-spacing:.12em;color:var(--muted);margin-bottom:9px}
  .project-row{display:flex;gap:8px;align-items:stretch;margin-top:8px}
  .project-main{display:flex;align-items:center;gap:10px;flex:1;min-width:0}
  .project-copy{display:flex;flex-direction:column;min-width:0}
  .project-copy strong,.project-copy small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .project-copy small{color:var(--muted);margin-top:3px}
  .project-dot{color:var(--cyan)}
  .project-star{width:44px;text-align:center;color:#ffcc66}
  .env-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}
  .env-box{padding:13px;border:1px solid rgba(0,247,255,.12);border-radius:12px;background:rgba(0,247,255,.02)}
  .env-box span{display:block;color:var(--muted);font-size:9px;letter-spacing:.11em;margin-bottom:6px}
  .env-box strong{font-size:13px;word-break:break-word}
  .server-line{display:flex;justify-content:space-between;gap:14px;align-items:center;padding:14px;border:1px solid rgba(0,247,255,.12);border-radius:12px;background:rgba(0,247,255,.02)}
  .server-state{color:var(--cyan);font-weight:700;letter-spacing:.08em}
  .server-actions{display:flex;gap:8px;flex-wrap:wrap}
  .git-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:12px}
  .git-box{padding:13px;border:1px solid rgba(139,92,255,.18);border-radius:12px;background:rgba(139,92,255,.035)}
  .git-box span{display:block;color:var(--muted);font-size:9px;letter-spacing:.11em;margin-bottom:6px}
  .git-box strong{font-size:15px}
  .git-actions{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px;margin-top:12px}
  .commit-line{margin-top:11px;padding:10px 12px;border:1px solid rgba(0,247,255,.1);border-radius:10px;color:var(--muted);font-size:11px}
  .command-columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
  .command-group{border:1px solid rgba(0,247,255,.11);border-radius:14px;padding:12px;background:rgba(0,247,255,.018)}
  .command-head{display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:8px}
  .command-row{display:flex;gap:8px;margin-top:8px}
  .command-main{display:flex;align-items:center;gap:8px;flex:1;min-width:0}
  .command-main code{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)}
  .command-pin{width:44px;text-align:center;color:#ffcc66}
  @media(max-width:900px){.telemetry{grid-template-columns:repeat(2,1fr)}.health-grid{grid-template-columns:repeat(2,1fr)}.env-grid{grid-template-columns:repeat(2,1fr)}.git-grid,.git-actions{grid-template-columns:repeat(2,1fr)}.command-columns{grid-template-columns:1fr}}
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
        <div class="health-box"><span>DEPENDENCIES</span><strong>${dependencyStatus}</strong></div>
        <div class="health-box"><span>NPM SCRIPTS</span><strong>${state.health.scripts}</strong></div>
        <div class="health-box"><span>HEALTH SCORE</span><strong>${state.health.score}/100</strong></div>
        <div class="health-box status"><span>STATUS</span><strong>${healthStatus}</strong></div>
      </div>
    </article>

    <article class="card wide">
      <div class="label">ENVIRONMENT STATUS</div>
      <div class="env-grid">
        <div class="env-box"><span>NODE</span><strong>${escapeHtml(state.environment.node)}</strong></div>
        <div class="env-box"><span>NPM</span><strong>${escapeHtml(state.environment.npm)}</strong></div>
        <div class="env-box"><span>PYTHON</span><strong>${escapeHtml(state.environment.python)}</strong></div>
        <div class="env-box"><span>GIT</span><strong>${escapeHtml(state.environment.git)}</strong></div>
        <div class="env-box"><span>VS CODE</span><strong>${escapeHtml(state.environment.vscode)}</strong></div>
      </div>
    </article>

    <article class="card wide">
      <div class="label">DEV SERVER MONITOR</div>
      <div class="server-line">
        <div>
          <div class="server-state">${serverStatus}</div>
          <div class="muted">${state.devServer.running ? serverUrl : 'No common local development port detected.'}</div>
        </div>
        <div class="server-actions">
          ${state.devServer.running ? `<button data-browser-url="${serverUrl}"><span>↗</span>Open Browser</button>` : ''}
          <button data-command="refresh"><span>↻</span>Scan Ports</button>
        </div>
      </div>
    </article>

    <article class="card">
      <div class="label">SMART PROJECT ACTIONS</div>
      <div class="smart-grid">
        ${renderSmartActions(state.project.actions)}
      </div>
    </article>

    <article class="card wide">
      <div class="label">GIT CONTROL CENTER</div>
      <div class="git-grid">
        <div class="git-box"><span>BRANCH</span><strong>${branch}</strong></div>
        <div class="git-box"><span>STAGED</span><strong>${state.staged}</strong></div>
        <div class="git-box"><span>UNSTAGED</span><strong>${state.unstaged}</strong></div>
        <div class="git-box"><span>UNTRACKED</span><strong>${state.untracked}</strong></div>
      </div>
      <div class="git-actions">
        <button data-git-action="pull"><span>↓</span>Pull</button>
        <button data-git-action="push"><span>↑</span>Push</button>
        <button data-git-action="sync"><span>⇅</span>Sync</button>
        <button data-git-action="stageAll"><span>＋</span>Stage All</button>
      </div>
      <div class="commit-line">Last commit: ${lastCommit}</div>
    </article>

    <article class="card wide">
      <div class="launcher-head">
        <div>
          <div class="label">COMMAND HISTORY + PINNED COMMANDS</div>
          <p class="muted">Rerun common terminal commands without retyping them.</p>
        </div>
        <div class="launcher-actions">
          <button data-command="pinCommandPrompt"><span>＋</span>Pin Command</button>
          <button data-command="clearHistory"><span>⌫</span>Clear History</button>
        </div>
      </div>
      <div class="command-columns">
        <div class="command-group">
          <div class="command-head"><span class="project-group-title">PINNED</span></div>
          ${renderPinnedCommands(state.commands.pinned)}
        </div>
        <div class="command-group">
          <div class="command-head"><span class="project-group-title">RECENT COMMANDS</span></div>
          ${renderCommandHistory(state.commands.history, state.commands.pinned)}
        </div>
      </div>
    </article>

    <article class="card wide">
      <div class="launcher-head">
        <div>
          <div class="label">PROJECT LAUNCHER</div>
          <p class="muted">Jump between projects and keep important workspaces pinned.</p>
        </div>
        <div class="launcher-actions">
          <button data-command="chooseProject"><span>＋</span>Open Project</button>
          <button data-command="toggleCurrentFavorite"><span>★</span>Favorite Current</button>
        </div>
      </div>

      <div class="project-columns">
        <div class="project-group">
          <div class="project-group-title">FAVORITES</div>
          ${renderProjectList(state.launcher.favorites, state.launcher.currentPath, true)}
        </div>
        <div class="project-group">
          <div class="project-group-title">RECENT PROJECTS</div>
          ${renderProjectList(state.launcher.recent, state.launcher.currentPath, false)}
        </div>
      </div>
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

  document.querySelectorAll('[data-project-path]').forEach((button) => {
    button.addEventListener('click', () => {
      vscode.postMessage({ command: 'openProject', value: button.dataset.projectPath });
    });
  });

  document.querySelectorAll('[data-favorite-path]').forEach((button) => {
    button.addEventListener('click', () => {
      vscode.postMessage({ command: 'toggleFavoritePath', value: button.dataset.favoritePath });
    });
  });

  document.querySelectorAll('[data-browser-url]').forEach((button) => {
    button.addEventListener('click', () => {
      vscode.postMessage({ command: 'openBrowser', value: button.dataset.browserUrl });
    });
  });

  document.querySelectorAll('[data-git-action]').forEach((button) => {
    button.addEventListener('click', () => {
      vscode.postMessage({ command: 'gitAction', value: button.dataset.gitAction });
    });
  });

  document.querySelectorAll('[data-run-command]').forEach((button) => {
    button.addEventListener('click', () => {
      vscode.postMessage({ command: 'runTerminal', value: button.dataset.runCommand });
    });
  });

  document.querySelectorAll('[data-pin-command]').forEach((button) => {
    button.addEventListener('click', () => {
      vscode.postMessage({ command: 'togglePinnedCommand', value: button.dataset.pinCommand });
    });
  });
</script>
</body>
</html>`;
}

async function runAction(command, value, context) {
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
      await recordCommand(context, value);
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
    case 'openBrowser':
      if (value) {
        return vscode.env.openExternal(vscode.Uri.parse(value));
      }
      return;
    case 'gitAction': {
      const actionMap = {
        pull: 'git pull',
        push: 'git push',
        sync: 'git pull && git push',
        stageAll: 'git add -A'
      };
      const gitCommand = actionMap[value];
      if (!gitCommand) return;
      await recordCommand(context, gitCommand);
      const terminal = vscode.window.createTerminal({ name: 'Galaxy Git' });
      terminal.show();
      terminal.sendText(gitCommand, true);
      return;
    }
    case 'pinCommandPrompt':
      return promptPinnedCommand(context);
    case 'togglePinnedCommand':
      return togglePinnedCommand(context, value);
    case 'clearHistory':
      return clearCommandHistory(context);
    case 'chooseProject':
      return chooseProjectFolder();
    case 'openProject':
      return openProjectFolder(value);
    case 'toggleCurrentFavorite': {
      const currentPath = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
      if (context && currentPath) {
        await toggleFavoriteProject(context, currentPath);
      }
      return;
    }
    case 'toggleFavoritePath':
      if (context) {
        await toggleFavoriteProject(context, value);
      }
      return;
    default:
      return undefined;
  }
}

class GalaxySidebarProvider {
  constructor(extensionUri, context) {
    this.extensionUri = extensionUri;
    this.context = context;
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };

    const render = async () => {
      const version =
        vscode.extensions.getExtension('gitwithmasum.masum-galaxy-command-center')
          ?.packageJSON?.version || 'dev';
      const state = await getWorkspaceState(this.extensionUri, version, this.context);

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
      await runAction(message.command, message.value, this.context);
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
        context.extension.packageJSON.version,
        context
      );
      panel.webview.html = getDashboardHtml(state);
    };

    panel.webview.onDidReceiveMessage(async (message) => {
      if (message.command === 'refresh') {
        await render();
        return;
      }
      await runAction(message.command, message.value, context);
      if (
        message.command === 'toggleCurrentFavorite' ||
        message.command === 'toggleFavoritePath' ||
        message.command === 'pinCommandPrompt' ||
        message.command === 'togglePinnedCommand' ||
        message.command === 'clearHistory'
      ) {
        await render();
      }
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
  await rememberCurrentProject(context);

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      await rememberCurrentProject(context);
    })
  );

  const sidebarProvider = new GalaxySidebarProvider(context.extensionUri, context);

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
        context.extension.packageJSON.version,
        context
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
