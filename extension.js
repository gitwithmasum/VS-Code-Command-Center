const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const net = require('net');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const {
  getWorkspaceRoot,
  readJsonIfExists,
  createWorkspaceTerminal
} = require('./src/core/workspace');
const {
  runGit,
  remoteToWebUrl,
  detectRemoteProvider
} = require('./src/core/git');
const {
  runCapturedProcess
} = require('./src/core/process');
const {
  getCpArenaState,
  startNewContest,
  stopContest,
  switchProblem,
  setProblemStatus,
  resetCpSession,
  runCurrentFile,
  runMultipleCases,
  runStressTest,
  saveLastRun,
  saveLastSuite,
  saveStressResult,
  getCpTemplate,
  getCpSnippets
} = require('./src/features/cp');
const {
  getDeveloperAnalytics,
  recordQualityGateHistory,
  recordProjectHealthHistory
} = require('./src/features/analytics');
const {
  scanWorkspaceArchitecture,
  searchArchitecture,
  getArchitectureFile,
  toArchitectureView
} = require('./src/features/architecture');
const {
  discoverWorkspaceTasks,
  runWorkspaceTask,
  runTaskPlan,
  standardVerifyTasks,
  shipTasks
} = require('./src/features/orchestrator');

let lastEditorContext = {
  fileName: '',
  languageId: '',
  uri: '',
  selectedText: ''
};

let lastAiPrompt = '';
let lastAiPromptKind = '';

const sessionStartedAt = Date.now();
const sessionTouchedFiles = new Set();
let sessionCommandCount = 0;
let sessionSaveCount = 0;

let lastCodingActivityAt = Date.now();
let lastCodingTickAt = Date.now();
let galaxyWindowFocused = true;
let focusTimerCompletionKey = '';

let debugAssistantState = {
  analyzing: false,
  analysis: '',
  model: '',
  lastSignature: '',
  lastError: ''
};
let autoDebugTimer = null;
let lastAutoDebugAt = 0;
let dashboardRenderCallback = null;

let smartAssistantState = {
  running: false,
  task: '',
  command: '',
  exitCode: null,
  output: '',
  analysis: '',
  model: '',
  lastError: '',
  startedAt: 0,
  finishedAt: 0
};

let aiEditState = {
  running: false,
  kind: '',
  sourceUri: '',
  targetPath: '',
  originalText: '',
  proposedText: '',
  summary: '',
  confidence: '',
  verification: [],
  model: '',
  error: '',
  proposalId: ''
};

const aiPreviewDocuments = new Map();

function createQualityGateState() {
  return {
    running: false,
    status: 'NOT RUN',
    score: 0,
    errors: 0,
    warnings: 0,
    conflicts: 0,
    checks: [],
    beforeErrors: null,
    afterErrors: null,
    dependency: null,
    coverage: null,
    lastRunAt: 0,
    fingerprint: '',
    message: ''
  };
}

let qualityGateWorkspaceKey = '';
let qualityGateState = createQualityGateState();

let lastAiApplyBackup = null;
let activeDiagnosticSignatures = new Set();

let architectureCache = {
  root: '',
  at: 0,
  scan: null
};

let architectureSearchState = {
  query: '',
  results: [],
  analysis: '',
  model: '',
  error: '',
  running: false
};

let taskOrchestratorAbortController = null;

let taskOrchestratorState = {
  running: false,
  name: '',
  mode: '',
  requested: [],
  results: [],
  passed: null,
  message: '',
  startedAt: 0,
  finishedAt: 0,
  durationMs: 0
};

let cpAiState = {
  running: false,
  kind: '',
  result: '',
  model: '',
  error: ''
};

let githubStateCache = {
  at: 0,
  value: null
};

let githubCollaborationCache = { key: '', at: 0, value: null };

function captureEditorContext(editor, clearEmptySelection = true) {
  if (!editor) return;

  lastEditorContext.fileName = editor.document.fileName || '';
  lastEditorContext.languageId = editor.document.languageId || '';
  lastEditorContext.uri = editor.document.uri.toString();

  if (!editor.selection.isEmpty) {
    lastEditorContext.selectedText = editor.document.getText(editor.selection);
  } else if (clearEmptySelection) {
    lastEditorContext.selectedText = '';
  }
}

function getBestEditorContext() {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    captureEditorContext(editor, false);
  }

  const activeSelection =
    editor && !editor.selection.isEmpty
      ? editor.document.getText(editor.selection)
      : '';

  return {
    editor,
    fileName: editor?.document.fileName || lastEditorContext.fileName,
    languageId: editor?.document.languageId || lastEditorContext.languageId,
    uri: editor?.document.uri.toString() || lastEditorContext.uri,
    selectedText: activeSelection || lastEditorContext.selectedText
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
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

function githubApi(pathname, token) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: 'api.github.com',
        path: pathname,
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'Masum-Galaxy-Command-Center',
          'X-GitHub-Api-Version': '2022-11-28'
        }
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          if (response.statusCode >= 200 && response.statusCode < 300) {
            try {
              resolve(JSON.parse(body || 'null'));
            } catch (error) {
              reject(error);
            }
            return;
          }

          reject(new Error(`GitHub API ${response.statusCode}: ${body.slice(0, 300)}`));
        });
      }
    );

    request.setTimeout(7000, () => {
      request.destroy(new Error('GitHub API request timed out.'));
    });
    request.on('error', reject);
    request.end();
  });
}

async function getGitHubState(force = false) {
  if (!force && githubStateCache.value && Date.now() - githubStateCache.at < 60000) {
    return githubStateCache.value;
  }

  try {
    const session = await vscode.authentication.getSession(
      'github',
      ['repo'],
      { createIfNone: false }
    );

    if (!session) {
      const value = {
        connected: false,
        account: '',
        repos: [],
        error: ''
      };
      githubStateCache = { at: Date.now(), value };
      return value;
    }

    let repos = [];
    let error = '';

    try {
      const records = await githubApi(
        '/user/repos?per_page=8&sort=updated&affiliation=owner%2Ccollaborator%2Corganization_member',
        session.accessToken
      );

      repos = Array.isArray(records)
        ? records.map((item) => ({
            id: String(item.id || ''),
            name: item.name || '',
            fullName: item.full_name || item.name || '',
            private: Boolean(item.private),
            cloneUrl: item.clone_url || '',
            htmlUrl: item.html_url || ''
          }))
        : [];
    } catch (apiError) {
      error = apiError.message || 'Unable to load GitHub repositories.';
    }

    const value = {
      connected: true,
      account: session.account?.label || session.account?.id || 'GitHub account',
      repos,
      error
    };
    githubStateCache = { at: Date.now(), value };
    return value;
  } catch (error) {
    return {
      connected: false,
      account: '',
      repos: [],
      error: error.message || 'GitHub authentication is unavailable.'
    };
  }
}

async function connectGitHub() {
  try {
    const session = await vscode.authentication.getSession(
      'github',
      ['repo'],
      { createIfNone: true }
    );
    githubStateCache = { at: 0, value: null };
    if (session) {
      vscode.window.showInformationMessage(
        `Galaxy connected to GitHub as ${session.account?.label || 'your account'}.`
      );
      return true;
    }
  } catch (error) {
    vscode.window.showErrorMessage(`GitHub sign-in failed: ${error.message || error}`);
  }
  return false;
}

function runGitLocal(cwd, args, successMessage) {
  try {
    const output = execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();

    if (successMessage) {
      vscode.window.showInformationMessage(successMessage);
    }
    return output;
  } catch (error) {
    const detail =
      String(error?.stderr || error?.message || 'Git command failed').trim();
    vscode.window.showErrorMessage(detail.slice(0, 500));
    return null;
  }
}

async function initializeRepository(extensionUri) {
  const root = getWorkspaceRoot(extensionUri);
  if (!root) {
    vscode.window.showWarningMessage('Open a workspace folder first.');
    return false;
  }

  if (runGit(root, ['rev-parse', '--is-inside-work-tree']) === 'true') {
    vscode.window.showInformationMessage('This workspace is already a Git repository.');
    return false;
  }

  return runGitLocal(root, ['init'], 'Git repository initialized.') !== null;
}

async function manageOrigin(extensionUri) {
  const root = getWorkspaceRoot(extensionUri);
  if (!root) return false;

  const current = runGit(root, ['remote', 'get-url', 'origin']);
  const next = await vscode.window.showInputBox({
    title: current ? 'Change Remote Origin' : 'Add Remote Origin',
    prompt: 'Enter a GitHub, GitLab, Bitbucket, Azure DevOps, or other Git remote URL',
    value: current || '',
    placeHolder: 'https://github.com/user/repository.git'
  });

  if (!next?.trim()) return false;

  const result = current
    ? runGitLocal(root, ['remote', 'set-url', 'origin', next.trim()], 'Remote origin updated.')
    : runGitLocal(root, ['remote', 'add', 'origin', next.trim()], 'Remote origin added.');

  return result !== null;
}

async function createBranch(extensionUri) {
  const root = getWorkspaceRoot(extensionUri);
  if (!root) return false;

  const branch = await vscode.window.showInputBox({
    title: 'Create Git Branch',
    prompt: 'Enter a new branch name',
    placeHolder: 'feature/repository-hub',
    validateInput: (value) => {
      if (!value.trim()) return 'Branch name is required.';
      if (/\s/.test(value)) return 'Branch names cannot contain spaces.';
      return undefined;
    }
  });

  if (!branch?.trim()) return false;
  return runGitLocal(
    root,
    ['switch', '-c', branch.trim()],
    `Created and switched to ${branch.trim()}.`
  ) !== null;
}

async function switchBranch(extensionUri) {
  const root = getWorkspaceRoot(extensionUri);
  if (!root) return false;

  const branches = runGit(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
    .split(/\r?\n/)
    .filter(Boolean);

  if (!branches.length) {
    vscode.window.showInformationMessage('No local branches are available yet.');
    return false;
  }

  const selected = await vscode.window.showQuickPick(branches, {
    title: 'Switch Git Branch',
    placeHolder: 'Select a local branch'
  });

  if (!selected) return false;
  return runGitLocal(root, ['switch', selected], `Switched to ${selected}.`) !== null;
}

async function commitStagedChanges(extensionUri) {
  const root = getWorkspaceRoot(extensionUri);
  if (!root) return false;

  const staged = runGit(root, ['diff', '--cached', '--name-only']);
  if (!staged) {
    vscode.window.showWarningMessage('There are no staged changes to commit.');
    return false;
  }

  const message = await vscode.window.showInputBox({
    title: 'Commit Staged Changes',
    prompt: 'Enter a Git commit message',
    placeHolder: 'feat: improve repository control hub'
  });

  if (!message?.trim()) return false;
  return runGitLocal(root, ['commit', '-m', message.trim()], 'Git commit created.') !== null;
}

async function openRemoteRepository(extensionUri) {
  const root = getWorkspaceRoot(extensionUri);
  if (!root) return false;

  const origin = runGit(root, ['remote', 'get-url', 'origin']);
  const url = remoteToWebUrl(origin);
  if (!url) {
    vscode.window.showWarningMessage('No browser-compatible remote origin was found.');
    return false;
  }

  await vscode.env.openExternal(vscode.Uri.parse(url));
  return true;
}

async function cloneRepository(url = '') {
  let cloneUrl = String(url || '').trim();

  if (!cloneUrl) {
    cloneUrl = await vscode.window.showInputBox({
      title: 'Clone Repository',
      prompt: 'Paste a Git repository URL',
      placeHolder: 'https://github.com/user/repository.git'
    }) || '';
  }

  if (!cloneUrl.trim()) return false;

  const commands = await vscode.commands.getCommands(true);
  if (commands.includes('git.clone')) {
    await vscode.commands.executeCommand('git.clone', cloneUrl.trim());
    return true;
  }

  vscode.window.showWarningMessage('VS Code Git clone command is unavailable.');
  return false;
}

async function openGitHubRepository(url) {
  if (!url) return false;
  await vscode.env.openExternal(vscode.Uri.parse(url));
  return true;
}

function renderGitHubRepos(github) {
  if (!github.connected) {
    return '<p class="muted">Connect your GitHub account to see recently updated repositories here.</p>';
  }

  if (github.error && !github.repos.length) {
    return `<p class="muted">${escapeHtml(github.error)}</p>`;
  }

  if (!github.repos.length) {
    return '<p class="muted">No repositories were returned for this account.</p>';
  }

  return github.repos
    .map(
      (repo) => `
        <div class="remote-repo-row">
          <div class="remote-repo-copy">
            <strong>${escapeHtml(repo.fullName)}</strong>
            <small>${repo.private ? 'Private' : 'Public'}</small>
          </div>
          <button data-github-open="${escapeHtml(repo.htmlUrl)}">Open</button>
          <button data-github-clone="${escapeHtml(repo.cloneUrl)}">Clone</button>
        </div>`
    )
    .join('');
}

function githubApiRequest(pathname, token, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'User-Agent': 'Masum-Galaxy-Command-Center',
      'X-GitHub-Api-Version': '2022-11-28'
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const request = https.request({ hostname: 'api.github.com', path: pathname, method, headers }, (response) => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { responseBody += chunk; });
      response.on('end', () => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          if (!responseBody) return resolve(null);
          try { return resolve(JSON.parse(responseBody)); } catch (error) { return reject(error); }
        }
        reject(new Error('GitHub API ' + response.statusCode + ': ' + responseBody.slice(0, 500)));
      });
    });
    request.setTimeout(7000, () => request.destroy(new Error('GitHub API request timed out.')));
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function parseGitHubRemote(remoteUrl) {
  const webUrl = remoteToWebUrl(remoteUrl);
  const match = webUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/?#]+)$/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2], fullName: match[1] + '/' + match[2], webUrl };
}

async function getGitHubSession(createIfNone = false) {
  try {
    return await vscode.authentication.getSession('github', ['repo'], { createIfNone });
  } catch {
    return null;
  }
}

async function getGitHubCollaborationState(gitState, force = false) {
  const parsed = parseGitHubRemote(gitState && gitState.originUrl);
  if (!parsed) return { available: false, fullName: '', issues: [], pulls: [], actions: [], error: '' };
  const cacheKey = parsed.fullName.toLowerCase();
  if (!force && githubCollaborationCache.value && githubCollaborationCache.key === cacheKey && Date.now() - githubCollaborationCache.at < 60000) return githubCollaborationCache.value;
  const session = await getGitHubSession(false);
  if (!session) return { available: false, fullName: parsed.fullName, issues: [], pulls: [], actions: [], error: 'Connect GitHub to load collaboration data.' };
  const base = '/repos/' + encodeURIComponent(parsed.owner) + '/' + encodeURIComponent(parsed.repo);
  try {
    const [issuesRaw, pullsRaw, runsRaw] = await Promise.all([
      githubApi(base + '/issues?state=open&per_page=6&sort=updated', session.accessToken),
      githubApi(base + '/pulls?state=open&per_page=6&sort=updated', session.accessToken),
      githubApi(base + '/actions/runs?per_page=6', session.accessToken)
    ]);
    const value = {
      available: true,
      fullName: parsed.fullName,
      issues: (Array.isArray(issuesRaw) ? issuesRaw : []).filter((item) => !item.pull_request).slice(0, 5).map((item) => ({ number: item.number, title: item.title || '', url: item.html_url || '' })),
      pulls: (Array.isArray(pullsRaw) ? pullsRaw : []).slice(0, 5).map((item) => ({ number: item.number, title: item.title || '', url: item.html_url || '', draft: Boolean(item.draft) })),
      actions: ((runsRaw && runsRaw.workflow_runs) || []).slice(0, 5).map((run) => ({ id: String(run.id || ''), name: run.name || run.display_title || 'Workflow', status: run.conclusion || run.status || 'unknown', branch: run.head_branch || '', url: run.html_url || '' })),
      error: ''
    };
    githubCollaborationCache = { key: cacheKey, at: Date.now(), value };
    return value;
  } catch (error) {
    return { available: false, fullName: parsed.fullName, issues: [], pulls: [], actions: [], error: error.message || 'Unable to load GitHub collaboration data.' };
  }
}

function renderGitHubCollaboration(state) {
  if (state.error && !state.available) return '<p class="muted">' + escapeHtml(state.error) + '</p>';
  const issues = state.issues.length ? state.issues.map((item) => '<button class="collab-row" data-external-url="' + escapeHtml(item.url) + '"><span>#' + item.number + '</span><strong>' + escapeHtml(item.title) + '</strong></button>').join('') : '<p class="muted">No open issues.</p>';
  const pulls = state.pulls.length ? state.pulls.map((item) => '<button class="collab-row" data-external-url="' + escapeHtml(item.url) + '"><span>PR #' + item.number + '</span><strong>' + escapeHtml(item.title) + (item.draft ? ' · Draft' : '') + '</strong></button>').join('') : '<p class="muted">No open pull requests.</p>';
  const actions = state.actions.length ? state.actions.map((item) =>
    '<div class="action-run-row"><button class="collab-row" data-external-url="' + escapeHtml(item.url) + '"><span>' +
    escapeHtml(item.status) + '</span><strong>' + escapeHtml(item.name) +
    (item.branch ? ' · ' + escapeHtml(item.branch) : '') +
    '</strong></button><button data-rerun-action="' + escapeHtml(item.id) + '">Rerun</button></div>'
  ).join('') : '<p class="muted">No recent workflow runs.</p>';
  return '<div class="collab-columns"><div class="collab-group"><div class="project-group-title">OPEN ISSUES</div>' + issues + '</div><div class="collab-group"><div class="project-group-title">PULL REQUESTS</div>' + pulls + '</div><div class="collab-group"><div class="project-group-title">ACTIONS</div>' + actions + '</div></div>';
}

async function createGitHubIssue(extensionUri) {
  const root = getWorkspaceRoot(extensionUri);
  const parsed = parseGitHubRemote(root ? runGit(root, ['remote', 'get-url', 'origin']) : '');
  if (!parsed) { vscode.window.showWarningMessage('Current workspace is not linked to a GitHub repository.'); return false; }
  const session = await getGitHubSession(true);
  if (!session) return false;
  const title = await vscode.window.showInputBox({ title: 'Create GitHub Issue', prompt: 'Issue title for ' + parsed.fullName });
  if (!title || !title.trim()) return false;
  const body = await vscode.window.showInputBox({ title: 'Issue Details', prompt: 'Optional short issue description', value: '' });
  try {
    const created = await githubApiRequest('/repos/' + encodeURIComponent(parsed.owner) + '/' + encodeURIComponent(parsed.repo) + '/issues', session.accessToken, 'POST', { title: title.trim(), body: body || '' });
    githubCollaborationCache = { key: '', at: 0, value: null };
    vscode.window.showInformationMessage('GitHub issue #' + ((created && created.number) || '') + ' created.');
    return true;
  } catch (error) { vscode.window.showErrorMessage(error.message || 'Unable to create GitHub issue.'); return false; }
}

async function createGitHubPullRequest(extensionUri) {
  const root = getWorkspaceRoot(extensionUri);
  const parsed = parseGitHubRemote(root ? runGit(root, ['remote', 'get-url', 'origin']) : '');
  if (!parsed) { vscode.window.showWarningMessage('Current workspace is not linked to a GitHub repository.'); return false; }
  const session = await getGitHubSession(true);
  if (!session) return false;
  try {
    const info = await githubApi('/repos/' + encodeURIComponent(parsed.owner) + '/' + encodeURIComponent(parsed.repo), session.accessToken);
    const head = runGit(root, ['branch', '--show-current']);
    const base = (info && info.default_branch) || 'main';
    if (!head) { vscode.window.showWarningMessage('No active Git branch is available.'); return false; }
    if (head === base) { vscode.window.showWarningMessage('Create or switch to a feature branch before opening a pull request to ' + base + '.'); return false; }
    const title = await vscode.window.showInputBox({ title: 'Create Pull Request', prompt: head + ' → ' + base, value: head.replace(/[-_/]+/g, ' ') });
    if (!title || !title.trim()) return false;
    const created = await githubApiRequest('/repos/' + encodeURIComponent(parsed.owner) + '/' + encodeURIComponent(parsed.repo) + '/pulls', session.accessToken, 'POST', { title: title.trim(), head, base, body: '' });
    githubCollaborationCache = { key: '', at: 0, value: null };
    vscode.window.showInformationMessage('Pull request #' + ((created && created.number) || '') + ' created.');
    return true;
  } catch (error) { vscode.window.showErrorMessage(error.message || 'Unable to create pull request.'); return false; }
}

async function createGitHubRepository() {
  const session = await getGitHubSession(true);
  if (!session) return null;
  const name = await vscode.window.showInputBox({ title: 'Create GitHub Repository', prompt: 'Repository name', placeHolder: 'my-new-project' });
  if (!name || !name.trim()) return null;
  const visibility = await vscode.window.showQuickPick([{ label: 'Public', value: false }, { label: 'Private', value: true }], { title: 'Repository Visibility' });
  if (!visibility) return null;
  const description = await vscode.window.showInputBox({ title: 'Repository Description', prompt: 'Optional description', value: '' });
  try {
    const created = await githubApiRequest('/user/repos', session.accessToken, 'POST', { name: name.trim().replace(/\s+/g, '-'), description: description || '', private: visibility.value, auto_init: false });
    githubStateCache = { at: 0, value: null };
    vscode.window.showInformationMessage('GitHub repository ' + ((created && created.full_name) || name.trim()) + ' created.');
    return created;
  } catch (error) { vscode.window.showErrorMessage(error.message || 'Unable to create GitHub repository.'); return null; }
}

function findSensitivePublishFiles(root) {
  try { return fs.readdirSync(root).filter((name) => /^\.env(?:\.|$)/i.test(name) || /\.(pem|key|p12|pfx)$/i.test(name) || /credentials?|secrets?/i.test(name)); } catch { return []; }
}

async function publishCurrentProjectToGitHub(extensionUri) {
  const root = getWorkspaceRoot(extensionUri);
  if (!root || !vscode.workspace.workspaceFolders || !vscode.workspace.workspaceFolders.length) { vscode.window.showWarningMessage('Open the project folder you want to publish first.'); return false; }
  if (runGit(root, ['remote', 'get-url', 'origin'])) { vscode.window.showWarningMessage('This project already has an origin remote. Use Manage Origin or Push instead.'); return false; }
  const sensitive = findSensitivePublishFiles(root);
  const warning = sensitive.length ? 'Potential sensitive files detected: ' + sensitive.slice(0, 5).join(', ') + '. Review .gitignore before publishing.' : 'This may stage and commit current project files if there is no commit yet. Review .gitignore and secrets first.';
  const confirm = await vscode.window.showWarningMessage(warning, { modal: true }, 'Continue');
  if (confirm !== 'Continue') return false;
  const created = await createGitHubRepository();
  if (!created || !created.clone_url) return false;
  if (runGit(root, ['rev-parse', '--is-inside-work-tree']) !== 'true' && runGitLocal(root, ['init'], '') === null) return false;
  if (runGitLocal(root, ['remote', 'add', 'origin', created.clone_url], '') === null) return false;
  const hasCommit = Boolean(runGit(root, ['rev-parse', '--verify', 'HEAD']));
  if (!hasCommit) {
    if (runGitLocal(root, ['add', '-A'], '') === null) return false;
    const staged = runGit(root, ['diff', '--cached', '--name-only']);
    if (staged && runGitLocal(root, ['commit', '-m', 'Initial commit'], '') === null) {
      vscode.window.showWarningMessage('Repository was created and origin linked, but initial commit failed. Configure Git user.name/user.email and commit manually.');
      return false;
    }
  }
  const branch = runGit(root, ['branch', '--show-current']) || 'main';
  if (runGitLocal(root, ['push', '-u', 'origin', branch], '') === null) { vscode.window.showWarningMessage('Repository created and origin linked, but push did not complete. Use Push after credentials are ready.'); return false; }
  githubStateCache = { at: 0, value: null };
  githubCollaborationCache = { key: '', at: 0, value: null };
  vscode.window.showInformationMessage('Published current project to ' + created.full_name + '.');
  return true;
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
    lastCommitWhen: '',
    isGitRepo: false,
    originUrl: '',
    remoteWebUrl: '',
    provider: 'Local only',
    branches: []
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

  const lastCommitRaw = runGit(cwd, ['log', '-1', '--pretty=format:%h%x09%s%x09%cr']);
  const [lastCommitHash = '', lastCommitSubject = '', lastCommitWhen = ''] =
    lastCommitRaw ? lastCommitRaw.split('\t') : [];

  let sync = 'Local';
  const upstream = runGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (upstream) {
    const counts = runGit(cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
    const [aheadRaw, behindRaw] = counts.split(/\s+/);
    const ahead = Number(aheadRaw || 0);
    const behind = Number(behindRaw || 0);
    sync = ahead || behind ? `↑${ahead} ↓${behind}` : 'Synced';
  }

  const originUrl = runGit(cwd, ['remote', 'get-url', 'origin']);
  const remoteWebUrl = remoteToWebUrl(originUrl);
  const provider = detectRemoteProvider(originUrl);
  const branches = runGit(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
    .split(/\r?\n/)
    .filter(Boolean);

  return {
    branch,
    changes,
    staged,
    unstaged,
    untracked,
    sync,
    lastCommitHash,
    lastCommitSubject,
    lastCommitWhen,
    isGitRepo: true,
    originUrl,
    remoteWebUrl,
    provider,
    branches
  };
}


function parseStatusPath(line) {
  const raw = String(line || '').slice(3).trim();
  if (!raw) return '';
  if (raw.includes(' -> ')) return raw.split(' -> ').pop().trim();
  return raw.replace(/^"|"$/g, '');
}

function getAdvancedRepoState(extensionUri) {
  const root = getWorkspaceRoot(extensionUri);
  if (!root || runGit(root, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
    return {
      conflicts: [],
      changedFiles: [],
      tags: [],
      mergedBranches: []
    };
  }

  const status = runGit(root, ['status', '--porcelain=v1']);
  const changedFiles = (status ? status.split(/\r?\n/) : [])
    .filter(Boolean)
    .map((line) => ({
      code: line.slice(0, 2),
      path: parseStatusPath(line)
    }))
    .filter((item) => item.path)
    .slice(0, 20);

  const conflicts = runGit(root, ['diff', '--name-only', '--diff-filter=U'])
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, 20);

  const tags = runGit(root, ['tag', '--sort=-creatordate'])
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, 12);

  const current = runGit(root, ['branch', '--show-current']);
  const mergedBranches = runGit(root, ['branch', '--merged'])
    .split(/\r?\n/)
    .map((line) => line.replace(/^\*\s*/, '').trim())
    .filter((name) => name && name !== current && !['main','master','develop','development'].includes(name))
    .slice(0, 12);

  return { conflicts, changedFiles, tags, mergedBranches };
}

async function openChangedFileDiff(extensionUri, relativePath) {
  const root = getWorkspaceRoot(extensionUri);
  if (!root || !relativePath) return false;

  const fileUri = vscode.Uri.file(path.join(root, relativePath));
  const exists = fs.existsSync(fileUri.fsPath);

  if (!exists) {
    vscode.window.showWarningMessage('Changed file no longer exists in the working tree.');
    return false;
  }

  const tracked = runGit(root, ['ls-files', '--error-unmatch', relativePath]);
  if (!tracked) {
    const document = await vscode.workspace.openTextDocument(fileUri);
    await vscode.window.showTextDocument(document, { preview: false });
    return true;
  }

  const left = vscode.Uri.parse(
    'git:' + JSON.stringify({ path: fileUri.fsPath, ref: 'HEAD' })
  );

  try {
    await vscode.commands.executeCommand(
      'vscode.diff',
      left,
      fileUri,
      'HEAD ↔ ' + relativePath
    );
    return true;
  } catch {
    const document = await vscode.workspace.openTextDocument(fileUri);
    await vscode.window.showTextDocument(document, { preview: false });
    return true;
  }
}

async function openConflictFile(extensionUri, relativePath) {
  const root = getWorkspaceRoot(extensionUri);
  if (!root || !relativePath) return false;

  const uri = vscode.Uri.file(path.join(root, relativePath));
  if (!fs.existsSync(uri.fsPath)) return false;

  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: false });

  const commands = await vscode.commands.getCommands(true);
  if (commands.includes('git.openMergeEditor')) {
    try {
      await vscode.commands.executeCommand('git.openMergeEditor', uri);
    } catch {
      // The file is still opened for manual conflict resolution.
    }
  }
  return true;
}

async function createGitTag(extensionUri) {
  const root = getWorkspaceRoot(extensionUri);
  if (!root) return false;

  const tag = await vscode.window.showInputBox({
    title: 'Create Git Tag',
    prompt: 'Tag name',
    placeHolder: 'v2.4.0',
    validateInput: (value) => {
      if (!value.trim()) return 'Tag name is required.';
      if (/\s/.test(value)) return 'Tag names cannot contain spaces.';
      return undefined;
    }
  });
  if (!tag?.trim()) return false;

  const message = await vscode.window.showInputBox({
    title: 'Tag Message',
    prompt: 'Optional annotated tag message',
    value: ''
  });

  const args = message?.trim()
    ? ['tag', '-a', tag.trim(), '-m', message.trim()]
    : ['tag', tag.trim()];

  if (runGitLocal(root, args, 'Git tag created.') === null) return false;

  const push = await vscode.window.showInformationMessage(
    'Push this tag to origin now?',
    'Push Tag',
    'Not Now'
  );
  if (push === 'Push Tag') {
    return runGitLocal(root, ['push', 'origin', tag.trim()], 'Git tag pushed to origin.') !== null;
  }
  return true;
}

async function deleteMergedBranch(extensionUri, branchName) {
  const root = getWorkspaceRoot(extensionUri);
  if (!root || !branchName) return false;

  const confirm = await vscode.window.showWarningMessage(
    'Delete merged local branch "' + branchName + '"?',
    { modal: true },
    'Delete Branch'
  );
  if (confirm !== 'Delete Branch') return false;

  return runGitLocal(root, ['branch', '-d', branchName], 'Merged branch deleted.') !== null;
}


async function createDraftGitHubRelease(extensionUri) {
  const root = getWorkspaceRoot(extensionUri);
  const parsed = parseGitHubRemote(root ? runGit(root, ['remote', 'get-url', 'origin']) : '');
  if (!parsed) {
    vscode.window.showWarningMessage('Current workspace is not linked to a GitHub repository.');
    return false;
  }

  const session = await getGitHubSession(true);
  if (!session) return false;

  const tags = runGit(root, ['tag', '--sort=-creatordate'])
    .split(/\r?\n/)
    .filter(Boolean);

  let tag = await vscode.window.showQuickPick(tags, {
    title: 'Create Draft GitHub Release',
    placeHolder: 'Choose an existing tag'
  });

  if (!tag) {
    tag = await vscode.window.showInputBox({
      title: 'Release Tag',
      prompt: 'Enter an existing tag name'
    });
  }
  if (!tag?.trim()) return false;

  const name = await vscode.window.showInputBox({
    title: 'Release Name',
    value: tag.trim()
  });
  if (name === undefined) return false;

  try {
    const created = await githubApiRequest(
      '/repos/' + encodeURIComponent(parsed.owner) + '/' + encodeURIComponent(parsed.repo) + '/releases',
      session.accessToken,
      'POST',
      {
        tag_name: tag.trim(),
        name: (name || tag).trim(),
        draft: true,
        prerelease: false,
        generate_release_notes: true
      }
    );

    vscode.window.showInformationMessage('Draft GitHub release created.');
    if (created?.html_url) {
      await vscode.env.openExternal(vscode.Uri.parse(created.html_url));
    }
    return true;
  } catch (error) {
    vscode.window.showErrorMessage(error.message || 'Unable to create draft release.');
    return false;
  }
}

async function rerunGitHubAction(extensionUri, runId) {
  if (!runId) return false;
  const root = getWorkspaceRoot(extensionUri);
  const parsed = parseGitHubRemote(root ? runGit(root, ['remote', 'get-url', 'origin']) : '');
  if (!parsed) return false;

  const session = await getGitHubSession(true);
  if (!session) return false;

  try {
    await githubApiRequest(
      '/repos/' + encodeURIComponent(parsed.owner) + '/' + encodeURIComponent(parsed.repo) + '/actions/runs/' + encodeURIComponent(runId) + '/rerun',
      session.accessToken,
      'POST'
    );
    githubCollaborationCache = { key: '', at: 0, value: null };
    vscode.window.showInformationMessage('GitHub Actions run queued again.');
    return true;
  } catch (error) {
    vscode.window.showErrorMessage(error.message || 'Unable to rerun GitHub Actions workflow.');
    return false;
  }
}

async function openPullRequestReviewCenter(extensionUri) {
  const root = getWorkspaceRoot(extensionUri);
  const origin = root ? runGit(root, ['remote', 'get-url', 'origin']) : '';
  const parsed = parseGitHubRemote(origin);
  if (!parsed) {
    vscode.window.showWarningMessage('Current workspace is not linked to GitHub.');
    return false;
  }

  const commands = await vscode.commands.getCommands(true);
  const candidates = [
    'githubPullRequests.focus',
    'pr.openAll'
  ];
  const command = candidates.find((item) => commands.includes(item));
  if (command) {
    await vscode.commands.executeCommand(command);
    return true;
  }

  await vscode.env.openExternal(vscode.Uri.parse(parsed.webUrl + '/pulls'));
  return true;
}

async function safeCommitAndPush(extensionUri) {
  const root = getWorkspaceRoot(extensionUri);
  if (!root) return false;

  const conflicts = runGit(root, ['diff', '--name-only', '--diff-filter=U']);
  if (conflicts) {
    vscode.window.showWarningMessage('Resolve merge conflicts before Commit & Push.');
    return false;
  }

  const staged = runGit(root, ['diff', '--cached', '--name-only']);
  if (!staged) {
    vscode.window.showWarningMessage('Stage the changes you want to commit first.');
    return false;
  }

  const message = await vscode.window.showInputBox({
    title: 'Safe Commit & Push',
    prompt: 'Commit message',
    placeHolder: 'feat: describe your changes'
  });
  if (!message?.trim()) return false;

  if (runGitLocal(root, ['commit', '-m', message.trim()], 'Commit created.') === null) {
    return false;
  }

  const branch = runGit(root, ['branch', '--show-current']);
  const confirm = await vscode.window.showInformationMessage(
    'Push commit on "' + (branch || 'current branch') + '" to origin?',
    { modal: true },
    'Push'
  );
  if (confirm !== 'Push') return true;

  return runGitLocal(root, ['push'], 'Commit pushed to origin.') !== null;
}

function renderChangedFiles(items) {
  if (!items.length) return '<p class="muted">No working-tree changes.</p>';
  return items.map((item) =>
    '<button class="repo-file-row" data-diff-path="' + escapeHtml(item.path) + '">' +
      '<span>' + escapeHtml(item.code) + '</span><strong>' + escapeHtml(item.path) + '</strong>' +
    '</button>'
  ).join('');
}

function renderConflictFiles(items) {
  if (!items.length) return '<p class="muted">No merge conflicts detected.</p>';
  return items.map((file) =>
    '<button class="repo-file-row conflict" data-conflict-path="' + escapeHtml(file) + '">' +
      '<span>!</span><strong>' + escapeHtml(file) + '</strong>' +
    '</button>'
  ).join('');
}

function renderMergedBranches(items) {
  if (!items.length) return '<p class="muted">No safe merged local branches found.</p>';
  return items.map((branch) =>
    '<div class="branch-clean-row"><strong>' + escapeHtml(branch) + '</strong>' +
    '<button data-delete-merged-branch="' + escapeHtml(branch) + '">Delete</button></div>'
  ).join('');
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

  sessionCommandCount++;

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


function getInstalledThemes() {
  const themes = [];

  for (const extension of vscode.extensions.all) {
    const contributed = extension.packageJSON?.contributes?.themes;
    if (!Array.isArray(contributed)) continue;

    for (const theme of contributed) {
      const label = theme.label || theme.id;
      if (!label) continue;
      if (!themes.some((item) => item.label === label)) {
        themes.push({
          label,
          uiTheme: theme.uiTheme || 'vs-dark'
        });
      }
    }
  }

  const currentTheme =
    vscode.workspace.getConfiguration('workbench').get('colorTheme') || '';

  themes.sort((a, b) => {
    if (a.label === currentTheme) return -1;
    if (b.label === currentTheme) return 1;
    if (/masum|galaxy/i.test(a.label) && !/masum|galaxy/i.test(b.label)) return -1;
    if (/masum|galaxy/i.test(b.label) && !/masum|galaxy/i.test(a.label)) return 1;
    return a.label.localeCompare(b.label);
  });

  return {
    currentTheme,
    themes: themes.slice(0, 12)
  };
}

function getDeveloperModeState(context) {
  return {
    active: context?.globalState.get('galaxy.activeDeveloperMode', 'Default') || 'Default'
  };
}

async function setDeveloperMode(context, mode) {
  const normalized = String(mode || 'Default');
  if (context) {
    await context.globalState.update('galaxy.activeDeveloperMode', normalized);
  }

  switch (normalized) {
    case 'Frontend':
      await vscode.commands.executeCommand('workbench.view.explorer');
      await vscode.commands.executeCommand('workbench.action.terminal.toggleTerminal');
      break;
    case 'Python':
      await vscode.commands.executeCommand('workbench.view.explorer');
      await vscode.commands.executeCommand('workbench.action.terminal.toggleTerminal');
      break;
    case 'AI / ML':
      await vscode.commands.executeCommand('workbench.view.explorer');
      await vscode.commands.executeCommand('workbench.action.terminal.toggleTerminal');
      break;
    case 'Debug':
      await vscode.commands.executeCommand('workbench.view.debug');
      break;
    case 'Study':
      await vscode.commands.executeCommand('workbench.action.toggleCenteredLayout');
      break;
    case 'Focus':
      await vscode.commands.executeCommand('workbench.action.toggleZenMode');
      break;
    default:
      await vscode.commands.executeCommand('workbench.view.explorer');
      break;
  }
}

async function applyTheme(themeLabel) {
  const label = String(themeLabel || '').trim();
  if (!label) return;

  const available = getInstalledThemes().themes.some((theme) => theme.label === label);
  if (!available) {
    vscode.window.showWarningMessage(`Theme "${label}" is not currently installed.`);
    return;
  }

  await vscode.workspace
    .getConfiguration('workbench')
    .update('colorTheme', label, vscode.ConfigurationTarget.Global);
}

function renderThemeMatrix(themeState) {
  if (!themeState.themes.length) {
    return '<p class="muted">No contributed color themes detected.</p>';
  }

  return themeState.themes
    .map((theme) => {
      const active = theme.label === themeState.currentTheme;
      return `
        <button class="theme-tile ${active ? 'active' : ''}" data-theme-label="${escapeHtml(theme.label)}">
          <span>${active ? '●' : '○'}</span>
          <strong>${escapeHtml(theme.label)}</strong>
        </button>`;
    })
    .join('');
}




function localDayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return year + '-' + month + '-' + day;
}

function formatTimerClock(ms) {
  const totalSeconds = Math.max(0, Math.ceil(Number(ms || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}

function formatCompactDuration(ms) {
  const totalMinutes = Math.max(0, Math.floor(Number(ms || 0) / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours && minutes) return hours + 'h ' + minutes + 'm';
  if (hours) return hours + 'h';
  return minutes + 'm';
}

function trimCodingHistory(history, keepDays = 30) {
  const keys = Object.keys(history || {}).sort().reverse();
  const keep = new Set(keys.slice(0, keepDays));
  const next = {};
  for (const key of keys) {
    if (keep.has(key)) next[key] = history[key];
  }
  return next;
}

function getTodayCodingRecord(context) {
  const history = context?.globalState.get('galaxy.codingHistory', {}) || {};
  const key = localDayKey();
  return history[key] || {
    activeMs: 0,
    edits: 0,
    saves: 0,
    files: {},
    languages: {},
    projects: {}
  };
}

async function recordCodingActivity(context, elapsedMs) {
  if (!context || elapsedMs <= 0) return;

  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') return;
  if (!galaxyWindowFocused) return;
  if (Date.now() - lastCodingActivityAt > 120000) return;

  const root = getWorkspaceRoot();
  if (!root) return;

  const language = editor.document.languageId || 'unknown';
  const filePath = editor.document.uri.fsPath;
  const relative = path.relative(root, filePath) || path.basename(filePath);
  const project = path.basename(root);

  let history = context.globalState.get('galaxy.codingHistory', {}) || {};
  const key = localDayKey();
  const day = history[key] || {
    activeMs: 0,
    edits: 0,
    saves: 0,
    files: {},
    languages: {},
    projects: {}
  };

  day.activeMs = Number(day.activeMs || 0) + elapsedMs;
  day.languages = day.languages || {};
  day.languages[language] = Number(day.languages[language] || 0) + elapsedMs;

  day.projects = day.projects || {};
  day.projects[project] = Number(day.projects[project] || 0) + elapsedMs;

  day.files = day.files || {};
  const file = day.files[relative] || {
    language,
    activeMs: 0,
    edits: 0,
    saves: 0
  };
  file.language = language;
  file.activeMs = Number(file.activeMs || 0) + elapsedMs;
  day.files[relative] = file;

  history[key] = day;
  history = trimCodingHistory(history);
  await context.globalState.update('galaxy.codingHistory', history);
}

async function recordCodingEdit(context, document) {
  if (!context || !document || document.uri.scheme !== 'file') return;
  const root = getWorkspaceRoot();
  if (!root || !document.uri.fsPath.startsWith(root)) return;

  lastCodingActivityAt = Date.now();

  let history = context.globalState.get('galaxy.codingHistory', {}) || {};
  const key = localDayKey();
  const day = history[key] || {
    activeMs: 0,
    edits: 0,
    saves: 0,
    files: {},
    languages: {},
    projects: {}
  };

  const relative = path.relative(root, document.uri.fsPath) || path.basename(document.uri.fsPath);
  const language = document.languageId || 'unknown';
  const file = day.files?.[relative] || {
    language,
    activeMs: 0,
    edits: 0,
    saves: 0
  };

  file.language = language;
  file.edits = Number(file.edits || 0) + 1;
  day.files = day.files || {};
  day.files[relative] = file;
  day.edits = Number(day.edits || 0) + 1;

  history[key] = day;
  await context.globalState.update('galaxy.codingHistory', trimCodingHistory(history));
}

async function recordCodingSave(context, document) {
  if (!context || !document || document.uri.scheme !== 'file') return;
  const root = getWorkspaceRoot();
  if (!root || !document.uri.fsPath.startsWith(root)) return;

  let history = context.globalState.get('galaxy.codingHistory', {}) || {};
  const key = localDayKey();
  const day = history[key] || {
    activeMs: 0,
    edits: 0,
    saves: 0,
    files: {},
    languages: {},
    projects: {}
  };

  const relative = path.relative(root, document.uri.fsPath) || path.basename(document.uri.fsPath);
  const language = document.languageId || 'unknown';
  const file = day.files?.[relative] || {
    language,
    activeMs: 0,
    edits: 0,
    saves: 0
  };

  file.language = language;
  file.saves = Number(file.saves || 0) + 1;
  day.files = day.files || {};
  day.files[relative] = file;
  day.saves = Number(day.saves || 0) + 1;

  history[key] = day;
  await context.globalState.update('galaxy.codingHistory', trimCodingHistory(history));
}

function getCodingHistoryState(context) {
  const history = context?.globalState.get('galaxy.codingHistory', {}) || {};
  const todayKey = localDayKey();
  const today = history[todayKey] || {
    activeMs: 0,
    edits: 0,
    saves: 0,
    files: {},
    languages: {},
    projects: {}
  };

  const goalMinutes = Number(context?.globalState.get('galaxy.dailyCodingGoalMinutes', 240) || 240);
  const files = Object.entries(today.files || {})
    .map(([name, value]) => ({
      name,
      language: value.language || 'unknown',
      activeMs: Number(value.activeMs || 0),
      edits: Number(value.edits || 0),
      saves: Number(value.saves || 0)
    }))
    .sort((a, b) => (b.activeMs + b.edits * 1000) - (a.activeMs + a.edits * 1000))
    .slice(0, 8);

  const languages = Object.entries(today.languages || {})
    .map(([name, activeMs]) => ({ name, activeMs: Number(activeMs || 0) }))
    .sort((a, b) => b.activeMs - a.activeMs)
    .slice(0, 6);

  const recentDays = Object.keys(history)
    .sort()
    .reverse()
    .slice(0, 7)
    .map((key) => ({
      date: key,
      activeMs: Number(history[key]?.activeMs || 0),
      edits: Number(history[key]?.edits || 0),
      saves: Number(history[key]?.saves || 0)
    }));

  const goalMs = goalMinutes * 60000;
  return {
    todayKey,
    activeMs: Number(today.activeMs || 0),
    activeText: formatCompactDuration(today.activeMs || 0),
    edits: Number(today.edits || 0),
    saves: Number(today.saves || 0),
    files,
    languages,
    recentDays,
    goalMinutes,
    goalText: formatCompactDuration(goalMs),
    goalPercent: goalMs > 0 ? Math.min(100, Math.round((Number(today.activeMs || 0) / goalMs) * 100)) : 0
  };
}

function getFocusTimerState(context) {
  const stored = context?.globalState.get('galaxy.focusTimer', null);
  if (!stored) {
    return {
      running: false,
      paused: false,
      durationMinutes: 0,
      remainingMs: 0,
      endAt: 0,
      label: 'Ready'
    };
  }

  let remainingMs = Number(stored.remainingMs || 0);
  if (stored.running && stored.endAt) {
    remainingMs = Math.max(0, Number(stored.endAt) - Date.now());
  }

  return {
    ...stored,
    remainingMs,
    label: stored.running ? 'Focus Running' : (remainingMs > 0 ? 'Paused' : 'Ready')
  };
}

async function setDailyCodingGoal(context) {
  const current = Number(context?.globalState.get('galaxy.dailyCodingGoalMinutes', 240) || 240);
  const value = await vscode.window.showInputBox({
    title: 'Daily Coding Goal',
    prompt: 'How many minutes do you want to code today?',
    value: String(current),
    validateInput: (input) => {
      const minutes = Number(input);
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
        return 'Enter a number between 1 and 1440 minutes.';
      }
      return undefined;
    }
  });
  if (value === undefined) return false;
  await context.globalState.update('galaxy.dailyCodingGoalMinutes', Number(value));
  return true;
}

async function startFocusTimer(context, minutes) {
  const durationMinutes = Number(minutes);
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) return false;

  const now = Date.now();
  const state = {
    running: true,
    paused: false,
    durationMinutes,
    remainingMs: durationMinutes * 60000,
    startedAt: now,
    endAt: now + durationMinutes * 60000
  };

  focusTimerCompletionKey = '';
  await context.globalState.update('galaxy.focusTimer', state);
  vscode.window.showInformationMessage('Galaxy Focus started for ' + durationMinutes + ' minutes.');
  return true;
}

async function startCustomFocusTimer(context) {
  const value = await vscode.window.showInputBox({
    title: 'Start Focus Timer',
    prompt: 'Focus duration in minutes',
    value: '60',
    validateInput: (input) => {
      const minutes = Number(input);
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 720) {
        return 'Enter a number between 1 and 720 minutes.';
      }
      return undefined;
    }
  });
  if (value === undefined) return false;
  return startFocusTimer(context, Number(value));
}

async function pauseFocusTimer(context) {
  const state = getFocusTimerState(context);
  if (!state.running) return false;

  await context.globalState.update('galaxy.focusTimer', {
    ...state,
    running: false,
    paused: true,
    endAt: 0
  });
  return true;
}

async function resumeFocusTimer(context) {
  const state = getFocusTimerState(context);
  if (state.running || state.remainingMs <= 0) return false;

  await context.globalState.update('galaxy.focusTimer', {
    ...state,
    running: true,
    paused: false,
    endAt: Date.now() + state.remainingMs
  });
  return true;
}

async function stopFocusTimer(context) {
  await context.globalState.update('galaxy.focusTimer', null);
  focusTimerCompletionKey = '';
  return true;
}

async function checkFocusTimerCompletion(context) {
  const state = getFocusTimerState(context);
  if (!state.running || state.remainingMs > 0) return;

  const key = String(state.startedAt || state.endAt || 'done');
  if (focusTimerCompletionKey === key) return;
  focusTimerCompletionKey = key;

  await context.globalState.update('galaxy.focusTimer', null);
  vscode.window.showInformationMessage('Galaxy Focus complete. Nice — your timer is finished.');
}

function renderCodingFiles(files) {
  if (!files.length) return '<p class="muted">No coding activity recorded yet today.</p>';
  return files.map((file) =>
    '<div class="history-row"><div><strong>' + escapeHtml(file.name) +
    '</strong><small>' + escapeHtml(file.language) + ' · ' + file.edits + ' edits · ' +
    file.saves + ' saves</small></div><span>' + escapeHtml(formatCompactDuration(file.activeMs)) +
    '</span></div>'
  ).join('');
}

function renderLanguageHistory(items) {
  if (!items.length) return '<span class="muted">No language activity yet.</span>';
  return items.map((item) =>
    '<span class="language-pill">' + escapeHtml(item.name) + ' · ' +
    escapeHtml(formatCompactDuration(item.activeMs)) + '</span>'
  ).join('');
}

function renderRecentCodingDays(items) {
  if (!items.length) return '<p class="muted">No recent history yet.</p>';
  return items.map((item) =>
    '<div class="history-day"><strong>' + escapeHtml(item.date) + '</strong><span>' +
    escapeHtml(formatCompactDuration(item.activeMs)) + ' · ' + item.edits +
    ' edits · ' + item.saves + ' saves</span></div>'
  ).join('');
}

function workspaceStateKey(extensionUri) {
  return getWorkspaceRoot(extensionUri) || 'no-workspace';
}

function getProjectNote(context, extensionUri) {
  if (!context) return '';
  const notes = context.globalState.get('galaxy.projectNotes', {});
  return notes[workspaceStateKey(extensionUri)] || '';
}

async function editProjectNote(context, extensionUri) {
  if (!context) return false;

  const key = workspaceStateKey(extensionUri);
  const notes = context.globalState.get('galaxy.projectNotes', {});
  const current = notes[key] || '';

  const value = await vscode.window.showInputBox({
    title: 'Project Note',
    prompt: 'Add a short note or next task for this workspace',
    value: current,
    placeHolder: 'Next: finish dashboard polish and test packaging'
  });

  if (value === undefined) return false;

  if (value.trim()) {
    notes[key] = value.trim();
  } else {
    delete notes[key];
  }

  await context.globalState.update('galaxy.projectNotes', notes);
  return true;
}

function formatSessionDuration(ms) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function getSessionStats() {
  return {
    duration: formatSessionDuration(Date.now() - sessionStartedAt),
    filesTouched: sessionTouchedFiles.size,
    commandsRun: sessionCommandCount,
    saves: sessionSaveCount
  };
}

function snapshotStorageKey(extensionUri) {
  return workspaceStateKey(extensionUri);
}

function getWorkspaceSnapshots(context, extensionUri) {
  if (!context) return [];
  const all = context.globalState.get('galaxy.workspaceSnapshots', {});
  return all[snapshotStorageKey(extensionUri)] || [];
}

async function createWorkspaceSnapshot(context, extensionUri) {
  if (!context) return false;

  const root = getWorkspaceRoot(extensionUri);
  const defaultName = `Snapshot ${new Date().toLocaleString()}`;
  const name = await vscode.window.showInputBox({
    title: 'Create Workspace Snapshot',
    prompt: 'Name this lightweight workspace snapshot',
    value: defaultName
  });

  if (!name?.trim()) return false;

  const activeEditor = vscode.window.activeTextEditor;
  const snapshots = getWorkspaceSnapshots(context, extensionUri);
  const snapshot = {
    id: String(Date.now()),
    name: name.trim(),
    createdAt: Date.now(),
    theme: vscode.workspace.getConfiguration('workbench').get('colorTheme') || '',
    activeMode: context.globalState.get('galaxy.activeDeveloperMode', 'Default'),
    hiddenWidgets: context.globalState.get('galaxy.hiddenWidgets', []),
    pinnedCommands: context.globalState.get('galaxy.pinnedCommands', []),
    projectNote: getProjectNote(context, extensionUri),
    activeFile: activeEditor?.document?.uri?.toString() || '',
    workspace: root
  };

  const all = context.globalState.get('galaxy.workspaceSnapshots', {});
  all[snapshotStorageKey(extensionUri)] = [snapshot, ...snapshots].slice(0, 8);
  await context.globalState.update('galaxy.workspaceSnapshots', all);

  vscode.window.showInformationMessage(`Workspace snapshot "${snapshot.name}" saved.`);
  return true;
}

async function restoreWorkspaceSnapshot(context, extensionUri, snapshotId) {
  if (!context || !snapshotId) return false;

  const snapshots = getWorkspaceSnapshots(context, extensionUri);
  const snapshot = snapshots.find((item) => item.id === snapshotId);
  if (!snapshot) {
    vscode.window.showWarningMessage('Workspace snapshot was not found.');
    return false;
  }

  if (snapshot.theme) {
    await vscode.workspace
      .getConfiguration('workbench')
      .update('colorTheme', snapshot.theme, vscode.ConfigurationTarget.Global);
  }

  await context.globalState.update('galaxy.activeDeveloperMode', snapshot.activeMode || 'Default');
  await context.globalState.update('galaxy.hiddenWidgets', snapshot.hiddenWidgets || []);
  await context.globalState.update('galaxy.pinnedCommands', snapshot.pinnedCommands || []);

  const notes = context.globalState.get('galaxy.projectNotes', {});
  const key = workspaceStateKey(extensionUri);
  if (snapshot.projectNote) notes[key] = snapshot.projectNote;
  else delete notes[key];
  await context.globalState.update('galaxy.projectNotes', notes);

  if (snapshot.activeFile) {
    try {
      const uri = vscode.Uri.parse(snapshot.activeFile);
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: false });
    } catch {
      // Snapshot can still restore UI state if the old active file no longer exists.
    }
  }

  vscode.window.showInformationMessage(`Workspace snapshot "${snapshot.name}" restored.`);
  return true;
}

async function deleteWorkspaceSnapshot(context, extensionUri, snapshotId) {
  if (!context || !snapshotId) return false;

  const key = snapshotStorageKey(extensionUri);
  const all = context.globalState.get('galaxy.workspaceSnapshots', {});
  const snapshots = all[key] || [];
  const snapshot = snapshots.find((item) => item.id === snapshotId);
  if (!snapshot) return false;

  const confirm = await vscode.window.showWarningMessage(
    'Delete workspace snapshot "' + snapshot.name + '"?',
    { modal: true },
    'Delete'
  );
  if (confirm !== 'Delete') return false;

  all[key] = snapshots.filter((item) => item.id !== snapshotId);
  await context.globalState.update('galaxy.workspaceSnapshots', all);
  return true;
}

function renderWorkspaceSnapshots(snapshots) {
  if (!snapshots.length) {
    return '<p class="muted">No snapshots yet. Create one before a major workspace/layout change.</p>';
  }

  return snapshots
    .slice(0, 6)
    .map((snapshot) => {
      const when = new Date(snapshot.createdAt).toLocaleString();
      return `
        <div class="snapshot-row">
          <div class="snapshot-copy">
            <strong>${escapeHtml(snapshot.name)}</strong>
            <small>${escapeHtml(when)} · ${escapeHtml(snapshot.activeMode || 'Default')}</small>
          </div>
          <button data-restore-snapshot="${escapeHtml(snapshot.id)}">Restore</button>
          <button data-delete-snapshot="${escapeHtml(snapshot.id)}">×</button>
        </div>`;
    })
    .join('');
}

const DASHBOARD_WIDGETS = [
  { id: 'health', label: 'Project Health' },
  { id: 'environment', label: 'Environment Status' },
  { id: 'server', label: 'Dev Server Monitor' },
  { id: 'smartActions', label: 'Smart Project Actions' },
  { id: 'smartDeveloper', label: 'Smart Developer Assistant' },
  { id: 'aiFix', label: 'AI Fix Studio' },
  { id: 'quality', label: 'Quality Gate + Auto Verify' },
  { id: 'analytics', label: 'Developer Analytics + Project Intelligence' },
  { id: 'architecture', label: 'Workspace Architecture Intelligence' },
  { id: 'orchestrator', label: 'Workspace Task Orchestrator' },
  { id: 'cpArena', label: 'Galaxy CP Arena' },
  { id: 'git', label: 'Repository Control Hub' },
  { id: 'commands', label: 'Command History + Pinned Commands' },
  { id: 'modes', label: 'Developer Modes' },
  { id: 'themes', label: 'Theme Matrix' },
  { id: 'ai', label: 'AI HUD' },
  { id: 'debug', label: 'AI Debug Assistant' },
  { id: 'notes', label: 'Project Notes' },
  { id: 'session', label: 'Coding Session Stats' },
  { id: 'focus', label: 'Coding Focus + History' },
  { id: 'snapshots', label: 'Workspace Snapshots' },
  { id: 'extensions', label: 'Galaxy Extension Hub' },
  { id: 'projects', label: 'Project Launcher' },
  { id: 'files', label: 'Recent Files' }
];

function getWidgetState(context) {
  return {
    hidden: context?.globalState.get('galaxy.hiddenWidgets', []) || []
  };
}

async function customizeDashboardWidgets(context) {
  if (!context) return false;

  const hidden = context.globalState.get('galaxy.hiddenWidgets', []);
  const items = DASHBOARD_WIDGETS.map((widget) => ({
    label: widget.label,
    description: widget.id,
    picked: !hidden.includes(widget.id),
    widgetId: widget.id
  }));

  const selected = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: 'Customize Galaxy Command Center',
    placeHolder: 'Select the widgets you want to keep visible'
  });

  if (!selected) return false;

  const visibleIds = new Set(selected.map((item) => item.widgetId));
  const nextHidden = DASHBOARD_WIDGETS
    .map((widget) => widget.id)
    .filter((id) => !visibleIds.has(id));

  await context.globalState.update('galaxy.hiddenWidgets', nextHidden);
  return true;
}

function getGalaxyExtensions() {
  return vscode.extensions.all
    .filter((extension) => {
      const publisher = String(extension.packageJSON?.publisher || '').toLowerCase();
      const name = String(extension.packageJSON?.displayName || extension.packageJSON?.name || '').toLowerCase();
      return publisher === 'gitwithmasum' || /masum|galaxy/.test(name);
    })
    .map((extension) => ({
      id: extension.id,
      name: extension.packageJSON?.displayName || extension.packageJSON?.name || extension.id,
      version: extension.packageJSON?.version || '',
      active: extension.isActive
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function renderGalaxyExtensions(extensions) {
  if (!extensions.length) {
    return '<p class="muted">No Masum/Galaxy extensions detected in this VS Code profile.</p>';
  }

  return extensions
    .map(
      (extension) => `
        <div class="hub-row">
          <div class="hub-copy">
            <strong>${escapeHtml(extension.name)}</strong>
            <small>${escapeHtml(extension.id)} · v${escapeHtml(extension.version)} · ${extension.active ? 'Active' : 'Installed'}</small>
          </div>
          <button data-extension-id="${escapeHtml(extension.id)}">Marketplace</button>
        </div>`
    )
    .join('');
}




function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}



async function getCpSourceDocument() {
  const active = vscode.window.activeTextEditor?.document;
  if (active?.uri?.scheme === 'file') return active;

  if (lastEditorContext.uri) {
    try {
      const uri = vscode.Uri.parse(lastEditorContext.uri);
      if (uri.scheme === 'file') {
        return await vscode.workspace.openTextDocument(uri);
      }
    } catch {}
  }

  return null;
}

async function getCpEditableEditor() {
  const active = vscode.window.activeTextEditor;
  if (active?.document?.uri?.scheme === 'file') return active;

  const document = await getCpSourceDocument();
  if (!document) return null;

  return vscode.window.showTextDocument(document, {
    preview: false,
    preserveFocus: false
  });
}

async function startCpContestPrompt(context) {
  const value = await vscode.window.showInputBox({
    title: 'Galaxy CP Arena · New Contest',
    prompt: 'Contest duration in minutes',
    value: '120',
    validateInput: (input) => {
      const minutes = Number(input);
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 720) {
        return 'Enter a number between 1 and 720 minutes.';
      }
      return undefined;
    }
  });

  if (value === undefined) return false;

  const current = getCpArenaState(context);
  const hasActivity =
    current.contest.running ||
    current.problems.some((item) => item.status !== 'NOT STARTED');

  if (hasActivity) {
    const confirm = await vscode.window.showWarningMessage(
      'Starting a new CP contest resets the current problem tracker.',
      { modal: true },
      'Start New Contest'
    );
    if (confirm !== 'Start New Contest') return false;
  }

  await startNewContest(context, Number(value));
  vscode.window.showInformationMessage(
    'Galaxy CP contest started for ' + Number(value) + ' minutes.'
  );
  return true;
}

async function stopCpContestAction(context) {
  await stopContest(context);
  vscode.window.showInformationMessage('Galaxy CP contest timer stopped.');
  return true;
}

async function resetCpArenaAction(context) {
  const confirm = await vscode.window.showWarningMessage(
    'Reset the current Galaxy CP Arena session?',
    { modal: true },
    'Reset'
  );
  if (confirm !== 'Reset') return false;
  await resetCpSession(context);
  cpAiState = { running: false, kind: '', result: '', model: '', error: '' };
  return true;
}

async function runCpSampleAction(context, value) {
  const document = await getCpSourceDocument();
  if (!document || document.uri.scheme !== 'file') {
    vscode.window.showInformationMessage('Open a C/C++, Python, or JavaScript source file first.');
    return false;
  }

  if (document.isDirty) {
    const saved = await document.save();
    if (!saved) {
      vscode.window.showWarningMessage('Save the source file before running a CP sample.');
      return false;
    }
  }

  const input = String(value?.input || '').slice(0, 20000);
  const expected = String(value?.expected || '').slice(0, 20000);

  vscode.window.setStatusBarMessage('Galaxy CP · Running sample…', 2200);
  const run = await runCurrentFile(document, input, expected);
  run.input = input;
  await saveLastRun(context, run);

  if (run.verdict === 'PASS') {
    vscode.window.showInformationMessage(
      'Galaxy CP: sample passed in ' + run.runtimeMs + ' ms.'
    );
  } else {
    vscode.window.showWarningMessage(
      'Galaxy CP: ' + run.verdict + ' · ' + run.runtimeMs + ' ms.'
    );
  }
  return true;
}


async function runCpMultiCaseAction(context, value) {
  const document = await getCpSourceDocument();
  if (!document || document.uri.scheme !== 'file') {
    vscode.window.showInformationMessage('Open a C/C++, Python, or JavaScript source file first.');
    return false;
  }

  if (document.isDirty && !(await document.save())) {
    vscode.window.showWarningMessage('Save the source file before running CP cases.');
    return false;
  }

  const rawInputs = String(value?.input || '').slice(0, 50000);
  const rawExpected = String(value?.expected || '').slice(0, 50000);
  const suite = await runMultipleCases(document, rawInputs, rawExpected);

  if (!suite.ok) {
    vscode.window.showWarningMessage('Galaxy CP Multi Judge: ' + (suite.error || 'Unable to run cases.'));
    return false;
  }

  await saveLastSuite(context, suite);

  if (suite.verdict === 'PASS') {
    vscode.window.showInformationMessage(
      'Galaxy CP: all ' + suite.total + ' cases passed.'
    );
  } else {
    vscode.window.showWarningMessage(
      'Galaxy CP: ' + suite.verdict + ' after ' + suite.passed + '/' + suite.total + ' passed.'
    );
  }
  return true;
}

async function createCpProblemFile(context) {
  const root = getWorkspaceRoot();
  if (!root) {
    vscode.window.showInformationMessage('Open a workspace folder first.');
    return false;
  }

  const language = await vscode.window.showQuickPick(
    [
      { label: 'C++17', value: 'cpp' },
      { label: 'Python 3', value: 'python' },
      { label: 'JavaScript (Node)', value: 'javascript' }
    ],
    {
      title: 'Galaxy CP · New Problem File',
      placeHolder: 'Choose a language'
    }
  );
  if (!language) return false;

  const state = getCpArenaState(context);
  const label = await vscode.window.showInputBox({
    title: 'Problem Label',
    prompt: 'Problem label or short name',
    value: state.currentProblem || 'A',
    validateInput: (input) =>
      /^[A-Za-z0-9_-]{1,24}$/.test(String(input || ''))
        ? undefined
        : 'Use 1–24 letters, numbers, underscores, or hyphens.'
  });
  if (!label) return false;

  const template = getCpTemplate(language.value, label);
  const target = await vscode.window.showSaveDialog({
    title: 'Create CP Problem File',
    defaultUri: vscode.Uri.file(
      path.join(root, label.toLowerCase() + '.' + template.extension)
    ),
    saveLabel: 'Create Problem File',
    filters: {
      'Source File': [template.extension]
    }
  });
  if (!target) return false;

  if (fs.existsSync(target.fsPath)) {
    vscode.window.showWarningMessage('That file already exists. Choose a new filename.');
    return false;
  }

  await vscode.workspace.fs.writeFile(
    target,
    Buffer.from(template.content, 'utf8')
  );
  const document = await vscode.workspace.openTextDocument(target);
  await vscode.window.showTextDocument(document, { preview: false });
  vscode.window.showInformationMessage('Galaxy CP problem file created.');
  return true;
}

async function pickCpSourceFile(title, exclude = []) {
  const files = await vscode.workspace.findFiles(
    '**/*.{cpp,c,py,js}',
    '**/{node_modules,.git,dist,build,out,.next,coverage}/**',
    200
  );

  const excluded = new Set(exclude.map((value) => String(value || '').toLowerCase()));
  const items = files
    .filter((uri) => !excluded.has(uri.fsPath.toLowerCase()))
    .map((uri) => ({
      label: vscode.workspace.asRelativePath(uri, false),
      description: uri.fsPath,
      uri
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const selected = await vscode.window.showQuickPick(items, {
    title,
    placeHolder: 'Choose a source file'
  });
  return selected?.uri || null;
}

async function runCpStressAction(context) {
  const optimized = await getCpSourceDocument();
  if (!optimized || optimized.uri.scheme !== 'file') {
    vscode.window.showInformationMessage(
      'Open your optimized solution first. Galaxy CP uses the current/last active source file as Optimized.'
    );
    return false;
  }

  if (optimized.isDirty && !(await optimized.save())) {
    vscode.window.showWarningMessage('Save the optimized solution before stress testing.');
    return false;
  }

  const generatorUri = await pickCpSourceFile(
    'Galaxy CP Stress · Select Generator',
    [optimized.uri.fsPath]
  );
  if (!generatorUri) return false;

  const bruteUri = await pickCpSourceFile(
    'Galaxy CP Stress · Select Brute Solution',
    [optimized.uri.fsPath, generatorUri.fsPath]
  );
  if (!bruteUri) return false;

  const iterationsRaw = await vscode.window.showInputBox({
    title: 'Galaxy CP Stress Test',
    prompt: 'Number of random tests',
    value: '20',
    validateInput: (input) => {
      const count = Number(input);
      if (!Number.isInteger(count) || count < 1 || count > 100) {
        return 'Enter an integer between 1 and 100.';
      }
      return undefined;
    }
  });
  if (iterationsRaw === undefined) return false;

  const generator = await vscode.workspace.openTextDocument(generatorUri);
  const brute = await vscode.workspace.openTextDocument(bruteUri);
  if (generator.isDirty) await generator.save();
  if (brute.isDirty) await brute.save();

  vscode.window.setStatusBarMessage('Galaxy CP · Stress test running…', 3000);
  const result = await runStressTest(
    generator,
    brute,
    optimized,
    Number(iterationsRaw)
  );

  await saveStressResult(context, result);

  if (!result.ok) {
    vscode.window.showWarningMessage(
      'Galaxy CP Stress failed at ' + (result.stage || 'unknown stage') +
      (result.iteration ? ' · iteration ' + result.iteration : '') + '.'
    );
    return false;
  }

  if (result.verdict === 'MISMATCH') {
    vscode.window.showWarningMessage(
      'Galaxy CP found a mismatch at iteration ' + result.iteration + '.'
    );
  } else {
    vscode.window.showInformationMessage(
      'Galaxy CP stress test passed ' + result.iterations + ' iteration(s).'
    );
  }
  return true;
}

function renderCpHistory(history) {
  if (!history?.length) {
    return '<p class="muted">No CP verdict history yet.</p>';
  }

  return history.slice(0, 10).map((item) => {
    const when = item.at ? new Date(item.at).toLocaleTimeString() : '';
    const detail =
      item.type === 'suite'
        ? (Number(item.passed || 0) + '/' + Number(item.total || 0) + ' cases')
        : item.type === 'stress'
          ? ('iteration ' + Number(item.iteration || 0))
          : (Number(item.runtimeMs || 0) + ' ms');

    return '<div class="history-row"><div><strong>Problem ' +
      escapeHtml(item.problem || '?') + ' · ' + escapeHtml(item.verdict || item.type || 'RUN') +
      '</strong><small>' + escapeHtml(item.type || 'sample') + ' · ' +
      escapeHtml(when) + '</small></div><span>' + escapeHtml(detail) + '</span></div>';
  }).join('');
}

function renderCpSuite(suite) {
  if (!suite?.cases?.length) return '';
  return suite.cases.map((item) =>
    '<div class="history-row"><div><strong>Case ' + item.index + ' · ' +
    escapeHtml(item.verdict) + '</strong><small>' +
    Number(item.runtimeMs || 0) + ' ms</small></div><span>' +
    (item.verdict === 'PASS' ? '✓' : '×') + '</span></div>'
  ).join('');
}

async function openCpSnippetVault() {
  const editor = await getCpEditableEditor();
  if (!editor) {
    vscode.window.showInformationMessage('Open a source file first.');
    return false;
  }

  const snippets = getCpSnippets(editor.document.languageId);
  const selected = await vscode.window.showQuickPick(
    snippets.map((item) => ({
      label: item.label,
      description: item.detail,
      snippet: item.code
    })),
    {
      title: 'Galaxy CP Snippet Vault',
      placeHolder: 'Choose a competitive-programming snippet'
    }
  );

  if (!selected) return false;

  await editor.edit((builder) => {
    builder.replace(editor.selection, selected.snippet);
  });
  return true;
}

async function runCpAi(kind) {
  const document = await getCpSourceDocument();
  if (!document || document.uri.scheme !== 'file') {
    vscode.window.showInformationMessage('Open a source file first.');
    return false;
  }

  const cached = getBestEditorContext();
  const selected =
    cached.uri === document.uri.toString()
      ? String(cached.selectedText || '')
      : '';
  const source = selected || document.getText();

  cpAiState = {
    running: true,
    kind,
    result: '',
    model: '',
    error: ''
  };
  if (dashboardRenderCallback) await dashboardRenderCallback();

  let prompt = '';
  let instruction = '';

  if (kind === 'complexity') {
    prompt = [
      'Analyze the time and space complexity of this competitive-programming code.',
      'Return: Time Complexity, Space Complexity, Why, Bottleneck, and whether it is likely safe for common constraints such as 1e5 or 1e6.',
      'State uncertainty when input constraints are missing.',
      '',
      'Language: ' + document.languageId,
      selected ? 'Context: selected code' : 'Context: current file',
      '',
      truncatePromptText(source, 14000)
    ].join('\n');
    instruction =
      'Act as a competitive-programming coach. Be mathematically precise and do not invent constraints.';
  } else if (kind === 'edge-cases') {
    prompt = [
      'Generate high-value edge cases for this competitive-programming solution.',
      'Focus on boundaries, duplicates, sorted/reversed data, zero/one-element cases, overflow, disconnected cases, and algorithm-specific traps when relevant.',
      'Return a concise numbered list with why each case matters. Include concrete sample inputs only when the input format is inferable from the code.',
      '',
      'Language: ' + document.languageId,
      '',
      truncatePromptText(source, 14000)
    ].join('\n');
    instruction =
      'Act as a competitive-programming test designer. Do not pretend to know an input format that is not visible.';
  }

  const ai = await requestGalaxyModel(prompt, instruction);
  cpAiState = {
    running: false,
    kind,
    result: ai.text,
    model: ai.model,
    error: ai.error
  };

  if (dashboardRenderCallback) await dashboardRenderCallback();
  return ai.ok;
}

async function runCpPanicAssist() {
  const statement = (await vscode.env.clipboard.readText()).trim();
  if (!statement) {
    vscode.window.showInformationMessage(
      'Copy the problem statement first, then use CP Panic Assist.'
    );
    return false;
  }

  cpAiState = {
    running: true,
    kind: 'panic',
    result: '',
    model: '',
    error: ''
  };
  if (dashboardRenderCallback) await dashboardRenderCallback();

  const ai = await requestGalaxyModel(
    [
      'A competitive-programming contestant is stuck on this problem.',
      'Do NOT give a full final solution or complete implementation.',
      'Give exactly three escalating hints:',
      'Hint 1: direction / observation only.',
      'Hint 2: likely algorithm or data structure.',
      'Hint 3: pseudocode-level strategy and important edge cases.',
      'Also mention the likely target complexity if it can be inferred.',
      '',
      truncatePromptText(statement, 12000)
    ].join('\n'),
    'Act as a competitive-programming coach. Preserve the learning value and avoid giving a copy-paste final answer.'
  );

  cpAiState = {
    running: false,
    kind: 'panic',
    result: ai.text,
    model: ai.model,
    error: ai.error
  };

  if (dashboardRenderCallback) await dashboardRenderCallback();
  return ai.ok;
}

async function toggleCpFocusMode() {
  const commands = await vscode.commands.getCommands(true);
  if (!commands.includes('workbench.action.toggleZenMode')) {
    vscode.window.showInformationMessage('VS Code Zen Mode is unavailable.');
    return false;
  }
  await vscode.commands.executeCommand('workbench.action.toggleZenMode');
  return true;
}

async function openCpPlatform(platform) {
  const urls = {
    codeforces: 'https://codeforces.com/',
    atcoder: 'https://atcoder.jp/',
    leetcode: 'https://leetcode.com/',
    codechef: 'https://www.codechef.com/'
  };
  const url = urls[String(platform || '').toLowerCase()];
  if (!url) return false;
  await vscode.env.openExternal(vscode.Uri.parse(url));
  return true;
}

async function checkCpContestCompletion(context) {
  const state = getCpArenaState(context);
  if (!state.contest.running || state.contest.remainingMs > 0) return;
  await stopContest(context);
  vscode.window.showWarningMessage('Galaxy CP contest time is up.');
  if (dashboardRenderCallback) await dashboardRenderCallback();
}


function isPathInsideRoot(root, filePath) {
  if (!root || !filePath) return false;
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function ensureQualityGateWorkspace(extensionUri) {
  const root = getWorkspaceRoot(extensionUri);
  const key = root ? path.resolve(root) : '__no_workspace__';
  if (qualityGateWorkspaceKey !== key) {
    qualityGateWorkspaceKey = key;
    qualityGateState = createQualityGateState();
  }
  return root;
}

function getQualityGateFingerprint(root) {
  if (!root) return '';
  const head = runGit(root, ['rev-parse', 'HEAD']) || '';
  const staged = runGit(root, ['diff', '--cached', '--no-ext-diff', '--binary']) || '';
  return crypto
    .createHash('sha256')
    .update(head + '\0' + staged)
    .digest('hex');
}

async function guardDirtyWorkspaceFiles(root) {
  const dirty = vscode.workspace.textDocuments.filter(
    (document) =>
      document.isDirty &&
      document.uri.scheme === 'file' &&
      isPathInsideRoot(root, document.uri.fsPath)
  );

  if (!dirty.length) return true;

  const confirm = await vscode.window.showWarningMessage(
    'Quality Gate found ' + dirty.length + ' unsaved workspace file(s). Save them before verification?',
    { modal: true },
    'Save All & Run'
  );
  if (confirm !== 'Save All & Run') return false;

  for (const document of dirty) {
    const saved = await document.save();
    if (!saved) {
      vscode.window.showWarningMessage(
        'Quality Gate stopped because a workspace file could not be saved.'
      );
      return false;
    }
  }
  return true;
}

function diagnosticPrivacyKey(item) {
  const material = [
    item.file || '',
    item.source || '',
    item.code || '',
    item.message || ''
  ].join('|');
  return crypto.createHash('sha256').update(material).digest('hex');
}

async function migrateRecurringErrorPrivacy(context) {
  if (!context) return;
  const stored = context.globalState.get('galaxy.errorRecurrence', {}) || {};
  const entries = Object.values(stored);
  if (!entries.some((item) => item && Object.prototype.hasOwnProperty.call(item, 'message'))) {
    return;
  }

  const migrated = {};
  for (const item of entries) {
    if (!item) continue;
    const key = item.key && !String(item.key).includes('|')
      ? String(item.key)
      : diagnosticPrivacyKey(item);

    const current = migrated[key] || {
      key,
      file: String(item.file || ''),
      source: String(item.source || ''),
      code: String(item.code || ''),
      count: 0,
      lastSeenAt: 0
    };

    current.count += Math.max(0, Number(item.count || 0));
    current.lastSeenAt = Math.max(
      Number(current.lastSeenAt || 0),
      Number(item.lastSeenAt || 0)
    );
    migrated[key] = current;
  }

  await context.globalState.update('galaxy.errorRecurrence', migrated);
}

function getCoverageState(extensionUri) {
  const root = getWorkspaceRoot(extensionUri);
  if (!root) return null;

  const summaryPath = path.join(root, 'coverage', 'coverage-summary.json');
  if (!fs.existsSync(summaryPath)) return null;

  try {
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    const total = summary.total || {};
    const value = (key) => {
      const pct = Number(total[key]?.pct);
      return Number.isFinite(pct) ? pct : null;
    };

    const weakFiles = Object.entries(summary)
      .filter(([key]) => key !== 'total')
      .map(([file, metrics]) => {
        const displayFile = path.isAbsolute(file)
          ? (path.relative(root, file) || path.basename(file))
          : String(file).replace(/\\/g, '/');
        return {
          file: displayFile,
          lines: Number(metrics?.lines?.pct)
        };
      })
      .filter((item) => Number.isFinite(item.lines) && item.lines < 80)
      .sort((a, b) => a.lines - b.lines)
      .slice(0, 5);

    return {
      lines: value('lines'),
      statements: value('statements'),
      functions: value('functions'),
      branches: value('branches'),
      weakFiles
    };
  } catch {
    return null;
  }
}

function getTopRecurringErrors(context) {
  const stored = context?.globalState.get('galaxy.errorRecurrence', {}) || {};
  return Object.values(stored)
    .sort((a, b) => Number(b.count || 0) - Number(a.count || 0))
    .slice(0, 5);
}

async function updateErrorRecurrence(context) {
  if (!context) return;

  const current = collectDebugDiagnostics()
    .filter((item) => item.severity === 'Error');
  const nextSignatures = new Set(current.map((item) => diagnosticSignature(item)));

  const newlySeen = current.filter(
    (item) => !activeDiagnosticSignatures.has(diagnosticSignature(item))
  );

  activeDiagnosticSignatures = nextSignatures;
  if (!newlySeen.length) return;

  await migrateRecurringErrorPrivacy(context);
  const stored = context.globalState.get('galaxy.errorRecurrence', {}) || {};
  for (const item of newlySeen) {
    const key = diagnosticPrivacyKey(item);

    const record = stored[key] || {
      key,
      file: item.file,
      source: item.source || '',
      code: item.code || '',
      count: 0,
      lastSeenAt: 0
    };

    record.count = Number(record.count || 0) + 1;
    record.lastSeenAt = Date.now();
    stored[key] = record;
  }

  const trimmed = Object.fromEntries(
    Object.entries(stored)
      .sort(([, a], [, b]) => Number(b.lastSeenAt || 0) - Number(a.lastSeenAt || 0))
      .slice(0, 100)
  );

  await context.globalState.update('galaxy.errorRecurrence', trimmed);
}

async function runVerificationScript(extensionUri, task) {
  const root = getWorkspaceRoot(extensionUri);
  if (!root) return null;

  const taskState = getSmartTaskScripts(extensionUri);
  const executable =
    taskState.packageManager === 'pnpm'
      ? (process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
      : taskState.packageManager === 'yarn'
        ? (process.platform === 'win32' ? 'yarn.cmd' : 'yarn')
        : (process.platform === 'win32' ? 'npm.cmd' : 'npm');

  const args =
    taskState.packageManager === 'yarn'
      ? [task.script]
      : ['run', task.script];

  const result = await runCapturedProcess(executable, args, root, 120000);
  return {
    kind: task.kind,
    script: task.script,
    exitCode: result.exitCode,
    passed: result.exitCode === 0,
    output: normalizeTaskOutput(result.stdout, result.stderr).slice(-5000)
  };
}

function calculateQualityGate({ errors, warnings, conflicts, checks, dependency }) {
  let score = 100;

  score -= Math.min(errors * 20, 60);
  score -= Math.min(warnings * 2, 12);
  if (conflicts > 0) score -= 30;

  const failedChecks = checks.filter((item) => !item.passed).length;
  score -= Math.min(failedChecks * 15, 45);

  if (dependency?.critical > 0) score -= 25;
  else if (dependency?.high > 0) score -= 15;
  else if (dependency?.moderate > 0) score -= 5;

  score = Math.max(0, Math.min(100, score));

  let status = 'READY';
  if (errors > 0 || conflicts > 0 || failedChecks > 0 || dependency?.critical > 0) {
    status = 'BLOCKED';
  } else if (warnings > 0 || dependency?.high > 0 || dependency?.moderate > 0 || dependency?.outdated > 0 || score < 90) {
    status = 'REVIEW';
  }

  return { score, status };
}

async function runQualityGate(context, extensionUri, options = {}) {
  const root = ensureQualityGateWorkspace(extensionUri);
  if (!root) {
    vscode.window.showWarningMessage('Open a workspace folder first.');
    return false;
  }

  if (qualityGateState.running) {
    vscode.window.showInformationMessage('Galaxy Quality Gate is already running.');
    return false;
  }

  if (!options.skipDirtyGuard) {
    const readyToRun = await guardDirtyWorkspaceFiles(root);
    if (!readyToRun) return false;
  }

  qualityGateState = {
    ...qualityGateState,
    running: true,
    status: 'RUNNING',
    checks: [],
    beforeErrors:
      Number.isInteger(options.beforeErrors)
        ? options.beforeErrors
        : qualityGateState.beforeErrors,
    message: ''
  };
  if (dashboardRenderCallback) await dashboardRenderCallback();

  await sleep(500);

  const taskState = getSmartTaskScripts(extensionUri);
  const orderedKinds = ['lint', 'typecheck', 'test', 'build'];
  const selectedTasks = orderedKinds
    .map((kind) => taskState.available.find((item) => item.kind === kind))
    .filter(Boolean);

  const checks = [];
  for (const task of selectedTasks) {
    const result = await runVerificationScript(extensionUri, task);
    if (result) checks.push(result);
  }

  await sleep(400);

  const diagnostics = collectDebugDiagnostics();
  const errors = diagnostics.filter((item) => item.severity === 'Error').length;
  const warnings = diagnostics.filter((item) => item.severity === 'Warning').length;
  const conflicts = runGit(root, ['diff', '--name-only', '--diff-filter=U'])
    .split(/\r?\n/)
    .filter(Boolean).length;

  const dependency = qualityGateState.dependency;
  const coverage = getCoverageState(extensionUri);
  const result = calculateQualityGate({
    errors,
    warnings,
    conflicts,
    checks,
    dependency
  });

  qualityGateState = {
    ...qualityGateState,
    running: false,
    status: result.status,
    score: result.score,
    errors,
    warnings,
    conflicts,
    checks,
    afterErrors: errors,
    coverage,
    lastRunAt: Date.now(),
    fingerprint: getQualityGateFingerprint(root),
    message:
      result.status === 'READY'
        ? 'All available quality checks passed.'
        : result.status === 'REVIEW'
          ? 'Checks passed with warnings or review items.'
          : 'One or more blocking quality checks failed.'
  };

  await recordQualityGateHistory(context, qualityGateState);

  if (dashboardRenderCallback) await dashboardRenderCallback();

  vscode.window.showInformationMessage(
    'Galaxy Quality Gate: ' + result.status + ' · ' + result.score + '/100'
  );
  return result.status === 'READY';
}

async function scanDependencies(extensionUri) {
  const root = ensureQualityGateWorkspace(extensionUri);
  if (!root) return false;

  if (qualityGateState.running) {
    vscode.window.showInformationMessage('Another Galaxy verification task is already running.');
    return false;
  }

  if (!fs.existsSync(path.join(root, 'package.json'))) {
    vscode.window.showInformationMessage('Dependency scan currently supports Node projects with package.json.');
    return false;
  }

  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  qualityGateState = {
    ...qualityGateState,
    running: true,
    message: 'Scanning npm dependency risk…'
  };
  if (dashboardRenderCallback) await dashboardRenderCallback();

  const [audit, outdatedResult] = await Promise.all([
    runCapturedProcess(
      npmCommand,
      ['audit', '--json'],
      root,
      90000
    ),
    runCapturedProcess(
      npmCommand,
      ['outdated', '--json'],
      root,
      90000
    )
  ]);

  let parsed = null;
  let outdated = null;
  try {
    parsed = JSON.parse((audit.stdout || audit.stderr || '{}').trim() || '{}');
  } catch {
    parsed = null;
  }
  try {
    outdated = JSON.parse((outdatedResult.stdout || '{}').trim() || '{}');
  } catch {
    outdated = null;
  }

  const vulnerabilities = parsed?.metadata?.vulnerabilities || {};
  const dependency = {
    critical: Number(vulnerabilities.critical || 0),
    high: Number(vulnerabilities.high || 0),
    moderate: Number(vulnerabilities.moderate || 0),
    low: Number(vulnerabilities.low || 0),
    total: Number(vulnerabilities.total || 0),
    outdated: outdated && typeof outdated === 'object' ? Object.keys(outdated).length : 0,
    scannedAt: Date.now(),
    error:
      parsed
        ? ''
        : 'npm audit output could not be parsed.'
  };

  qualityGateState = {
    ...qualityGateState,
    running: false,
    dependency,
    message:
      dependency.total > 0
        ? 'Dependency scan found ' + dependency.total + ' vulnerability report(s).'
        : 'Dependency scan found no reported vulnerabilities.'
  };

  if (dashboardRenderCallback) await dashboardRenderCallback();
  return true;
}

function getQualityGateState(context, extensionUri) {
  ensureQualityGateWorkspace(extensionUri);
  return {
    ...qualityGateState,
    coverage: qualityGateState.coverage || getCoverageState(extensionUri),
    recurringErrors: getTopRecurringErrors(context),
    canRollback: Boolean(lastAiApplyBackup)
  };
}

async function revertLastAiApply(extensionUri) {
  if (!lastAiApplyBackup) {
    vscode.window.showInformationMessage('No AI apply backup is available to revert.');
    return false;
  }

  const currentRoot = getWorkspaceRoot(extensionUri);
  if (
    lastAiApplyBackup.workspaceRoot &&
    path.resolve(lastAiApplyBackup.workspaceRoot) !== path.resolve(currentRoot || '')
  ) {
    vscode.window.showWarningMessage(
      'The last AI Apply belongs to a different workspace, so rollback was blocked.'
    );
    return false;
  }

  const confirm = await vscode.window.showWarningMessage(
    'Revert the last Galaxy AI Apply?',
    { modal: true },
    'Revert'
  );
  if (confirm !== 'Revert') return false;

  const backup = lastAiApplyBackup;

  if (backup.kind === 'created-file') {
    if (!fs.existsSync(backup.targetPath)) {
      lastAiApplyBackup = null;
      return false;
    }

    const current = fs.readFileSync(backup.targetPath, 'utf8');
    if (current !== backup.appliedText) {
      vscode.window.showWarningMessage(
        'The generated file changed after AI Apply, so rollback was blocked.'
      );
      return false;
    }

    await vscode.workspace.fs.delete(vscode.Uri.file(backup.targetPath));
    lastAiApplyBackup = null;
    vscode.window.showInformationMessage('Last Galaxy AI-created file was removed.');
    if (dashboardRenderCallback) await dashboardRenderCallback();
    return true;
  }

  if (backup.kind === 'edited-file') {
    const uri = vscode.Uri.parse(backup.sourceUri);
    const document = await vscode.workspace.openTextDocument(uri);
    if (document.getText() !== backup.appliedText) {
      vscode.window.showWarningMessage(
        'The file changed after AI Apply, so rollback was blocked.'
      );
      return false;
    }

    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
      new vscode.Position(0, 0),
      document.positionAt(document.getText().length)
    );
    edit.replace(uri, fullRange, backup.originalText);
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) return false;

    if (backup.saved) {
      await document.save();
    }

    lastAiApplyBackup = null;
    vscode.window.showInformationMessage('Last Galaxy AI Apply was reverted.');
    if (dashboardRenderCallback) await dashboardRenderCallback();
    return true;
  }

  return false;
}

async function smartCommitGate(context, extensionUri) {
  const root = ensureQualityGateWorkspace(extensionUri);
  if (!root) return false;

  const staged = runGit(root, ['diff', '--cached', '--no-ext-diff', '--unified=3']);
  if (!staged) {
    vscode.window.showInformationMessage('Stage changes before using Smart Commit Gate.');
    return false;
  }

  const currentFingerprint = getQualityGateFingerprint(root);
  const fresh =
    qualityGateState.lastRunAt &&
    Date.now() - qualityGateState.lastRunAt < 15 * 60 * 1000 &&
    qualityGateState.status === 'READY' &&
    qualityGateState.fingerprint === currentFingerprint;

  if (!fresh) {
    const ready = await runQualityGate(context, extensionUri);
    if (!ready) {
      vscode.window.showWarningMessage('Quality Gate is not READY. Commit was blocked.');
      return false;
    }

    if (qualityGateState.fingerprint !== getQualityGateFingerprint(root)) {
      vscode.window.showWarningMessage(
        'Staged changes changed during verification. Run Smart Commit again.'
      );
      return false;
    }
  }

  const ai = await requestGalaxyModel(
    [
      'Generate one concise conventional commit message for this staged diff.',
      'Return only the commit message, with an optional short body after a blank line.',
      '',
      truncatePromptText(staged, 12000)
    ].join('\n'),
    'Act as a precise Git commit-message writer. Do not include Markdown fences.'
  );

  if (!ai.ok || !ai.text.trim()) {
    vscode.window.showWarningMessage(ai.error || 'Unable to generate a commit message.');
    return false;
  }

  const message = await vscode.window.showInputBox({
    title: 'Smart Commit Gate',
    prompt: 'Review or edit the AI-generated commit message',
    value: ai.text.trim().slice(0, 4000)
  });
  if (!message?.trim()) return false;

  const confirm = await vscode.window.showInformationMessage(
    'Quality Gate is READY. Create this commit now?',
    { modal: true },
    'Commit'
  );
  if (confirm !== 'Commit') return false;

  return runGitLocal(
    root,
    ['commit', '-m', message.trim()],
    'Smart Commit created after Quality Gate.'
  ) !== null;
}

function renderQualityChecks(checks) {
  if (!checks.length) {
    return '<p class="muted">No test/lint/typecheck/build scripts were available for the latest gate.</p>';
  }

  return checks.map((item) =>
    '<div class="quality-check ' + (item.passed ? 'pass' : 'fail') + '">' +
      '<span>' + (item.passed ? 'PASS' : 'FAIL') + '</span>' +
      '<strong>' + escapeHtml(item.kind) + '</strong>' +
      '<small>' + escapeHtml(item.script) + '</small>' +
    '</div>'
  ).join('');
}

function renderRecurringErrors(items) {
  if (!items.length) {
    return '<p class="muted">No recurring errors recorded yet.</p>';
  }

  return items.map((item) => {
    const detail = [item.source, item.code].filter(Boolean).join(' · ') || 'Diagnostic signature';
    return '<div class="history-row"><div><strong>' + escapeHtml(item.file) +
      '</strong><small>' + escapeHtml(detail) +
      ' · message not stored</small></div><span>×' + Number(item.count || 0) + '</span></div>';
  }).join('');
}

class GalaxyAiPreviewProvider {
  provideTextDocumentContent(uri) {
    return aiPreviewDocuments.get(uri.toString()) || '';
  }
}

function extractJsonObject(value) {
  const raw = String(value || '').trim();
  const fenced = raw.match(/\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('AI response did not contain a JSON object.');
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

function mergeLineRanges(ranges) {
  const sorted = ranges
    .map(([start, end]) => [Math.max(0, start), Math.max(0, end)])
    .filter(([start, end]) => end >= start)
    .sort((a, b) => a[0] - b[0]);

  const merged = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (!last || range[0] > last[1] + 1) {
      merged.push([...range]);
    } else {
      last[1] = Math.max(last[1], range[1]);
    }
  }
  return merged;
}

function buildDiagnosticEditContext(document, targetLine) {
  const maxLine = Math.max(0, document.lineCount - 1);
  const ranges = document.getText().length <= 9000
    ? [[0, maxLine]]
    : mergeLineRanges([
        [0, Math.min(29, maxLine)],
        [Math.max(0, targetLine - 10), Math.min(maxLine, targetLine + 10)]
      ]);

  const chunks = [];
  for (const [start, end] of ranges) {
    for (let line = start; line <= end; line++) {
      chunks.push(String(line + 1).padStart(4, ' ') + ' | ' + document.lineAt(line).text);
    }
  }

  return {
    ranges,
    text: chunks.join('\n').slice(0, 14000)
  };
}

function lineInsideRanges(line, ranges) {
  return ranges.some(([start, end]) => line >= start && line <= end);
}

function normalizeAiTextEdits(document, rawEdits, allowedRanges) {
  if (!Array.isArray(rawEdits)) return [];
  const edits = [];

  for (const item of rawEdits.slice(0, 20)) {
    const startLine = Number(item.startLine) - 1;
    const startCharacter = Number(item.startCharacter || 0);
    const endLine = Number(item.endLine) - 1;
    const endCharacter = Number(item.endCharacter || 0);
    const newText = String(item.newText ?? '');

    if (
      !Number.isInteger(startLine) ||
      !Number.isInteger(endLine) ||
      !Number.isInteger(startCharacter) ||
      !Number.isInteger(endCharacter) ||
      startLine < 0 ||
      endLine < startLine ||
      endLine >= document.lineCount ||
      startCharacter < 0 ||
      endCharacter < 0
    ) {
      continue;
    }

    if (
      allowedRanges?.length &&
      (!lineInsideRanges(startLine, allowedRanges) || !lineInsideRanges(endLine, allowedRanges))
    ) {
      continue;
    }

    const startLineText = document.lineAt(startLine).text;
    const endLineText = document.lineAt(endLine).text;
    if (startCharacter > startLineText.length || endCharacter > endLineText.length) {
      continue;
    }

    const range = new vscode.Range(
      new vscode.Position(startLine, startCharacter),
      new vscode.Position(endLine, endCharacter)
    );

    edits.push({
      range,
      startOffset: document.offsetAt(range.start),
      endOffset: document.offsetAt(range.end),
      newText
    });
  }

  edits.sort((a, b) => a.startOffset - b.startOffset);
  for (let index = 1; index < edits.length; index++) {
    if (edits[index].startOffset < edits[index - 1].endOffset) {
      throw new Error('AI proposed overlapping edits, so the proposal was rejected.');
    }
  }

  return edits;
}

function applyEditsToText(originalText, edits) {
  let output = originalText;
  for (const edit of [...edits].sort((a, b) => b.startOffset - a.startOffset)) {
    output =
      output.slice(0, edit.startOffset) +
      edit.newText +
      output.slice(edit.endOffset);
  }
  return output;
}

function clearAiEditProposal() {
  aiPreviewDocuments.clear();
  aiEditState = {
    running: false,
    kind: '',
    sourceUri: '',
    targetPath: '',
    originalText: '',
    proposedText: '',
    summary: '',
    confidence: '',
    verification: [],
    model: '',
    error: '',
    proposalId: ''
  };
}

function getAiEditState() {
  return {
    running: aiEditState.running,
    kind: aiEditState.kind,
    sourceUri: aiEditState.sourceUri,
    targetPath: aiEditState.targetPath,
    summary: aiEditState.summary,
    confidence: aiEditState.confidence,
    verification: aiEditState.verification,
    model: aiEditState.model,
    error: aiEditState.error,
    proposalId: aiEditState.proposalId,
    hasProposal: Boolean(aiEditState.proposalId && aiEditState.proposedText)
  };
}

async function saveAiEditProposal({
  kind,
  sourceUri = '',
  targetPath = '',
  originalText = '',
  proposedText = '',
  summary = '',
  confidence = '',
  verification = [],
  model = ''
}) {
  const proposalId = String(Date.now());
  aiEditState = {
    running: false,
    kind,
    sourceUri,
    targetPath,
    originalText,
    proposedText,
    summary,
    confidence,
    verification: Array.isArray(verification) ? verification.slice(0, 8) : [],
    model,
    error: '',
    proposalId
  };

  aiPreviewDocuments.clear();
  const previewName = path.basename(targetPath || sourceUri || 'preview.txt');
  const originalUri = vscode.Uri.parse(
    'galaxy-ai-preview:/original/' + proposalId + '/' + encodeURIComponent(previewName)
  );
  const proposedUri = vscode.Uri.parse(
    'galaxy-ai-preview:/proposed/' + proposalId + '/' + encodeURIComponent(previewName)
  );
  aiPreviewDocuments.set(originalUri.toString(), originalText);
  aiPreviewDocuments.set(proposedUri.toString(), proposedText);

  if (dashboardRenderCallback) await dashboardRenderCallback();
  return { originalUri, proposedUri };
}

async function generateDiagnosticFixProposal() {
  const diagnostics = collectDebugDiagnostics();
  const target =
    diagnostics.find((item) => item.severity === 'Error') ||
    diagnostics[0];

  if (!target) {
    vscode.window.showInformationMessage('No current error or warning is available to fix.');
    return false;
  }

  let document;
  try {
    document = await vscode.workspace.openTextDocument(vscode.Uri.parse(target.uri));
  } catch {
    vscode.window.showErrorMessage('Unable to open the diagnostic file.');
    return false;
  }

  const targetLine = Math.max(0, target.line - 1);
  const context = buildDiagnosticEditContext(document, targetLine);
  aiEditState.running = true;
  aiEditState.kind = 'diagnostic-fix';
  aiEditState.error = '';
  if (dashboardRenderCallback) await dashboardRenderCallback();

  const prompt = [
    'Create a minimal safe code fix for this VS Code diagnostic.',
    'Return ONLY JSON with this exact shape:',
    '{"summary":"...","confidence":"high|medium|low","verification":["..."],"edits":[{"startLine":1,"startCharacter":0,"endLine":1,"endCharacter":0,"newText":"..."}]}',
    'Line numbers are 1-based and characters are 0-based.',
    'Edit ranges use VS Code semantics: start is inclusive and end is exclusive.',
    'For a whole-line replacement, endLine/endCharacter must point just after the final replaced character.',
    'Only edit lines included in the supplied numbered context.',
    'If the fix requires code outside the supplied context or you are not confident, return an empty edits array and explain why in summary.',
    '',
    'File: ' + target.file,
    'Language: ' + document.languageId,
    'Diagnostic: ' + target.message,
    'Location: line ' + target.line + ', column ' + target.character,
    '',
    'Numbered context:',
    context.text
  ].join('\n');

  const ai = await requestGalaxyModel(
    prompt,
    'Act as a precise code repair tool. Preserve unrelated behavior and return valid JSON only.'
  );

  try {
    if (!ai.ok) throw new Error(ai.error || 'No AI model response.');
    const parsed = extractJsonObject(ai.text);
    const edits = normalizeAiTextEdits(document, parsed.edits, context.ranges);
    if (!edits.length) {
      throw new Error(parsed.summary || 'AI did not return a safe editable fix.');
    }

    const originalText = document.getText();
    const proposedText = applyEditsToText(originalText, edits);
    await saveAiEditProposal({
      kind: 'diagnostic-fix',
      sourceUri: document.uri.toString(),
      targetPath: document.uri.fsPath,
      originalText,
      proposedText,
      summary: String(parsed.summary || 'Diagnostic fix proposal'),
      confidence: String(parsed.confidence || ''),
      verification: parsed.verification,
      model: ai.model
    });
    return true;
  } catch (error) {
    aiEditState.running = false;
    aiEditState.error = error?.message || 'Unable to create a safe fix proposal.';
    if (dashboardRenderCallback) await dashboardRenderCallback();
    vscode.window.showWarningMessage('Galaxy AI Fix: ' + aiEditState.error);
    return false;
  }
}

async function refactorSelectedCodeProposal() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    vscode.window.showInformationMessage('Select code first, then choose Refactor Selection.');
    return false;
  }

  const document = editor.document;
  const selection = editor.selection;
  const selectedText = document.getText(selection);
  aiEditState.running = true;
  aiEditState.kind = 'refactor-selection';
  aiEditState.error = '';
  if (dashboardRenderCallback) await dashboardRenderCallback();

  const prompt = [
    'Refactor the selected ' + document.languageId + ' code for clarity and maintainability without changing intended behavior.',
    'Return ONLY JSON: {"summary":"...","confidence":"high|medium|low","verification":["..."],"replacement":"..."}',
    'Do not wrap replacement in Markdown fences.',
    '',
    selectedText.slice(0, 12000)
  ].join('\n');

  const ai = await requestGalaxyModel(
    prompt,
    'Act as a conservative refactoring assistant. Preserve behavior and return valid JSON only.'
  );

  try {
    if (!ai.ok) throw new Error(ai.error || 'No AI model response.');
    const parsed = extractJsonObject(ai.text);
    const replacement = String(parsed.replacement ?? '');
    if (!replacement) throw new Error('AI returned an empty replacement.');

    const originalText = document.getText();
    const startOffset = document.offsetAt(selection.start);
    const endOffset = document.offsetAt(selection.end);
    const proposedText =
      originalText.slice(0, startOffset) +
      replacement +
      originalText.slice(endOffset);

    await saveAiEditProposal({
      kind: 'refactor-selection',
      sourceUri: document.uri.toString(),
      targetPath: document.uri.fsPath,
      originalText,
      proposedText,
      summary: String(parsed.summary || 'Refactor proposal'),
      confidence: String(parsed.confidence || ''),
      verification: parsed.verification,
      model: ai.model
    });
    return true;
  } catch (error) {
    aiEditState.running = false;
    aiEditState.error = error?.message || 'Unable to create refactor proposal.';
    if (dashboardRenderCallback) await dashboardRenderCallback();
    vscode.window.showWarningMessage('Galaxy AI Refactor: ' + aiEditState.error);
    return false;
  }
}

function detectTestFramework(extensionUri) {
  const root = getWorkspaceRoot(extensionUri);
  if (!root) return 'unknown';
  const packageJson = readJsonIfExists(path.join(root, 'package.json')) || {};
  const deps = {
    ...(packageJson.dependencies || {}),
    ...(packageJson.devDependencies || {})
  };
  if (deps.vitest) return 'Vitest';
  if (deps.jest) return 'Jest';
  if (deps['@playwright/test']) return 'Playwright';
  if (deps.mocha) return 'Mocha';
  if (deps.jasmine) return 'Jasmine';
  return packageJson.scripts?.test ? 'project test script' : 'unknown';
}

async function generateTestsProposal(extensionUri) {
  const editor = vscode.window.activeTextEditor;
  const root = getWorkspaceRoot(extensionUri);
  if (!editor || editor.document.uri.scheme !== 'file' || !root) {
    vscode.window.showInformationMessage('Open a project source file first.');
    return false;
  }

  const document = editor.document;
  const relativeSource = path.relative(root, document.uri.fsPath);
  if (!relativeSource || relativeSource.startsWith('..')) {
    vscode.window.showWarningMessage('Active file is outside the current workspace.');
    return false;
  }

  aiEditState.running = true;
  aiEditState.kind = 'generate-tests';
  aiEditState.error = '';
  if (dashboardRenderCallback) await dashboardRenderCallback();

  const framework = detectTestFramework(extensionUri);
  const prompt = [
    'Generate focused tests for this source file.',
    'Detected test framework: ' + framework,
    'Source path: ' + relativeSource,
    'Language: ' + document.languageId,
    'Return ONLY JSON: {"summary":"...","confidence":"high|medium|low","verification":["..."],"relativePath":"path/to/test-file","content":"..."}',
    'Use a workspace-relative path. Do not use .. or an absolute path.',
    'Prefer the detected framework. If framework is unknown, state assumptions in summary.',
    '',
    truncatePromptText(document.getText(), 14000)
  ].join('\n');

  const ai = await requestGalaxyModel(
    prompt,
    'Act as a practical test engineer. Generate deterministic tests and return valid JSON only.'
  );

  try {
    if (!ai.ok) throw new Error(ai.error || 'No AI model response.');
    const parsed = extractJsonObject(ai.text);
    const relativePath = String(parsed.relativePath || '').replace(/\\/g, '/').trim();
    const content = String(parsed.content || '');
    if (!relativePath || !content) throw new Error('AI did not return a test file proposal.');
    if (path.isAbsolute(relativePath) || relativePath.split('/').includes('..')) {
      throw new Error('AI proposed an unsafe test file path.');
    }

    const targetPath = path.resolve(root, relativePath);
    if (!targetPath.startsWith(path.resolve(root) + path.sep)) {
      throw new Error('AI proposed a path outside the workspace.');
    }
    if (fs.existsSync(targetPath)) {
      throw new Error('Proposed test file already exists. Refusing to overwrite it.');
    }

    await saveAiEditProposal({
      kind: 'generate-tests',
      sourceUri: document.uri.toString(),
      targetPath,
      originalText: '',
      proposedText: content,
      summary: String(parsed.summary || 'Generated test proposal'),
      confidence: String(parsed.confidence || ''),
      verification: parsed.verification,
      model: ai.model
    });
    return true;
  } catch (error) {
    aiEditState.running = false;
    aiEditState.error = error?.message || 'Unable to create test proposal.';
    if (dashboardRenderCallback) await dashboardRenderCallback();
    vscode.window.showWarningMessage('Galaxy AI Tests: ' + aiEditState.error);
    return false;
  }
}

async function reviewAiEditProposal() {
  if (!aiEditState.proposalId || !aiEditState.proposedText) {
    vscode.window.showInformationMessage('Generate an AI edit proposal first.');
    return false;
  }

  const proposalId = aiEditState.proposalId;
  const originalUri = [...aiPreviewDocuments.keys()]
    .map((value) => vscode.Uri.parse(value))
    .find((uri) => uri.path.includes('/original/' + proposalId));
  const proposedUri = [...aiPreviewDocuments.keys()]
    .map((value) => vscode.Uri.parse(value))
    .find((uri) => uri.path.includes('/proposed/' + proposalId));

  if (!originalUri || !proposedUri) return false;

  const label = aiEditState.kind === 'generate-tests'
    ? 'New Test File Preview'
    : 'Galaxy AI Fix · Review Before Apply';

  await vscode.commands.executeCommand('vscode.diff', originalUri, proposedUri, label);
  return true;
}

async function applyAiEditProposal(context, extensionUri) {
  if (!aiEditState.proposalId || !aiEditState.proposedText) {
    vscode.window.showInformationMessage('No AI edit proposal is ready.');
    return false;
  }

  const beforeErrors = collectDebugDiagnostics()
    .filter((item) => item.severity === 'Error').length;

  const choice = await vscode.window.showWarningMessage(
    'Apply this reviewed Galaxy AI proposal?',
    { modal: true },
    'Apply & Verify',
    'Apply Only'
  );
  if (!choice) return false;

  const shouldVerify = choice === 'Apply & Verify';

  if (aiEditState.kind === 'generate-tests') {
    if (fs.existsSync(aiEditState.targetPath)) {
      vscode.window.showWarningMessage('Target test file now exists. Proposal was not applied.');
      return false;
    }

    const targetUri = vscode.Uri.file(aiEditState.targetPath);
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(aiEditState.targetPath)));
    await vscode.workspace.fs.writeFile(
      targetUri,
      Buffer.from(aiEditState.proposedText, 'utf8')
    );

    lastAiApplyBackup = {
      kind: 'created-file',
      workspaceRoot: getWorkspaceRoot(extensionUri),
      targetPath: aiEditState.targetPath,
      appliedText: aiEditState.proposedText,
      saved: true,
      appliedAt: Date.now()
    };

    const document = await vscode.workspace.openTextDocument(targetUri);
    await vscode.window.showTextDocument(document, { preview: false });
    vscode.window.showInformationMessage('Galaxy AI test file created.');

    clearAiEditProposal();
    if (dashboardRenderCallback) await dashboardRenderCallback();

    if (shouldVerify) {
      return runQualityGate(context, extensionUri, { beforeErrors });
    }
    return true;
  }

  if (!aiEditState.sourceUri) return false;

  const uri = vscode.Uri.parse(aiEditState.sourceUri);
  const document = await vscode.workspace.openTextDocument(uri);
  if (document.getText() !== aiEditState.originalText) {
    vscode.window.showWarningMessage(
      'The source file changed after the AI proposal was generated. Regenerate the proposal before applying.'
    );
    return false;
  }

  const originalText = document.getText();
  const proposedText = aiEditState.proposedText;

  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(
    new vscode.Position(0, 0),
    document.positionAt(originalText.length)
  );
  edit.replace(uri, fullRange, proposedText);

  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    vscode.window.showErrorMessage('VS Code could not apply the AI proposal.');
    return false;
  }

  let saved = false;
  if (shouldVerify) {
    saved = await document.save();
    if (!saved) {
      vscode.window.showWarningMessage(
        'AI proposal was applied, but the file could not be saved. Full verification was skipped.'
      );
    }
  }

  lastAiApplyBackup = {
    kind: 'edited-file',
    workspaceRoot: getWorkspaceRoot(extensionUri),
    sourceUri: uri.toString(),
    originalText,
    appliedText: proposedText,
    saved,
    appliedAt: Date.now()
  };

  await vscode.window.showTextDocument(document, { preview: false });
  vscode.window.showInformationMessage(
    shouldVerify && saved
      ? 'Galaxy AI proposal applied and saved. Verification is starting.'
      : 'Galaxy AI proposal applied as editor changes.'
  );

  clearAiEditProposal();
  if (dashboardRenderCallback) await dashboardRenderCallback();

  if (shouldVerify && saved) {
    return runQualityGate(context, extensionUri, { beforeErrors });
  }
  return true;
}

async function discardAiEditProposal() {
  clearAiEditProposal();
  if (dashboardRenderCallback) await dashboardRenderCallback();
  return true;
}

async function requestGalaxyModel(prompt, systemInstruction = '') {
  const models =
    vscode.lm && typeof vscode.lm.selectChatModels === 'function'
      ? await vscode.lm.selectChatModels()
      : [];

  if (!models.length) {
    return {
      ok: false,
      text: '',
      model: 'No model',
      error: 'No VS Code language model is currently available.'
    };
  }

  const model = models[0];
  const messages = [];
  if (systemInstruction) {
    messages.push(vscode.LanguageModelChatMessage.User(systemInstruction));
  }
  messages.push(vscode.LanguageModelChatMessage.User(prompt));

  const cts = new vscode.CancellationTokenSource();
  let responseText = '';

  try {
    const response = await model.sendRequest(messages, {}, cts.token);
    for await (const fragment of response.text) {
      responseText += fragment;
      if (responseText.length >= 16000) break;
    }

    return {
      ok: true,
      text: responseText.trim(),
      model: model.name || model.family || model.id || 'VS Code Language Model',
      error: ''
    };
  } catch (error) {
    return {
      ok: false,
      text: '',
      model: '',
      error: error?.message || 'Language model request failed.'
    };
  } finally {
    cts.dispose();
  }
}

function getSmartTaskScripts(extensionUri) {
  const root = getWorkspaceRoot(extensionUri);
  if (!root) {
    return {
      packageManager: '',
      scripts: {},
      available: []
    };
  }

  const packageJson = readJsonIfExists(path.join(root, 'package.json'));
  const scripts = packageJson?.scripts || {};
  const packageManager =
    fs.existsSync(path.join(root, 'pnpm-lock.yaml')) ? 'pnpm' :
    fs.existsSync(path.join(root, 'yarn.lock')) ? 'yarn' :
    'npm';

  const preferred = [
    ['test', ['test', 'test:unit', 'test:ci']],
    ['build', ['build']],
    ['lint', ['lint']],
    ['typecheck', ['typecheck', 'type-check', 'check:types']]
  ];

  const available = preferred
    .map(([kind, names]) => {
      const script = names.find((name) => typeof scripts[name] === 'string');
      return script ? { kind, script, command: scripts[script] } : null;
    })
    .filter(Boolean);

  return { packageManager, scripts, available };
}

function normalizeTaskOutput(stdout, stderr) {
  const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
  if (!combined) return '[no output]';
  return combined.length > 22000 ? combined.slice(-22000) : combined;
}

async function analyzeSmartTaskOutput(kind, script, output, exitCode) {
  const prompt = [
    'Analyze this developer task result.',
    'Task type: ' + kind,
    'Script: ' + script,
    'Exit code: ' + exitCode,
    '',
    'Output:',
    truncatePromptText(output, 14000),
    '',
    'Return concise sections: What failed, Likely cause, Exact next steps, and Verification.',
    'If the task passed, summarize meaningful warnings or risks instead of inventing a failure.'
  ].join('\n');

  return requestGalaxyModel(
    prompt,
    'Act as a precise senior software engineer. Base every claim on the supplied command output. Do not invent files or dependencies.'
  );
}

async function runSmartProjectTask(context, extensionUri, kind) {
  const root = getWorkspaceRoot(extensionUri);
  if (!root) {
    vscode.window.showWarningMessage('Open a workspace folder first.');
    return false;
  }

  const taskState = getSmartTaskScripts(extensionUri);
  const chosen = taskState.available.find((item) => item.kind === kind);

  if (!chosen) {
    vscode.window.showInformationMessage('No matching ' + kind + ' script was found in package.json.');
    return false;
  }

  const executable =
    taskState.packageManager === 'pnpm'
      ? (process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
      : taskState.packageManager === 'yarn'
        ? (process.platform === 'win32' ? 'yarn.cmd' : 'yarn')
        : (process.platform === 'win32' ? 'npm.cmd' : 'npm');

  const args =
    taskState.packageManager === 'yarn'
      ? [chosen.script]
      : ['run', chosen.script];

  smartAssistantState = {
    running: true,
    task: kind,
    command: taskState.packageManager + ' ' + args.join(' '),
    exitCode: null,
    output: '',
    analysis: '',
    model: '',
    lastError: '',
    startedAt: Date.now(),
    finishedAt: 0
  };
  if (dashboardRenderCallback) await dashboardRenderCallback();

  const result = await runCapturedProcess(executable, args, root);
  const output = normalizeTaskOutput(result.stdout, result.stderr);

  smartAssistantState.running = false;
  smartAssistantState.exitCode = result.exitCode;
  smartAssistantState.output = output;
  smartAssistantState.finishedAt = Date.now();

  if (result.exitCode !== 0 || /\b(error|failed|failure)\b/i.test(output)) {
    const choice = await vscode.window.showWarningMessage(
      'Galaxy captured a failed task result locally. Send the bounded captured output to your configured VS Code language model for analysis?',
      'Analyze with AI',
      'Keep Local'
    );

    if (choice === 'Analyze with AI') {
      const ai = await analyzeSmartTaskOutput(kind, chosen.script, output, result.exitCode);
      smartAssistantState.analysis = ai.text;
      smartAssistantState.model = ai.model;
      smartAssistantState.lastError = ai.error;
    }
  }

  if (dashboardRenderCallback) await dashboardRenderCallback();

  vscode.window.showInformationMessage(
    'Galaxy ' + kind + ' finished with exit code ' + result.exitCode + '.'
  );
  return result.exitCode === 0;
}


async function explainCurrentFileAi() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') {
    vscode.window.showInformationMessage('Open a source file first.');
    return false;
  }

  const document = editor.document;
  smartAssistantState = {
    running: true,
    task: 'explain-file',
    command: path.basename(document.fileName),
    exitCode: null,
    output: '',
    analysis: '',
    model: '',
    lastError: '',
    startedAt: Date.now(),
    finishedAt: 0
  };
  if (dashboardRenderCallback) await dashboardRenderCallback();

  const ai = await requestGalaxyModel(
    [
      'Explain this source file for a developer who needs to maintain it.',
      'Cover: purpose, main flow, important functions/classes, dependencies visible in the file, risky areas, and practical improvement ideas.',
      'Do not invent project context outside the supplied source.',
      '',
      'File: ' + path.basename(document.fileName),
      'Language: ' + document.languageId,
      '',
      truncatePromptText(document.getText(), 14000)
    ].join('\n'),
    'Act as a concise senior engineer performing a source-file walkthrough.'
  );

  smartAssistantState.running = false;
  smartAssistantState.analysis = ai.text;
  smartAssistantState.model = ai.model;
  smartAssistantState.lastError = ai.error;
  smartAssistantState.finishedAt = Date.now();

  if (dashboardRenderCallback) await dashboardRenderCallback();
  return ai.ok;
}

async function analyzeClipboardError() {
  const clipboard = (await vscode.env.clipboard.readText()).trim();
  if (!clipboard) {
    vscode.window.showInformationMessage('Clipboard is empty. Copy an error or stack trace first.');
    return false;
  }

  smartAssistantState = {
    running: true,
    task: 'clipboard-error',
    command: 'Clipboard Error',
    exitCode: null,
    output: clipboard.slice(0, 22000),
    analysis: '',
    model: '',
    lastError: '',
    startedAt: Date.now(),
    finishedAt: 0
  };
  if (dashboardRenderCallback) await dashboardRenderCallback();

  const prompt = [
    'Analyze this runtime/build/test error copied from a developer terminal or log.',
    'Identify the root cause if supported by the text, then give the smallest practical fix and verification steps.',
    'Call out uncertainty clearly.',
    '',
    truncatePromptText(clipboard, 14000)
  ].join('\n');

  const ai = await requestGalaxyModel(
    prompt,
    'Act as a debugging assistant. Do not assume project details that are absent from the pasted error.'
  );

  smartAssistantState.running = false;
  smartAssistantState.analysis = ai.text;
  smartAssistantState.model = ai.model;
  smartAssistantState.lastError = ai.error;
  smartAssistantState.finishedAt = Date.now();

  if (dashboardRenderCallback) await dashboardRenderCallback();
  return ai.ok;
}

async function analyzeFirstGitConflict(extensionUri) {
  const root = getWorkspaceRoot(extensionUri);
  if (!root) return false;

  const conflicts = runGit(root, ['diff', '--name-only', '--diff-filter=U'])
    .split(/\r?\n/)
    .filter(Boolean);

  if (!conflicts.length) {
    vscode.window.showInformationMessage('No unresolved Git conflicts were found.');
    return false;
  }

  const selected = await vscode.window.showQuickPick(conflicts, {
    title: 'AI Conflict Assistant',
    placeHolder: 'Choose a conflicted file'
  });
  if (!selected) return false;

  let content = '';
  try {
    content = fs.readFileSync(path.join(root, selected), 'utf8');
  } catch {
    vscode.window.showErrorMessage('Unable to read the conflicted file.');
    return false;
  }

  smartAssistantState = {
    running: true,
    task: 'git-conflict',
    command: selected,
    exitCode: null,
    output: content.slice(0, 22000),
    analysis: '',
    model: '',
    lastError: '',
    startedAt: Date.now(),
    finishedAt: 0
  };
  if (dashboardRenderCallback) await dashboardRenderCallback();

  const prompt = [
    'Analyze this Git merge conflict.',
    'File: ' + selected,
    '',
    truncatePromptText(content, 14000),
    '',
    'Explain what each side is trying to do, identify a safe merged intent, and propose a merged code block only if the evidence is sufficient.',
    'Do not claim the merge is correct when project context is missing.'
  ].join('\n');

  const ai = await requestGalaxyModel(
    prompt,
    'Act as a careful merge-conflict reviewer. Preserve behavior from both sides when compatible and explicitly describe uncertainty.'
  );

  smartAssistantState.running = false;
  smartAssistantState.analysis = ai.text;
  smartAssistantState.model = ai.model;
  smartAssistantState.lastError = ai.error;
  smartAssistantState.finishedAt = Date.now();

  if (dashboardRenderCallback) await dashboardRenderCallback();
  return ai.ok;
}

async function reviewStagedChangesWithAi(extensionUri) {
  const root = getWorkspaceRoot(extensionUri);
  if (!root) return false;

  const diff = runGit(root, ['diff', '--cached', '--no-ext-diff', '--unified=3']);
  if (!diff) {
    vscode.window.showInformationMessage('Stage changes first, then run AI Commit Review.');
    return false;
  }

  smartAssistantState = {
    running: true,
    task: 'commit-review',
    command: 'git diff --cached',
    exitCode: null,
    output: diff.slice(0, 22000),
    analysis: '',
    model: '',
    lastError: '',
    startedAt: Date.now(),
    finishedAt: 0
  };
  if (dashboardRenderCallback) await dashboardRenderCallback();

  const prompt = [
    'Review these staged Git changes before commit.',
    'Look for correctness risks, regressions, missing edge cases, security mistakes, and missing tests.',
    'Then recommend whether to Commit, Review, or Block.',
    '',
    truncatePromptText(diff, 14000)
  ].join('\n');

  const ai = await requestGalaxyModel(
    prompt,
    'Act as a strict but practical code reviewer. Only discuss risks visible in the provided diff.'
  );

  smartAssistantState.running = false;
  smartAssistantState.analysis = ai.text;
  smartAssistantState.model = ai.model;
  smartAssistantState.lastError = ai.error;
  smartAssistantState.finishedAt = Date.now();

  if (dashboardRenderCallback) await dashboardRenderCallback();
  return ai.ok;
}

async function copySmartAssistantResult() {
  const text = smartAssistantState.analysis || smartAssistantState.output;
  if (!text) {
    vscode.window.showInformationMessage('No Smart Developer Assistant result is available yet.');
    return false;
  }
  await vscode.env.clipboard.writeText(text);
  vscode.window.showInformationMessage('Smart Developer Assistant result copied.');
  return true;
}

function getSmartAssistantState(extensionUri) {
  const output = String(smartAssistantState.output || '');
  return {
    ...smartAssistantState,
    outputPreview: output.length > 7000 ? '…\n' + output.slice(-7000) : output,
    tasks: getSmartTaskScripts(extensionUri).available
  };
}

function renderSmartTaskButtons(tasks) {
  const labels = {
    test: 'Run Tests',
    build: 'Run Build',
    lint: 'Run Lint',
    typecheck: 'Run Typecheck'
  };

  if (!tasks.length) {
    return '<span class="muted">No standard test/build/lint/typecheck scripts detected.</span>';
  }

  return tasks.map((task) =>
    '<button data-smart-task="' + escapeHtml(task.kind) + '"><span>▶</span>' +
    escapeHtml(labels[task.kind] || task.kind) + '</button>'
  ).join('');
}

function getAiHudState() {
  const context = getBestEditorContext();
  const diagnostics = context.uri
    ? vscode.languages.getDiagnostics(vscode.Uri.parse(context.uri))
    : [];

  return {
    file: context.fileName ? path.basename(context.fileName) : 'No active editor',
    selectionLength: context.selectedText.length,
    diagnostics: diagnostics.length,
    lastPrompt: lastAiPrompt,
    lastPromptKind: lastAiPromptKind
  };
}


function collectDebugDiagnostics() {
  const root = getWorkspaceRoot();
  if (!root) return [];

  const activeUri = vscode.window.activeTextEditor?.document?.uri?.toString() || '';
  const items = [];

  for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
    if (uri.scheme !== 'file') continue;
    if (!uri.fsPath.startsWith(root)) continue;

    for (const diagnostic of diagnostics) {
      if (
        diagnostic.severity !== vscode.DiagnosticSeverity.Error &&
        diagnostic.severity !== vscode.DiagnosticSeverity.Warning
      ) {
        continue;
      }

      const code =
        typeof diagnostic.code === 'object'
          ? String(diagnostic.code?.value || '')
          : String(diagnostic.code || '');

      items.push({
        uri: uri.toString(),
        file: path.relative(root, uri.fsPath) || path.basename(uri.fsPath),
        line: diagnostic.range.start.line + 1,
        character: diagnostic.range.start.character + 1,
        endLine: diagnostic.range.end.line + 1,
        severity: diagnostic.severity === vscode.DiagnosticSeverity.Error ? 'Error' : 'Warning',
        message: diagnostic.message || '',
        source: diagnostic.source || '',
        code,
        active: uri.toString() === activeUri
      });
    }
  }

  return items
    .sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      if (a.severity !== b.severity) return a.severity === 'Error' ? -1 : 1;
      if (a.file !== b.file) return a.file.localeCompare(b.file);
      return a.line - b.line;
    })
    .slice(0, 20);
}

function diagnosticSignature(item) {
  if (!item) return '';
  return [item.uri, item.line, item.character, item.severity, item.message].join('|');
}

async function buildDiagnosticCodeContext(item) {
  if (!item?.uri) return '';
  try {
    const uri = vscode.Uri.parse(item.uri);
    const document = await vscode.workspace.openTextDocument(uri);
    const targetLine = Math.max(0, Number(item.line || 1) - 1);
    const start = Math.max(0, targetLine - 5);
    const end = Math.min(document.lineCount - 1, targetLine + 5);
    const lines = [];

    for (let index = start; index <= end; index++) {
      const marker = index === targetLine ? '>>' : '  ';
      lines.push(marker + ' ' + String(index + 1).padStart(4, ' ') + ' | ' + document.lineAt(index).text);
    }

    return lines.join('\n').slice(0, 7000);
  } catch {
    return '';
  }
}

function getDebugAssistantState(context) {
  const diagnostics = collectDebugDiagnostics();
  const errors = diagnostics.filter((item) => item.severity === 'Error').length;
  const warnings = diagnostics.filter((item) => item.severity === 'Warning').length;

  return {
    diagnostics,
    errors,
    warnings,
    autoAnalyze: Boolean(context?.globalState.get('galaxy.autoDebugAnalyze', false)),
    analyzing: debugAssistantState.analyzing,
    analysis: debugAssistantState.analysis,
    model: debugAssistantState.model,
    lastError: debugAssistantState.lastError
  };
}

async function analyzeLatestDiagnostic(context, options = {}) {
  const diagnostics = collectDebugDiagnostics();
  const target =
    diagnostics.find((item) => item.severity === 'Error') ||
    diagnostics[0];

  if (!target) {
    if (!options.silent) {
      vscode.window.showInformationMessage('Galaxy Debug: no current errors or warnings detected.');
    }
    return false;
  }

  const signature = diagnosticSignature(target);
  debugAssistantState.analyzing = true;
  debugAssistantState.lastError = '';
  if (dashboardRenderCallback) await dashboardRenderCallback();

  const codeContext = await buildDiagnosticCodeContext(target);
  const prompt = [
    'You are the Galaxy AI Debug Assistant inside VS Code.',
    'Analyze this diagnostic and give a concise practical solution.',
    'Return these sections: Cause, Fix, Example (only when useful), Verify.',
    'Do not invent files, APIs, or dependencies that are not shown.',
    '',
    'File: ' + target.file,
    'Location: line ' + target.line + ', column ' + target.character,
    'Severity: ' + target.severity,
    'Source: ' + (target.source || 'VS Code'),
    'Code: ' + (target.code || 'n/a'),
    'Diagnostic: ' + target.message,
    '',
    'Nearby code:',
    codeContext || '[code context unavailable]'
  ].join('\n');

  try {
    const models =
      vscode.lm && typeof vscode.lm.selectChatModels === 'function'
        ? await vscode.lm.selectChatModels()
        : [];

    if (!models.length) {
      debugAssistantState.analysis =
        'No VS Code language model is currently available. Open VS Code Chat or configure a compatible language model, then run Analyze Error again.\n\nDiagnostic:\n' +
        target.message;
      debugAssistantState.model = 'No model';
      debugAssistantState.lastSignature = signature;
      lastAiPrompt = prompt;
      lastAiPromptKind = 'debug';
      return false;
    }

    const model = models[0];
    const messages = [
      vscode.LanguageModelChatMessage.User(
        'Act as a careful debugging assistant. Prefer the smallest safe fix and explain uncertainty.'
      ),
      vscode.LanguageModelChatMessage.User(prompt)
    ];

    const cts = new vscode.CancellationTokenSource();
    let responseText = '';

    try {
      const response = await model.sendRequest(messages, {}, cts.token);
      for await (const fragment of response.text) {
        responseText += fragment;
        if (responseText.length >= 14000) break;
      }
    } finally {
      cts.dispose();
    }

    debugAssistantState.analysis =
      responseText.trim() || 'The model returned an empty debugging response.';
    debugAssistantState.model =
      model.name || model.family || model.id || 'VS Code Language Model';
    debugAssistantState.lastSignature = signature;
    debugAssistantState.lastError = '';
    lastAutoDebugAt = Date.now();
    return true;
  } catch (error) {
    debugAssistantState.analysis = '';
    debugAssistantState.model = '';
    debugAssistantState.lastSignature = signature;
    debugAssistantState.lastError =
      error?.message || 'AI debugging request failed.';
    if (!options.silent) {
      vscode.window.showErrorMessage('Galaxy AI Debug: ' + debugAssistantState.lastError);
    }
    return false;
  } finally {
    debugAssistantState.analyzing = false;
    if (dashboardRenderCallback) await dashboardRenderCallback();
  }
}

async function toggleAutoDebugAnalyze(context) {
  if (!context) return false;
  const current = Boolean(context.globalState.get('galaxy.autoDebugAnalyze', false));
  const next = !current;
  await context.globalState.update('galaxy.autoDebugAnalyze', next);

  if (next) {
    vscode.window.showInformationMessage(
      'Galaxy Auto Debug enabled. New diagnostics may send a small code snippet to your configured VS Code language model.'
    );
    await analyzeLatestDiagnostic(context, { silent: true });
  } else {
    if (autoDebugTimer) {
      clearTimeout(autoDebugTimer);
      autoDebugTimer = null;
    }
    vscode.window.showInformationMessage('Galaxy Auto Debug disabled.');
  }
  return true;
}

function scheduleAutoDebug(context) {
  if (!context?.globalState.get('galaxy.autoDebugAnalyze', false)) return;

  const diagnostics = collectDebugDiagnostics();
  const target =
    diagnostics.find((item) => item.severity === 'Error') ||
    diagnostics[0];
  if (!target) return;

  const signature = diagnosticSignature(target);
  if (signature === debugAssistantState.lastSignature) return;
  if (Date.now() - lastAutoDebugAt < 30000) return;

  if (autoDebugTimer) clearTimeout(autoDebugTimer);
  autoDebugTimer = setTimeout(async () => {
    autoDebugTimer = null;
    await analyzeLatestDiagnostic(context, { silent: true });
  }, 2500);
}

async function openDebugDiagnostic(index) {
  const diagnostics = collectDebugDiagnostics();
  const item = diagnostics[Number(index)];
  if (!item?.uri) return false;

  try {
    const uri = vscode.Uri.parse(item.uri);
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const line = Math.max(0, Number(item.line || 1) - 1);
    const character = Math.max(0, Number(item.character || 1) - 1);
    const position = new vscode.Position(line, character);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    return true;
  } catch {
    return false;
  }
}

async function openDebugQuickFix(index) {
  const opened = await openDebugDiagnostic(index);
  if (!opened) return false;
  await vscode.commands.executeCommand('editor.action.quickFix');
  return true;
}

async function copyDebugAnalysis() {
  if (!debugAssistantState.analysis) {
    vscode.window.showInformationMessage('Run Analyze Error first.');
    return false;
  }
  await vscode.env.clipboard.writeText(debugAssistantState.analysis);
  vscode.window.showInformationMessage('Galaxy AI debug analysis copied.');
  return true;
}

function renderDebugDiagnostics(items) {
  if (!items.length) {
    return '<p class="muted">No errors or warnings detected in the current workspace.</p>';
  }

  return items.slice(0, 8).map((item, index) =>
    '<div class="debug-row">' +
      '<button class="debug-main" data-debug-open="' + index + '">' +
        '<span class="' + (item.severity === 'Error' ? 'debug-error' : 'debug-warning') + '">' +
          escapeHtml(item.severity) +
        '</span>' +
        '<div><strong>' + escapeHtml(item.file) + ':' + item.line + '</strong>' +
        '<small>' + escapeHtml(item.message) + '</small></div>' +
      '</button>' +
      '<button data-debug-fix="' + index + '">Quick Fix</button>' +
    '</div>'
  ).join('');
}

function truncatePromptText(value, limit = 12000) {
  const text = String(value || '');
  return text.length > limit ? text.slice(0, limit) + '\n\n[truncated]' : text;
}

async function createAiPrompt(kind, extensionUri) {
  const editorContext = getBestEditorContext();
  const root = getWorkspaceRoot(extensionUri);

  if (kind === 'selection') {
    if (!editorContext.selectedText) {
      vscode.window.showWarningMessage('Select some code first, then use Explain Selection.');
      return '';
    }

    const selected = truncatePromptText(editorContext.selectedText);
    const language = editorContext.languageId || 'code';
    return `Explain this ${language} code clearly. Identify what it does, important logic, possible bugs, and practical improvements.\n\n${selected}`;
  }

  if (kind === 'diagnostics') {
    if (!editorContext.uri) {
      vscode.window.showWarningMessage('Open a file first, then use Diagnose Current File.');
      return '';
    }

    const uri = vscode.Uri.parse(editorContext.uri);
    const diagnostics = vscode.languages.getDiagnostics(uri).slice(0, 25);
    const details = diagnostics.length
      ? diagnostics.map((item) => `Line ${item.range.start.line + 1}: ${item.message}`).join('\n')
      : 'VS Code currently reports no diagnostics for this file.';

    return `Review the current file diagnostics and suggest precise fixes. File: ${path.basename(editorContext.fileName || uri.fsPath)}\nLanguage: ${editorContext.languageId || 'unknown'}\n\nDiagnostics:\n${details}`;
  }

  if (kind === 'commit') {
    if (!root) return '';

    const staged = runGit(root, ['diff', '--cached', '--no-ext-diff', '--unified=2']);
    const working = staged || runGit(root, ['diff', '--no-ext-diff', '--unified=2']);
    const status = runGit(root, ['status', '--short']);

    return `Generate a concise conventional Git commit message for these changes. Return a strong subject line and, only if useful, a short body.\n\nStatus:\n${status || 'No status output'}\n\nDiff:\n${truncatePromptText(working || 'No diff available.')}`;
  }

  return '';
}

async function copyAiPrompt(kind, extensionUri) {
  const prompt = await createAiPrompt(kind, extensionUri);
  if (!prompt) return false;

  lastAiPrompt = prompt;
  lastAiPromptKind = kind || 'prompt';

  await vscode.env.clipboard.writeText(prompt);
  vscode.window.showInformationMessage('Galaxy AI HUD prompt generated and copied.');
  return true;
}

async function copyLastAiPrompt() {
  if (!lastAiPrompt) {
    vscode.window.showInformationMessage('Generate an AI HUD prompt first.');
    return false;
  }

  await vscode.env.clipboard.writeText(lastAiPrompt);
  vscode.window.showInformationMessage('Galaxy AI HUD prompt copied again.');
  return true;
}

async function openAvailableChat() {
  const commands = await vscode.commands.getCommands(true);
  const candidates = [
    'workbench.action.chat.open',
    'workbench.action.quickchat.toggle'
  ];

  const command = candidates.find((candidate) => commands.includes(candidate));
  if (!command) {
    vscode.window.showInformationMessage('No compatible VS Code Chat command is available. Your AI HUD prompt is still ready to paste.');
    return false;
  }

  await vscode.commands.executeCommand(command);
  return true;
}

async function openGalaxyExtension(extensionId) {
  if (!extensionId) return;
  const url = `https://marketplace.visualstudio.com/items?itemName=${encodeURIComponent(extensionId)}`;
  await vscode.env.openExternal(vscode.Uri.parse(url));
}

async function searchGalaxyExtensions() {
  const commands = await vscode.commands.getCommands(true);
  if (commands.includes('workbench.extensions.search')) {
    await vscode.commands.executeCommand('workbench.extensions.search', '@publisher:gitwithmasum');
    return;
  }

  const url = 'https://marketplace.visualstudio.com/search?term=gitwithmasum&target=VSCode';
  await vscode.env.openExternal(vscode.Uri.parse(url));
}

function getProviderBridgeState() {
  const gitlabVersion = runVersionCommand('glab', ['--version']);
  const bitbucketVersion = runVersionCommand('twg', ['--version']);
  const state = {
    gitlabInstalled: gitlabVersion !== 'Not found',
    gitlabVersion,
    gitlabRepos: [],
    gitlabReady: false,
    bitbucketInstalled: bitbucketVersion !== 'Not found',
    bitbucketVersion
  };
  if (state.gitlabInstalled) {
    try {
      const raw = execFileSync('glab', ['repo', 'list', '--member', '-F', 'json', '-P', '8'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const records = raw ? JSON.parse(raw) : [];
      if (Array.isArray(records)) {
        state.gitlabReady = true;
        state.gitlabRepos = records.slice(0, 8).map((item) => ({
          name: item.path_with_namespace || item.name_with_namespace || item.full_name || item.name || '',
          url: item.web_url || item.webUrl || '',
          cloneUrl: item.http_url_to_repo || item.httpUrlToRepo || ''
        }));
      }
    } catch {
      state.gitlabReady = false;
    }
  }
  return state;
}

function renderGitLabCliRepos(state) {
  if (!state.gitlabInstalled) return '<p class="muted">GitLab CLI is not installed.</p>';
  if (!state.gitlabReady) return '<p class="muted">GitLab CLI is installed but not authenticated yet.</p>';
  if (!state.gitlabRepos.length) return '<p class="muted">No GitLab repositories returned.</p>';
  return state.gitlabRepos.map((repo) => '<div class="remote-repo-row"><div class="remote-repo-copy"><strong>' + escapeHtml(repo.name) + '</strong><small>GitLab CLI</small></div><button data-external-url="' + escapeHtml(repo.url) + '">Open</button><button data-provider-clone="' + escapeHtml(repo.cloneUrl) + '">Clone</button></div>').join('');
}

async function runProviderBridge(action) {
  const terminal = createWorkspaceTerminal('Galaxy Provider Bridge');
  terminal.show();
  const commands = {
    gitlabLogin: 'glab auth login',
    gitlabRepos: 'glab repo list --member -F json -P 20',
    bitbucketSetup: 'twg setup bitbucket',
    bitbucketRepos: 'twg bitbucket repo query'
  };
  if (!commands[action]) return false;
  terminal.sendText(commands[action], true);
  return true;
}

function widgetAttr(state, id) {
  return state.widgets?.hidden?.includes(id)
    ? ' data-widget="' + id + '" style="display:none"'
    : ' data-widget="' + id + '"';
}


function renderCpProblems(problems) {
  return (problems || []).map((item) => {
    const statusClass =
      item.status === 'AC' ? 'cp-ac' :
      ['WA', 'TLE', 'RE', 'CE'].includes(item.status) ? 'cp-fail' :
      item.status === 'SOLVING' ? 'cp-solving' : '';

    return '<button class="cp-problem ' + statusClass + (item.current ? ' active' : '') +
      '" data-cp-problem="' + escapeHtml(item.label) + '">' +
      '<span class="cp-letter">' + escapeHtml(item.label) + '</span>' +
      '<strong>' + escapeHtml(item.status) + '</strong>' +
      '<small>' + escapeHtml(item.activeText) +
      (item.attempts ? ' · ' + item.attempts + ' fail' + (item.attempts === 1 ? '' : 's') : '') +
      '</small></button>';
  }).join('');
}

function getCpAiState() {
  return { ...cpAiState };
}



function renderOrchestratorTasks(tasks) {
  if (!tasks?.length) return '<p class="muted">No package.json scripts detected.</p>';
  return tasks.slice(0, 16).map((task) =>
    '<button class="orchestrator-task" data-orchestrator-task="' + escapeHtml(task.name) + '">' +
      '<div><strong>' + escapeHtml(task.name) + '</strong><small>' +
      escapeHtml(task.kind) + ' · ' + escapeHtml(task.command) + '</small></div>' +
      '<span>Run</span>' +
    '</button>'
  ).join('');
}

function renderOrchestratorGraph(edges) {
  if (!edges?.length) return '<p class="muted">No script-to-script dependencies detected.</p>';
  return edges.slice(0, 16).map((edge) =>
    '<div class="orchestrator-edge"><strong>' + escapeHtml(edge.from) +
    '</strong><span>→</span><strong>' + escapeHtml(edge.to) +
    '</strong><small>' + escapeHtml(edge.reason || '') + '</small></div>'
  ).join('');
}

function renderSavedWorkflows(workflows) {
  if (!workflows?.length) return '<p class="muted">No saved workflows yet.</p>';
  return workflows.map((workflow) =>
    '<div class="orchestrator-workflow"><div><strong>' +
      escapeHtml(workflow.name) + '</strong><small>' +
      escapeHtml(workflow.mode) + ' · ' +
      escapeHtml((workflow.tasks || []).join(' → ')) +
      '</small></div><div class="launcher-actions">' +
      '<button data-run-workflow="' + escapeHtml(workflow.id) + '">Run</button>' +
      '<button data-delete-workflow="' + escapeHtml(workflow.id) + '">Delete</button>' +
      '</div></div>'
  ).join('');
}

function renderOrchestratorResults(results) {
  if (!results?.length) return '<p class="muted">No workflow run yet.</p>';
  return results.map((item) =>
    '<div class="history-row"><div><strong>' +
      escapeHtml(item.name) + ' · ' + (item.cancelled ? 'CANCELLED' : (item.passed ? 'PASS' : 'FAIL')) +
      '</strong><small>' + escapeHtml(item.kind || 'task') + ' · Exit ' +
      Number(item.exitCode ?? -1) + '</small></div><span>' +
      Math.round(Number(item.durationMs || 0) / 1000) + 's</span></div>'
  ).join('');
}

function renderOrchestratorHistory(history) {
  if (!history?.length) return '<p class="muted">No task-run history yet.</p>';
  return history.slice(0, 8).map((item) =>
    '<div class="history-row"><div><strong>' +
      escapeHtml(item.name) + ' · ' + (item.cancelled ? 'CANCELLED' : (item.passed ? 'PASS' : 'FAIL')) +
      '</strong><small>' + escapeHtml(new Date(Number(item.at || 0)).toLocaleString()) +
      ' · ' + escapeHtml(item.mode || 'sequential') + '</small></div><span>' +
      Math.round(Number(item.durationMs || 0) / 1000) + 's</span></div>'
  ).join('');
}

function analyticsDayLabel(value) {
  const text = String(value || '');
  return text.length >= 10 ? text.slice(5) : text;
}

function renderAnalyticsCodingBars(items) {
  if (!items?.length) return '<p class="muted">No coding history yet.</p>';
  return items.map((item) =>
    '<div class="analytics-bar-row">' +
      '<span>' + escapeHtml(analyticsDayLabel(item.day)) + '</span>' +
      '<div class="analytics-track"><i style="width:' + Math.max(0, Math.min(100, Number(item.percent || 0))) + '%"></i></div>' +
      '<strong>' + escapeHtml(item.text || '0m') + '</strong>' +
    '</div>'
  ).join('');
}

function renderAnalyticsGitBars(items) {
  if (!items?.length) return '<p class="muted">No Git activity yet.</p>';
  return items.map((item) =>
    '<div class="analytics-bar-row">' +
      '<span>' + escapeHtml(analyticsDayLabel(item.day)) + '</span>' +
      '<div class="analytics-track"><i style="width:' + Math.max(0, Math.min(100, Number(item.percent || 0))) + '%"></i></div>' +
      '<strong>' + Number(item.commits || 0) + '</strong>' +
    '</div>'
  ).join('');
}

function renderAnalyticsLanguages(items) {
  if (!items?.length) return '<p class="muted">No language-time data yet.</p>';
  return items.map((item) =>
    '<div class="analytics-language-row">' +
      '<div><strong>' + escapeHtml(item.name) + '</strong><small>' + escapeHtml(item.text) + '</small></div>' +
      '<div class="analytics-track"><i style="width:' + Math.max(0, Math.min(100, Number(item.percent || 0))) + '%"></i></div>' +
      '<span>' + Number(item.percent || 0) + '%</span>' +
    '</div>'
  ).join('');
}

function renderAnalyticsQualityHistory(items) {
  if (!items?.length) return '<p class="muted">Run Quality Gate to build history.</p>';
  return items.map((item) =>
    '<div class="history-row"><div><strong>' + escapeHtml(item.status) +
    ' · ' + Number(item.score || 0) + '/100</strong><small>' +
    escapeHtml(new Date(Number(item.at || 0)).toLocaleString()) +
    '</small></div><span>' + Number(item.checksPassed || 0) + '/' +
    Number(item.checksTotal || 0) + ' checks</span></div>'
  ).join('');
}

function renderAnalyticsHealthHistory(items) {
  if (!items?.length) return '<p class="muted">Project health history starts today.</p>';
  return items.map((item) =>
    '<div class="history-row"><div><strong>' + escapeHtml(item.day) +
    '</strong><small>' + Number(item.errors || 0) + ' errors · ' +
    Number(item.warnings || 0) + ' warnings</small></div><span>' +
    Number(item.score || 0) + '/100</span></div>'
  ).join('');
}

async function exportDeveloperAnalytics(context, extensionUri) {
  if (!context) return false;

  const health = await getProjectHealth(extensionUri);
  const cpState = getCpArenaState(context);
  await recordProjectHealthHistory(context, health);
  const analytics = getDeveloperAnalytics(context, { health, cpState });

  const root = getWorkspaceRoot(extensionUri);
  const defaultUri = root
    ? vscode.Uri.file(path.join(root, 'galaxy-developer-analytics-' + localDayKey() + '.json'))
    : undefined;

  const target = await vscode.window.showSaveDialog({
    title: 'Export Galaxy Developer Analytics',
    defaultUri,
    saveLabel: 'Export Analytics',
    filters: { 'JSON': ['json'] }
  });
  if (!target) return false;

  await vscode.workspace.fs.writeFile(
    target,
    Buffer.from(JSON.stringify(analytics, null, 2), 'utf8')
  );
  vscode.window.showInformationMessage('Galaxy developer analytics exported.');
  return true;
}



function taskWorkflowStorageKey() {
  return getWorkspaceRoot() || '__no_workspace__';
}

function getSavedTaskWorkflows(context) {
  if (!context) return [];
  const all = context.globalState.get('galaxy.taskWorkflows', {}) || {};
  const list = all[taskWorkflowStorageKey()];
  return Array.isArray(list) ? list : [];
}

function getTaskRunHistory(context) {
  if (!context) return [];
  const all = context.globalState.get('galaxy.taskRunHistory', {}) || {};
  const list = all[taskWorkflowStorageKey()];
  return Array.isArray(list) ? list : [];
}

async function recordTaskRunHistory(context, run) {
  if (!context || !run) return;
  const all = context.globalState.get('galaxy.taskRunHistory', {}) || {};
  const key = taskWorkflowStorageKey();
  const current = Array.isArray(all[key]) ? all[key] : [];

  const entry = {
    at: Date.now(),
    name: String(run.name || 'Task Run'),
    mode: String(run.mode || 'sequential'),
    passed: Boolean(run.passed),
    cancelled: Boolean(run.cancelled),
    durationMs: Number(run.durationMs || 0),
    tasks: Array.isArray(run.results)
      ? run.results.map((item) => ({
          name: String(item.name || ''),
          kind: String(item.kind || ''),
          passed: Boolean(item.passed),
          exitCode: Number(item.exitCode ?? -1),
          durationMs: Number(item.durationMs || 0)
        }))
      : []
  };

  all[key] = [entry, ...current].slice(0, 20);
  await context.globalState.update('galaxy.taskRunHistory', all);
}

function getTaskOrchestratorState(context) {
  const root = getWorkspaceRoot();
  const discovery = root
    ? discoverWorkspaceTasks(root)
    : {
        packageManager: '',
        packageName: '',
        tasks: [],
        edges: [],
        standard: {}
      };

  return {
    ...taskOrchestratorState,
    discovery,
    workflows: getSavedTaskWorkflows(context),
    history: getTaskRunHistory(context)
  };
}

async function executeTaskPlan(context, extensionUri, name, taskNames, options = {}) {
  if (taskOrchestratorState.running) {
    vscode.window.showInformationMessage('Galaxy Task Orchestrator is already running.');
    return false;
  }

  const root = getWorkspaceRoot(extensionUri);
  if (!root) {
    vscode.window.showInformationMessage('Open a workspace folder first.');
    return false;
  }

  const discovery = discoverWorkspaceTasks(root);
  const valid = Array.from(
    new Set((taskNames || []).filter((taskName) =>
      discovery.tasks.some((item) => item.name === taskName)
    ))
  );

  if (!valid.length) {
    vscode.window.showInformationMessage('No runnable package scripts were selected.');
    return false;
  }

  taskOrchestratorAbortController = new AbortController();

  taskOrchestratorState = {
    running: true,
    name: String(name || 'Task Run'),
    mode: options.mode === 'parallel' ? 'parallel' : 'sequential',
    requested: valid,
    results: [],
    passed: null,
    message: 'Running ' + valid.length + ' task(s)…',
    startedAt: Date.now(),
    finishedAt: 0,
    durationMs: 0
  };
  if (dashboardRenderCallback) await dashboardRenderCallback();

  const run = await runTaskPlan(
    root,
    discovery,
    valid,
    {
      mode: taskOrchestratorState.mode,
      stopOnFailure: options.stopOnFailure !== false,
      timeoutMs: Number(options.timeoutMs || 180000),
      signal: taskOrchestratorAbortController.signal
    }
  );

  taskOrchestratorAbortController = null;

  taskOrchestratorState = {
    running: false,
    name: String(name || 'Task Run'),
    mode: run.mode,
    requested: run.requested,
    results: run.results,
    passed: run.passed,
    cancelled: Boolean(run.cancelled),
    message: run.cancelled
      ? 'Workflow cancelled by user.'
      : run.passed
        ? 'All requested tasks passed.'
        : 'Workflow stopped or completed with a failure.',
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs
  };

  await recordTaskRunHistory(context, {
    ...taskOrchestratorState,
    results: run.results
  });

  if (dashboardRenderCallback) await dashboardRenderCallback();

  vscode.window.showInformationMessage(
    'Galaxy Tasks: ' +
    (run.cancelled ? 'CANCELLED' : (run.passed ? 'PASS' : 'FAILED')) +
    ' · ' +
    Math.round(run.durationMs / 1000) +
    's'
  );

  return run.passed;
}

async function cancelTaskOrchestrator() {
  if (!taskOrchestratorState.running || !taskOrchestratorAbortController) {
    vscode.window.showInformationMessage('No Galaxy task workflow is currently running.');
    return false;
  }

  taskOrchestratorAbortController.abort();
  vscode.window.setStatusBarMessage('Galaxy task cancellation requested…', 2200);
  return true;
}

async function runSingleWorkspaceTask(context, extensionUri, taskName) {
  return executeTaskPlan(
    context,
    extensionUri,
    taskName,
    [taskName],
    { mode: 'sequential', stopOnFailure: true }
  );
}

async function runVerifyPipeline(context, extensionUri) {
  const root = getWorkspaceRoot(extensionUri);
  if (!root) return false;
  const discovery = discoverWorkspaceTasks(root);
  const tasks = standardVerifyTasks(discovery);

  if (!tasks.length) {
    vscode.window.showInformationMessage(
      'No standard lint/typecheck/test/build scripts were detected.'
    );
    return false;
  }

  return executeTaskPlan(
    context,
    extensionUri,
    'Verify Pipeline',
    tasks,
    { mode: 'sequential', stopOnFailure: true }
  );
}

async function runShipPipeline(context, extensionUri) {
  const root = getWorkspaceRoot(extensionUri);
  if (!root) {
    vscode.window.showInformationMessage('Open a workspace folder first.');
    return false;
  }

  const discovery = discoverWorkspaceTasks(root);
  const tasks = shipTasks(discovery);

  if (tasks.length) {
    const passed = await executeTaskPlan(
      context,
      extensionUri,
      'Ship · Build + Test',
      tasks,
      { mode: 'sequential', stopOnFailure: true }
    );
    if (!passed) {
      vscode.window.showWarningMessage(
        'Galaxy Ship stopped because Build/Test did not pass.'
      );
      return false;
    }
  }

  const gatePassed = await runQualityGate(context, extensionUri);
  if (!gatePassed || qualityGateState.status !== 'READY') {
    vscode.window.showWarningMessage(
      'Galaxy Ship stopped because Quality Gate is not READY.'
    );
    return false;
  }

  return smartCommitGate(context, extensionUri);
}

async function createSavedTaskWorkflow(context) {
  const root = getWorkspaceRoot();
  if (!context || !root) {
    vscode.window.showInformationMessage('Open a workspace folder first.');
    return false;
  }

  const discovery = discoverWorkspaceTasks(root);
  if (!discovery.tasks.length) {
    vscode.window.showInformationMessage('No package.json scripts were found.');
    return false;
  }

  const selected = await vscode.window.showQuickPick(
    discovery.tasks.map((task) => ({
      label: task.name,
      description: task.kind + ' · ' + task.command,
      picked: false,
      taskName: task.name
    })),
    {
      canPickMany: true,
      title: 'Create Galaxy Workflow',
      placeHolder: 'Select scripts in the order you want to configure'
    }
  );
  if (!selected?.length) return false;

  const mode = await vscode.window.showQuickPick(
    [
      {
        label: 'Sequential',
        description: 'Run in order and stop on the first failure',
        value: 'sequential'
      },
      {
        label: 'Parallel',
        description: 'Run all selected tasks at the same time',
        value: 'parallel'
      }
    ],
    {
      title: 'Workflow Execution Mode'
    }
  );
  if (!mode) return false;

  const name = await vscode.window.showInputBox({
    title: 'Workflow Name',
    prompt: 'Give this workflow a short name',
    placeHolder: 'Pre-commit Verify',
    validateInput: (value) =>
      String(value || '').trim().length >= 2
        ? undefined
        : 'Enter at least 2 characters.'
  });
  if (!name?.trim()) return false;

  const all = context.globalState.get('galaxy.taskWorkflows', {}) || {};
  const key = taskWorkflowStorageKey();
  const current = Array.isArray(all[key]) ? all[key] : [];

  const workflow = {
    id: String(Date.now()),
    name: name.trim(),
    mode: mode.value,
    tasks: selected.map((item) => item.taskName).slice(0, 20),
    createdAt: Date.now()
  };

  all[key] = [
    workflow,
    ...current.filter((item) => item.name !== workflow.name)
  ].slice(0, 12);

  await context.globalState.update('galaxy.taskWorkflows', all);
  return true;
}

async function runSavedTaskWorkflow(context, extensionUri, workflowId) {
  const workflow = getSavedTaskWorkflows(context)
    .find((item) => item.id === workflowId);
  if (!workflow) {
    vscode.window.showInformationMessage('Saved workflow was not found.');
    return false;
  }

  return executeTaskPlan(
    context,
    extensionUri,
    workflow.name,
    workflow.tasks,
    {
      mode: workflow.mode,
      stopOnFailure: workflow.mode !== 'parallel'
    }
  );
}

async function deleteSavedTaskWorkflow(context, workflowId) {
  if (!context) return false;
  const workflows = getSavedTaskWorkflows(context);
  const workflow = workflows.find((item) => item.id === workflowId);
  if (!workflow) return false;

  const confirm = await vscode.window.showWarningMessage(
    'Delete workflow "' + workflow.name + '"?',
    { modal: true },
    'Delete'
  );
  if (confirm !== 'Delete') return false;

  const all = context.globalState.get('galaxy.taskWorkflows', {}) || {};
  all[taskWorkflowStorageKey()] = workflows.filter(
    (item) => item.id !== workflowId
  );
  await context.globalState.update('galaxy.taskWorkflows', all);
  return true;
}

function getArchitectureScan(force = false) {
  const root = getWorkspaceRoot();
  if (!root) {
    architectureCache = { root: '', at: Date.now(), scan: null };
    return null;
  }

  const fresh =
    !force &&
    architectureCache.scan &&
    architectureCache.root === root &&
    Date.now() - architectureCache.at < 90000;

  if (fresh) return architectureCache.scan;

  const scan = scanWorkspaceArchitecture(root, { maxFiles: 900 });
  architectureCache = {
    root,
    at: Date.now(),
    scan
  };
  return scan;
}

function getArchitectureDashboardState(force = false) {
  const scan = getArchitectureScan(force);
  return {
    scan: toArchitectureView(scan),
    search: { ...architectureSearchState }
  };
}

async function refreshArchitectureState() {
  getArchitectureScan(true);
  architectureSearchState = {
    query: '',
    results: [],
    analysis: '',
    model: '',
    error: '',
    running: false
  };
  return true;
}

async function findArchitectureFeature() {
  const scan = getArchitectureScan(false);
  if (!scan) {
    vscode.window.showInformationMessage('Open a workspace folder first.');
    return false;
  }

  const query = await vscode.window.showInputBox({
    title: 'Workspace Architecture · Find Feature',
    prompt: 'What feature, behavior, symbol, or concept are you looking for?',
    placeHolder: 'Example: quality gate history or GitHub publish flow'
  });
  if (!query?.trim()) return false;

  const results = searchArchitecture(scan, query.trim(), 12);
  architectureSearchState = {
    query: query.trim(),
    results,
    analysis: '',
    model: '',
    error: '',
    running: false
  };

  if (!results.length) {
    vscode.window.showInformationMessage('No strong local matches were found.');
  }
  return true;
}

async function explainArchitectureMatches() {
  const scan = getArchitectureScan(false);
  const state = architectureSearchState;
  if (!scan || !state.query || !state.results.length) {
    vscode.window.showInformationMessage('Run Find Feature first.');
    return false;
  }

  architectureSearchState = {
    ...state,
    running: true,
    analysis: '',
    error: ''
  };
  if (dashboardRenderCallback) await dashboardRenderCallback();

  const context = state.results.slice(0, 8).map((item, index) =>
    [
      'Match ' + (index + 1) + ': ' + item.file + ':' + item.line,
      item.snippet || '[filename match only]'
    ].join('\n')
  ).join('\n\n');

  const ai = await requestGalaxyModel(
    [
      'A developer asked: "' + state.query + '"',
      'Based only on these local workspace search matches, explain where the feature is most likely implemented.',
      'Rank the most relevant files, describe each file\'s likely role, and suggest the best file to open first.',
      'Do not invent files or code that are not present in the supplied matches.',
      '',
      context
    ].join('\n'),
    'Act as a repository navigation assistant. Ground every conclusion in the supplied local search evidence.'
  );

  architectureSearchState = {
    ...architectureSearchState,
    running: false,
    analysis: ai.text,
    model: ai.model,
    error: ai.error
  };

  if (dashboardRenderCallback) await dashboardRenderCallback();
  return ai.ok;
}

async function openArchitectureFile(value) {
  const scan = getArchitectureScan(false);
  if (!scan) return false;

  const relative = typeof value === 'string' ? value : String(value?.file || '');
  const line = Math.max(1, Number(value?.line || 1));
  const file = getArchitectureFile(scan, relative);
  if (!file) {
    vscode.window.showWarningMessage('Architecture file is no longer available. Refresh the scan.');
    return false;
  }

  const uri = vscode.Uri.file(file.absolute);
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  const position = new vscode.Position(
    Math.min(Math.max(0, line - 1), Math.max(0, document.lineCount - 1)),
    0
  );
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  return true;
}

async function exportArchitectureJson() {
  const scan = getArchitectureScan(false);
  if (!scan) {
    vscode.window.showInformationMessage('Open a workspace folder first.');
    return false;
  }

  const root = getWorkspaceRoot();
  const target = await vscode.window.showSaveDialog({
    title: 'Export Workspace Architecture',
    defaultUri: vscode.Uri.file(path.join(root, 'galaxy-workspace-architecture.json')),
    saveLabel: 'Export Architecture',
    filters: { 'JSON': ['json'] }
  });
  if (!target) return false;

  await vscode.workspace.fs.writeFile(
    target,
    Buffer.from(JSON.stringify(toArchitectureView(scan), null, 2), 'utf8')
  );
  vscode.window.showInformationMessage('Workspace architecture exported.');
  return true;
}


function renderArchitectureEntries(items, emptyText = 'No entry points detected.') {
  if (!items?.length) return '<p class="muted">' + escapeHtml(emptyText) + '</p>';
  return items.slice(0, 8).map((item) =>
    '<button class="architecture-row" data-architecture-file="' + escapeHtml(item.file) + '" data-architecture-line="1">' +
      '<div><strong>' + escapeHtml(item.file) + '</strong><small>' + escapeHtml(item.reason || '') + '</small></div>' +
      '<span>Open</span>' +
    '</button>'
  ).join('');
}

function renderArchitectureTopLevel(items) {
  if (!items?.length) return '<p class="muted">No structure data yet.</p>';
  return items.slice(0, 10).map((item) =>
    '<div class="architecture-metric-row"><div><strong>' + escapeHtml(item.name) +
    '</strong><small>' + Number(item.lines || 0) + ' lines</small></div><span>' +
    Number(item.files || 0) + ' files</span></div>'
  ).join('');
}

function renderArchitectureLanguages(items) {
  if (!items?.length) return '<p class="muted">No source languages detected.</p>';
  const total = items.reduce((sum, item) => sum + Number(item.count || 0), 0) || 1;
  return items.slice(0, 8).map((item) => {
    const percent = Math.round((Number(item.count || 0) / total) * 100);
    return '<div class="analytics-language-row"><div><strong>' + escapeHtml(item.name) +
      '</strong><small>' + Number(item.count || 0) + ' files</small></div>' +
      '<div class="analytics-track"><i style="width:' + percent + '%"></i></div><span>' +
      percent + '%</span></div>';
  }).join('');
}

function renderArchitectureCentral(items) {
  if (!items?.length) return '<p class="muted">No local module relationships detected.</p>';
  return items.slice(0, 8).map((item) =>
    '<button class="architecture-row" data-architecture-file="' + escapeHtml(item.file) + '" data-architecture-line="1">' +
      '<div><strong>' + escapeHtml(item.file) + '</strong><small>Inbound ' +
      Number(item.inbound || 0) + ' · Outbound ' + Number(item.outbound || 0) + '</small></div>' +
      '<span>Score ' + Number(item.score || 0) + '</span>' +
    '</button>'
  ).join('');
}

function renderArchitectureRisk(items) {
  if (!items?.length) return '<p class="muted">No obvious static risk hotspots detected.</p>';
  return items.slice(0, 8).map((item) =>
    '<button class="architecture-row" data-architecture-file="' + escapeHtml(item.file) + '" data-architecture-line="1">' +
      '<div><strong>' + escapeHtml(item.file) + '</strong><small>' +
      Number(item.lines || 0) + ' lines · ' + Number(item.todoCount || 0) + ' TODO/FIXME</small></div>' +
      '<span>Risk ' + Number(item.riskScore || 0) + '</span>' +
    '</button>'
  ).join('');
}

function renderArchitectureLarge(items) {
  if (!items?.length) return '<p class="muted">No source files detected.</p>';
  return items.slice(0, 8).map((item) =>
    '<button class="architecture-row" data-architecture-file="' + escapeHtml(item.file) + '" data-architecture-line="1">' +
      '<div><strong>' + escapeHtml(item.file) + '</strong><small>' +
      Math.round(Number(item.size || 0) / 1024) + ' KB</small></div><span>' +
      Number(item.lines || 0) + ' lines</span></button>'
  ).join('');
}


function renderArchitectureRelations(items) {
  if (!items?.length) return '<p class="muted">No local dependency edges detected.</p>';
  return items.slice(0, 12).map((item) =>
    '<div class="architecture-metric-row"><div><strong>' +
    escapeHtml(item.from) + '</strong><small>imports / includes</small></div><span>→ ' +
    escapeHtml(item.to) + '</span></div>'
  ).join('');
}

function renderArchitectureCycles(items) {
  if (!items?.length) return '<p class="muted">No local dependency cycles detected.</p>';
  return items.slice(0, 5).map((cycle) =>
    '<div class="architecture-cycle">' + cycle.map((item) => escapeHtml(item)).join(' → ') + '</div>'
  ).join('');
}

function renderArchitectureSearch(items) {
  if (!items?.length) return '<p class="muted">Run Find Feature to search the workspace.</p>';
  return items.slice(0, 10).map((item) =>
    '<button class="architecture-search-row" data-architecture-file="' + escapeHtml(item.file) +
    '" data-architecture-line="' + Number(item.line || 1) + '">' +
      '<div><strong>' + escapeHtml(item.file) + ':' + Number(item.line || 1) +
      '</strong><small>' + escapeHtml(item.snippet || 'Filename match') + '</small></div>' +
      '<span>' + Number(item.score || 0) + '</span>' +
    '</button>'
  ).join('');
}

async function getWorkspaceState(extensionUri, version = 'dev', context) {
  const [git, project, health, recentFiles, devServer, github] = await Promise.all([
    getGitState(extensionUri),
    detectProject(extensionUri),
    getProjectHealth(extensionUri),
    getRecentFiles(),
    getDevServerStatus(),
    getGitHubState()
  ]);
  const githubCollaboration = await getGitHubCollaborationState(git);
  const environment = getEnvironmentStatus();
  const cpArena = context ? getCpArenaState(context) : null;

  if (context) {
    await recordProjectHealthHistory(context, health);
  }

  const developerAnalytics = context
    ? getDeveloperAnalytics(context, { health, cpState: cpArena })
    : null;
  const architecture = getArchitectureDashboardState(false);

  let workspaceName = 'No workspace open';
  if (vscode.workspace.workspaceFolders?.[0]?.name) {
    workspaceName = vscode.workspace.workspaceFolders[0].name;
  }

  return {
    workspaceName,
    version,
    repoPath: getWorkspaceRoot(extensionUri),
    project,
    health,
    environment,
    devServer,
    github,
    githubCollaboration,
    providerBridge: getProviderBridgeState(),
    advancedRepo: getAdvancedRepoState(extensionUri),
    smartAssistant: getSmartAssistantState(extensionUri),
    aiEdit: getAiEditState(),
    qualityGate: getQualityGateState(context, extensionUri),
    developerAnalytics,
    architecture,
    taskOrchestrator: context ? getTaskOrchestratorState(context) : null,
    cpArena,
    cpAi: getCpAiState(),
    recentFiles,
    ai: getAiHudState(),
    debugAssistant: context ? getDebugAssistantState(context) : null,
    projectNote: context ? getProjectNote(context, extensionUri) : '',
    session: getSessionStats(),
    codingHistory: context ? getCodingHistoryState(context) : null,
    focusTimer: context ? getFocusTimerState(context) : null,
    snapshots: context ? getWorkspaceSnapshots(context, extensionUri) : [],
    galaxyExtensions: getGalaxyExtensions(),
    widgets: context ? getWidgetState(context) : { hidden: [] },
    mode: context ? getDeveloperModeState(context) : { active: 'Default' },
    themes: getInstalledThemes(),
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
  const activeMode = escapeHtml(state.mode.active || 'Default');
  const currentTheme = escapeHtml(state.themes.currentTheme || 'Default');
  const provider = escapeHtml(state.provider || 'Local only');
  const originUrl = escapeHtml(state.originUrl || 'No origin configured');
  const githubAccount = escapeHtml(state.github?.account || '');
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
  .smart-dev-actions{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
  .smart-dev-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:12px}
  .smart-dev-box{padding:12px;border:1px solid rgba(0,247,255,.11);border-radius:12px;background:rgba(0,247,255,.018)}
  .smart-dev-box span{display:block;color:var(--muted);font-size:9px;letter-spacing:.11em;margin-bottom:6px}
  .smart-dev-box strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .smart-dev-output{margin-top:12px;padding:14px;border:1px solid rgba(139,92,255,.16);border-radius:12px;background:rgba(0,0,0,.22);white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto;font-family:Consolas,'Courier New',monospace;font-size:11px;line-height:1.5}
  .smart-dev-analysis{margin-top:12px;padding:14px;border:1px solid rgba(0,247,255,.14);border-radius:12px;background:rgba(0,247,255,.018);white-space:pre-wrap;word-break:break-word;max-height:380px;overflow:auto;line-height:1.55}
  .ai-fix-actions{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
  .ai-fix-meta{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:12px}
  .ai-fix-box{padding:12px;border:1px solid rgba(255,79,216,.15);border-radius:12px;background:rgba(255,79,216,.025)}
  .ai-fix-box span{display:block;color:var(--muted);font-size:9px;letter-spacing:.11em;margin-bottom:6px}
  .ai-fix-box strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ai-fix-summary{padding:14px;border:1px solid rgba(0,247,255,.12);border-radius:12px;background:rgba(0,247,255,.018);line-height:1.55}
  .ai-fix-verify{margin:10px 0 0;padding-left:18px;color:var(--muted)}
  .ai-fix-verify li{margin:5px 0}
  .quality-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:14px}
  .quality-actions{display:flex;gap:8px;flex-wrap:wrap}
  .quality-summary{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin-bottom:12px}
  .quality-box{padding:12px;border:1px solid rgba(0,247,255,.12);border-radius:12px;background:rgba(0,247,255,.018)}
  .quality-box span{display:block;color:var(--muted);font-size:9px;letter-spacing:.11em;margin-bottom:6px}
  .quality-box strong{font-size:16px}
  .quality-status-ready{color:#64ffb4}
  .quality-status-review{color:#ffcc66}
  .quality-status-blocked{color:#ff6b8a}
  .quality-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
  .quality-panel{padding:12px;border:1px solid rgba(139,92,255,.14);border-radius:12px;background:rgba(139,92,255,.022)}
  .quality-checks{display:grid;gap:7px}
  .quality-check{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:8px;align-items:center;padding:8px;border:1px solid rgba(0,247,255,.08);border-radius:9px}
  .quality-check.pass span{color:#64ffb4}
  .quality-check.fail span{color:#ff6b8a}
  .quality-check small{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .coverage-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
  .coverage-grid div{padding:9px;border:1px solid rgba(0,247,255,.08);border-radius:9px}
  .coverage-grid span{display:block;color:var(--muted);font-size:9px;margin-bottom:4px}
  .analytics-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:14px}
  .analytics-summary{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;margin-bottom:12px}
  .analytics-stat{padding:12px;border:1px solid rgba(0,247,255,.12);border-radius:12px;background:rgba(0,247,255,.018)}
  .analytics-stat span{display:block;color:var(--muted);font-size:9px;letter-spacing:.11em;margin-bottom:6px}
  .analytics-stat strong{font-size:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}
  .analytics-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
  .analytics-panel{padding:12px;border:1px solid rgba(139,92,255,.14);border-radius:12px;background:rgba(139,92,255,.022)}
  .analytics-bar-row{display:grid;grid-template-columns:52px minmax(0,1fr) 68px;gap:9px;align-items:center;margin:8px 0}
  .analytics-bar-row>span{color:var(--muted);font-size:10px}
  .analytics-bar-row>strong{text-align:right;font-size:11px}
  .analytics-track{height:8px;border-radius:999px;background:rgba(0,247,255,.07);overflow:hidden}
  .analytics-track i{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,var(--cyan),var(--purple));box-shadow:0 0 12px rgba(0,247,255,.18)}
  .analytics-language-row{display:grid;grid-template-columns:110px minmax(0,1fr) 42px;gap:9px;align-items:center;margin:9px 0}
  .analytics-language-row>div:first-child{display:flex;flex-direction:column;min-width:0}
  .analytics-language-row strong,.analytics-language-row small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .analytics-language-row small{color:var(--muted);margin-top:2px}
  .analytics-language-row>span{text-align:right;color:var(--muted)}
  .analytics-intel{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;margin-bottom:10px}
  .analytics-intel div{padding:10px;border:1px solid rgba(0,247,255,.09);border-radius:10px}
  .analytics-intel span{display:block;color:var(--muted);font-size:9px;margin-bottom:5px}
  .architecture-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:14px}
  .architecture-actions{display:flex;gap:8px;flex-wrap:wrap}
  .architecture-summary{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;margin-bottom:12px}
  .architecture-stat{padding:12px;border:1px solid rgba(0,247,255,.12);border-radius:12px;background:rgba(0,247,255,.018)}
  .architecture-stat span{display:block;color:var(--muted);font-size:9px;letter-spacing:.11em;margin-bottom:6px}
  .architecture-stat strong{display:block;font-size:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .architecture-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
  .architecture-panel{padding:12px;border:1px solid rgba(139,92,255,.14);border-radius:12px;background:rgba(139,92,255,.022)}
  .architecture-row,.architecture-search-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;width:100%;text-align:left;margin-top:7px}
  .architecture-row>div,.architecture-search-row>div{display:flex;flex-direction:column;min-width:0}
  .architecture-row strong,.architecture-row small,.architecture-search-row strong,.architecture-search-row small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .architecture-row small,.architecture-search-row small{color:var(--muted);margin-top:3px}
  .architecture-search-row small{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
  .architecture-metric-row{display:flex;justify-content:space-between;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid rgba(0,247,255,.07)}
  .architecture-metric-row>div{display:flex;flex-direction:column}
  .architecture-metric-row small{color:var(--muted);margin-top:3px}
  .architecture-cycle{padding:9px;margin-top:7px;border:1px solid rgba(255,204,102,.18);border-radius:9px;color:#ffcc66;word-break:break-word}
  .architecture-ai{margin-top:12px;padding:14px;border:1px solid rgba(255,79,216,.16);border-radius:12px;background:rgba(255,79,216,.02);white-space:pre-wrap;line-height:1.55;max-height:340px;overflow:auto}
  .orchestrator-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:14px}
  .orchestrator-actions{display:flex;gap:8px;flex-wrap:wrap}
  .orchestrator-summary{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin-bottom:12px}
  .orchestrator-stat{padding:12px;border:1px solid rgba(0,247,255,.12);border-radius:12px;background:rgba(0,247,255,.018)}
  .orchestrator-stat span{display:block;color:var(--muted);font-size:9px;letter-spacing:.11em;margin-bottom:6px}
  .orchestrator-stat strong{font-size:16px}
  .orchestrator-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
  .orchestrator-panel{padding:12px;border:1px solid rgba(139,92,255,.14);border-radius:12px;background:rgba(139,92,255,.022)}
  .orchestrator-task,.orchestrator-workflow{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:9px;align-items:center;width:100%;text-align:left;margin-top:7px}
  .orchestrator-task>div,.orchestrator-workflow>div:first-child{display:flex;flex-direction:column;min-width:0}
  .orchestrator-task strong,.orchestrator-task small,.orchestrator-workflow strong,.orchestrator-workflow small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .orchestrator-task small,.orchestrator-workflow small{color:var(--muted);margin-top:3px}
  .orchestrator-edge{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid rgba(0,247,255,.07)}
  .orchestrator-edge small{grid-column:1/-1;color:var(--muted)}
  .orchestrator-output{margin-top:10px;padding:12px;border:1px solid rgba(0,247,255,.1);border-radius:10px;background:rgba(0,0,0,.2);max-height:220px;overflow:auto;white-space:pre-wrap;font-family:Consolas,'Courier New',monospace;font-size:11px}
  .cp-arena-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:14px}
  .cp-actions{display:flex;gap:8px;flex-wrap:wrap}
  .cp-summary{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin-bottom:12px}
  .cp-stat{padding:12px;border:1px solid rgba(0,247,255,.12);border-radius:12px;background:rgba(0,247,255,.018)}
  .cp-stat span{display:block;color:var(--muted);font-size:9px;letter-spacing:.11em;margin-bottom:6px}
  .cp-stat strong{font-size:16px}
  .cp-clock{font-family:Consolas,'Courier New',monospace;color:var(--cyan);letter-spacing:.05em}
  .cp-problems{display:grid;grid-template-columns:repeat(8,minmax(0,1fr));gap:8px;margin-bottom:12px}
  .cp-problem{display:flex;flex-direction:column;gap:4px;text-align:left;min-width:0}
  .cp-problem.active{border-color:var(--cyan);background:rgba(0,247,255,.08);box-shadow:0 0 18px rgba(0,247,255,.1)}
  .cp-problem.cp-ac{border-color:rgba(100,255,180,.45)}
  .cp-problem.cp-fail{border-color:rgba(255,107,138,.42)}
  .cp-problem.cp-solving{border-color:rgba(255,204,102,.42)}
  .cp-letter{font-size:18px;font-weight:800;color:var(--cyan)}
  .cp-problem small{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .cp-status-actions{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 14px}
  .cp-runner{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:12px}
  .cp-run-panel{padding:12px;border:1px solid rgba(139,92,255,.15);border-radius:12px;background:rgba(139,92,255,.02)}
  .cp-run-panel textarea{width:100%;min-height:150px;resize:vertical;background:rgba(0,0,0,.28);color:var(--text);border:1px solid rgba(0,247,255,.13);border-radius:10px;padding:10px;font-family:Consolas,'Courier New',monospace;line-height:1.45}
  .cp-result{margin-top:12px;padding:12px;border:1px solid rgba(0,247,255,.12);border-radius:12px;background:rgba(0,0,0,.2)}
  .cp-output{white-space:pre-wrap;word-break:break-word;max-height:240px;overflow:auto;font-family:Consolas,'Courier New',monospace;font-size:11px;line-height:1.5}
  .cp-tools{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
  .cp-platforms{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
  .cp-ai-result{margin-top:12px;padding:14px;border:1px solid rgba(255,79,216,.16);border-radius:12px;background:rgba(255,79,216,.02);white-space:pre-wrap;line-height:1.55;max-height:360px;overflow:auto}
  .git-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:12px}
  .git-box{padding:13px;border:1px solid rgba(139,92,255,.18);border-radius:12px;background:rgba(139,92,255,.035)}
  .git-box span{display:block;color:var(--muted);font-size:9px;letter-spacing:.11em;margin-bottom:6px}
  .git-box strong{font-size:15px}
  .git-actions{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px;margin-top:12px}
  .repo-meta{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:12px}
  .repo-meta-box{padding:13px;border:1px solid rgba(0,247,255,.12);border-radius:12px;background:rgba(0,247,255,.018);min-width:0}
  .repo-meta-box span{display:block;color:var(--muted);font-size:9px;letter-spacing:.11em;margin-bottom:6px}
  .repo-meta-box strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .repo-tool-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px;margin-top:10px}
  .github-panel{margin-top:14px;padding:14px;border:1px solid rgba(181,108,255,.18);border-radius:14px;background:rgba(181,108,255,.035)}
  .github-head{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:10px}
  .remote-repo-list{display:grid;gap:8px}
  .remote-repo-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:8px;align-items:center;padding:10px;border:1px solid rgba(0,247,255,.1);border-radius:11px;background:rgba(0,247,255,.015)}
  .remote-repo-copy{display:flex;flex-direction:column;min-width:0}
  .remote-repo-copy strong,.remote-repo-copy small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .remote-repo-copy small{color:var(--muted);margin-top:3px}
  .collab-actions{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}
  .collab-columns{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
  .collab-group{padding:11px;border:1px solid rgba(0,247,255,.1);border-radius:12px;background:rgba(0,247,255,.014)}
  .collab-row{display:flex;width:100%;gap:8px;align-items:center;margin-top:7px}
  .collab-row span{min-width:62px;color:var(--cyan)}
  .collab-row strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .provider-bridge{margin-top:14px;padding:14px;border:1px solid rgba(139,92,255,.16);border-radius:14px;background:rgba(139,92,255,.025)}
  .provider-bridge-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
  .provider-box{padding:12px;border:1px solid rgba(0,247,255,.1);border-radius:12px;background:rgba(0,247,255,.014)}
  .provider-box-head{display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:10px}
  .advanced-repo{margin-top:14px;padding:14px;border:1px solid rgba(0,247,255,.14);border-radius:14px;background:rgba(0,247,255,.018)}
  .advanced-repo-head{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:12px}
  .advanced-repo-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
  .advanced-box{padding:12px;border:1px solid rgba(139,92,255,.14);border-radius:12px;background:rgba(139,92,255,.022)}
  .advanced-box-head{display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:9px}
  .repo-file-row{display:flex;width:100%;gap:8px;align-items:center;margin-top:7px}
  .repo-file-row span{min-width:30px;color:var(--cyan)}
  .repo-file-row strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .repo-file-row.conflict{border-color:rgba(255,79,216,.35)}
  .branch-clean-row{display:flex;justify-content:space-between;gap:8px;align-items:center;margin-top:8px;padding:8px;border:1px solid rgba(0,247,255,.08);border-radius:9px}
  .action-run-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center}
  .commit-line{margin-top:11px;padding:10px 12px;border:1px solid rgba(0,247,255,.1);border-radius:10px;color:var(--muted);font-size:11px}
  .command-columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
  .command-group{border:1px solid rgba(0,247,255,.11);border-radius:14px;padding:12px;background:rgba(0,247,255,.018)}
  .command-head{display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:8px}
  .command-row{display:flex;gap:8px;margin-top:8px}
  .command-main{display:flex;align-items:center;gap:8px;flex:1;min-width:0}
  .command-main code{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)}
  .command-pin{width:44px;text-align:center;color:#ffcc66}
  .mode-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
  .mode-btn.active{border-color:var(--cyan);box-shadow:0 0 24px rgba(0,247,255,.12);background:rgba(0,247,255,.08)}
  .mode-btn strong{display:block;margin-bottom:4px}
  .mode-btn small{color:var(--muted)}
  .focus-bar{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-top:12px;padding:13px;border:1px solid rgba(139,92,255,.18);border-radius:12px;background:rgba(139,92,255,.035)}
  .theme-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
  .theme-tile{display:flex;align-items:center;gap:8px;min-width:0}
  .theme-tile strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .theme-tile.active{border-color:var(--cyan);background:rgba(0,247,255,.08);box-shadow:0 0 22px rgba(0,247,255,.12)}
  .theme-meta{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:12px}
  .top-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
  .top-actions button{padding:9px 11px}
  .ai-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
  .ai-stat{padding:13px;border:1px solid rgba(255,79,216,.18);border-radius:12px;background:rgba(255,79,216,.035)}
  .ai-stat span{display:block;color:var(--muted);font-size:9px;letter-spacing:.11em;margin-bottom:6px}
  .ai-stat strong{font-size:14px}
  .ai-actions{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px;margin-top:12px}
  .ai-preview{margin-top:12px;padding:14px;border:1px solid rgba(255,79,216,.18);border-radius:12px;background:rgba(0,0,0,.22);max-height:280px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-family:Consolas,'Courier New',monospace;font-size:12px;line-height:1.55;color:var(--text)}
  .ai-preview-head{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-top:14px}
  .ai-preview-head strong{color:var(--magenta)}
  .hub-list{display:grid;gap:9px}
  .hub-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px;border:1px solid rgba(0,247,255,.11);border-radius:12px;background:rgba(0,247,255,.018)}
  .hub-copy{display:flex;flex-direction:column;min-width:0}
  .hub-copy strong,.hub-copy small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .hub-copy small{color:var(--muted);margin-top:4px}
  .hub-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
  .note-box{padding:14px;border:1px solid rgba(0,247,255,.12);border-radius:12px;background:rgba(0,247,255,.018);white-space:pre-wrap;line-height:1.55}
  .session-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
  .session-box{padding:14px;border:1px solid rgba(139,92,255,.18);border-radius:12px;background:rgba(139,92,255,.035)}
  .session-box span{display:block;color:var(--muted);font-size:9px;letter-spacing:.11em;margin-bottom:6px}
  .session-box strong{font-size:18px}
  .focus-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:14px}
  .goal-progress{height:9px;border-radius:999px;background:rgba(0,247,255,.08);overflow:hidden;margin:10px 0 14px}
  .goal-progress span{display:block;height:100%;background:linear-gradient(90deg,var(--cyan),var(--purple));box-shadow:0 0 16px rgba(0,247,255,.25)}
  .focus-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
  .focus-stat{padding:12px;border:1px solid rgba(0,247,255,.12);border-radius:12px;background:rgba(0,247,255,.018)}
  .focus-stat span{display:block;color:var(--muted);font-size:9px;letter-spacing:.11em;margin-bottom:6px}
  .focus-stat strong{font-size:17px}
  .focus-timer{display:flex;justify-content:space-between;gap:14px;align-items:center;margin:14px 0;padding:14px;border:1px solid rgba(139,92,255,.18);border-radius:14px;background:rgba(139,92,255,.035)}
  .focus-clock{font-family:Consolas,'Courier New',monospace;font-size:28px;letter-spacing:.06em;color:var(--cyan)}
  .focus-controls{display:flex;gap:8px;flex-wrap:wrap}
  .language-pills{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 14px}
  .language-pill{padding:7px 9px;border:1px solid rgba(0,247,255,.12);border-radius:999px;color:var(--muted);font-size:10px}
  .focus-history-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
  .history-panel{padding:12px;border:1px solid rgba(0,247,255,.1);border-radius:12px;background:rgba(0,247,255,.014)}
  .history-row,.history-day{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:8px 0;border-bottom:1px solid rgba(0,247,255,.07)}
  .history-row:last-child,.history-day:last-child{border-bottom:0}
  .history-row>div{display:flex;flex-direction:column;min-width:0}
  .history-row strong,.history-row small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .history-row small,.history-day span{color:var(--muted);margin-top:3px}
  .debug-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:12px}
  .debug-stat{padding:12px;border:1px solid rgba(255,79,216,.16);border-radius:12px;background:rgba(255,79,216,.025)}
  .debug-stat span{display:block;color:var(--muted);font-size:9px;letter-spacing:.11em;margin-bottom:6px}
  .debug-actions{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
  .debug-list{display:grid;gap:8px}
  .debug-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center}
  .debug-main{display:flex;gap:10px;align-items:flex-start;min-width:0}
  .debug-main>div{display:flex;flex-direction:column;min-width:0}
  .debug-main strong,.debug-main small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .debug-main small{color:var(--muted);margin-top:4px}
  .debug-error{color:#ff6b8a}
  .debug-warning{color:#ffcc66}
  .debug-analysis{margin-top:12px;padding:14px;border:1px solid rgba(0,247,255,.12);border-radius:12px;background:rgba(0,0,0,.22);white-space:pre-wrap;word-break:break-word;line-height:1.55;max-height:360px;overflow:auto}
  .snapshot-list{display:grid;gap:9px}
  .snapshot-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:8px;align-items:center;padding:11px;border:1px solid rgba(0,247,255,.11);border-radius:12px;background:rgba(0,247,255,.018)}
  .snapshot-copy{display:flex;flex-direction:column;min-width:0}
  .snapshot-copy strong,.snapshot-copy small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .snapshot-copy small{color:var(--muted);margin-top:4px}
  @media(max-width:900px){.telemetry{grid-template-columns:repeat(2,1fr)}.health-grid{grid-template-columns:repeat(2,1fr)}.env-grid{grid-template-columns:repeat(2,1fr)}.git-grid,.git-actions,.repo-tool-grid{grid-template-columns:repeat(2,1fr)}.command-columns{grid-template-columns:1fr}.mode-grid,.theme-grid{grid-template-columns:repeat(2,1fr)}.ai-grid,.ai-actions{grid-template-columns:repeat(2,1fr)}.session-grid,.focus-stats,.smart-dev-grid,.ai-fix-meta,.quality-summary,.cp-summary,.analytics-summary,.architecture-summary,.orchestrator-summary{grid-template-columns:repeat(2,1fr)}.advanced-repo-grid,.focus-history-grid,.quality-grid,.cp-runner,.analytics-grid,.architecture-grid,.orchestrator-grid{grid-template-columns:1fr}.cp-problems{grid-template-columns:repeat(4,1fr)}}
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
    <div class="top-actions">
      <button data-command="customizeDashboard"><span>⚙</span>Customize Dashboard</button>
      <div class="online"><span class="orb"></span>SYSTEM ONLINE · v${version}</div>
    </div>
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

    <article class="card wide"${widgetAttr(state, 'health')}>
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

    <article class="card wide"${widgetAttr(state, 'environment')}>
      <div class="label">ENVIRONMENT STATUS</div>
      <div class="env-grid">
        <div class="env-box"><span>NODE</span><strong>${escapeHtml(state.environment.node)}</strong></div>
        <div class="env-box"><span>NPM</span><strong>${escapeHtml(state.environment.npm)}</strong></div>
        <div class="env-box"><span>PYTHON</span><strong>${escapeHtml(state.environment.python)}</strong></div>
        <div class="env-box"><span>GIT</span><strong>${escapeHtml(state.environment.git)}</strong></div>
        <div class="env-box"><span>VS CODE</span><strong>${escapeHtml(state.environment.vscode)}</strong></div>
      </div>
    </article>

    <article class="card wide"${widgetAttr(state, 'server')}>
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

    <article class="card"${widgetAttr(state, 'smartActions')}>
      <div class="label">SMART PROJECT ACTIONS</div>
      <div class="smart-grid">
        ${renderSmartActions(state.project.actions)}
      </div>
    </article>

    <article class="card wide"${widgetAttr(state, 'smartDeveloper')}>
      <div class="hub-head">
        <div>
          <div class="label">SMART DEVELOPER ASSISTANT</div>
          <div class="muted">Run project checks, capture failures, and get AI guidance without scraping your terminal.</div>
        </div>
        ${state.smartAssistant.analysis || state.smartAssistant.outputPreview
          ? '<button data-command="copySmartAssistantResult"><span>⧉</span>Copy Result</button>'
          : ''}
      </div>

      <div class="smart-dev-actions">
        ${renderSmartTaskButtons(state.smartAssistant.tasks)}
        <button data-command="explainCurrentFileAi"><span>◎</span>Explain Current File</button>
        <button data-command="analyzeClipboardError"><span>⚠</span>Analyze Clipboard Error</button>
        <button data-command="analyzeGitConflictAi"><span>⑂</span>AI Conflict Review</button>
        <button data-command="reviewStagedChangesAi"><span>✓</span>AI Commit Review</button>
      </div>

      <div class="smart-dev-grid">
        <div class="smart-dev-box"><span>STATUS</span><strong>${state.smartAssistant.running ? 'RUNNING…' : (state.smartAssistant.task ? 'READY' : 'IDLE')}</strong></div>
        <div class="smart-dev-box"><span>LAST TASK</span><strong>${escapeHtml(state.smartAssistant.task || 'None')}</strong></div>
        <div class="smart-dev-box"><span>AI MODEL</span><strong>${escapeHtml(state.smartAssistant.model || 'Not used yet')}</strong></div>
      </div>

      ${state.smartAssistant.command
        ? '<div class="commit-line">Command / Source: ' + escapeHtml(state.smartAssistant.command) +
          (state.smartAssistant.exitCode !== null ? ' · Exit ' + state.smartAssistant.exitCode : '') + '</div>'
        : ''}

      ${state.smartAssistant.outputPreview
        ? '<div class="project-group-title" style="margin-top:12px">CAPTURED OUTPUT</div><div class="smart-dev-output">' +
          escapeHtml(state.smartAssistant.outputPreview) + '</div>'
        : ''}

      ${state.smartAssistant.lastError
        ? '<div class="smart-dev-analysis"><strong>AI request error</strong>\n\n' +
          escapeHtml(state.smartAssistant.lastError) + '</div>'
        : ''}

      ${state.smartAssistant.analysis
        ? '<div class="project-group-title" style="margin-top:12px">AI ANALYSIS</div><div class="smart-dev-analysis">' +
          escapeHtml(state.smartAssistant.analysis) + '</div>'
        : ''}

      <p class="muted" style="margin:12px 0 0">Test/build/lint/typecheck output stays local after a failure unless you explicitly approve Analyze with AI. Clipboard, conflict, and staged-diff analysis also run only when you click them.</p>
    </article>

    <article class="card wide"${widgetAttr(state, 'aiFix')}>
      <div class="hub-head">
        <div>
          <div class="label">AI FIX STUDIO</div>
          <div class="muted">Generate a proposal, review the diff, then explicitly apply it.</div>
        </div>
        ${state.aiEdit.hasProposal
          ? '<div class="launcher-actions"><button data-command="reviewAiEditProposal"><span>◫</span>Review Diff</button><button data-command="applyAiEditProposal"><span>✓</span>Apply</button><button data-command="discardAiEditProposal"><span>×</span>Discard</button></div>'
          : ''}
      </div>

      <div class="ai-fix-actions">
        <button data-command="generateDiagnosticFix"><span>✦</span>Fix Current Error</button>
        <button data-command="refactorSelectedCode"><span>◇</span>Refactor Selection</button>
        <button data-command="generateTestsProposal"><span>＋</span>Generate Tests</button>
      </div>

      <div class="ai-fix-meta">
        <div class="ai-fix-box"><span>STATUS</span><strong>${state.aiEdit.running ? 'GENERATING…' : (state.aiEdit.hasProposal ? 'PROPOSAL READY' : 'IDLE')}</strong></div>
        <div class="ai-fix-box"><span>TYPE</span><strong>${escapeHtml(state.aiEdit.kind || 'None')}</strong></div>
        <div class="ai-fix-box"><span>CONFIDENCE</span><strong>${escapeHtml(state.aiEdit.confidence || 'Not rated')}</strong></div>
        <div class="ai-fix-box"><span>MODEL</span><strong>${escapeHtml(state.aiEdit.model || 'Not used yet')}</strong></div>
      </div>

      ${state.aiEdit.summary
        ? '<div class="ai-fix-summary"><strong>Proposal</strong><br><br>' + escapeHtml(state.aiEdit.summary) +
          (state.aiEdit.targetPath ? '<br><br><span class="muted">Target: ' + escapeHtml(state.aiEdit.targetPath) + '</span>' : '') +
          (state.aiEdit.verification?.length
            ? '<ul class="ai-fix-verify">' + state.aiEdit.verification.map((item) => '<li>' + escapeHtml(item) + '</li>').join('') + '</ul>'
            : '') +
          '</div>'
        : '<p class="muted">No proposal yet. AI edits are never applied automatically.</p>'}

      ${state.aiEdit.error
        ? '<div class="smart-dev-analysis"><strong>Proposal error</strong>\n\n' + escapeHtml(state.aiEdit.error) + '</div>'
        : ''}

      <p class="muted" style="margin:12px 0 0">Apply is blocked if the source file changed after the proposal was created. Generated tests refuse to overwrite an existing file.</p>
    </article>

    <article class="card wide"${widgetAttr(state, 'quality')}>
      <div class="quality-head">
        <div>
          <div class="label">QUALITY GATE + AUTO VERIFY</div>
          <h3 style="margin-bottom:4px">
            <span class="${state.qualityGate.status === 'READY' ? 'quality-status-ready' : (state.qualityGate.status === 'REVIEW' ? 'quality-status-review' : 'quality-status-blocked')}">
              ${escapeHtml(state.qualityGate.status)}
            </span>
            · ${state.qualityGate.score}/100
          </h3>
          <div class="muted">${escapeHtml(state.qualityGate.message || 'Run the gate to verify diagnostics, scripts, conflicts, coverage, and dependency risk.')}</div>
        </div>
        <div class="quality-actions">
          <button data-command="runQualityGate"><span>✓</span>Run Quality Gate</button>
          <button data-command="scanDependencies"><span>⌁</span>Scan Dependencies</button>
          <button data-command="smartCommitGate"><span>⑂</span>Smart Commit</button>
          ${state.qualityGate.canRollback ? '<button data-command="revertLastAiApply"><span>↶</span>Revert Last AI Apply</button>' : ''}
        </div>
      </div>

      <div class="quality-summary">
        <div class="quality-box"><span>ERRORS</span><strong>${state.qualityGate.errors}</strong></div>
        <div class="quality-box"><span>WARNINGS</span><strong>${state.qualityGate.warnings}</strong></div>
        <div class="quality-box"><span>CONFLICTS</span><strong>${state.qualityGate.conflicts}</strong></div>
        <div class="quality-box"><span>BEFORE → AFTER</span><strong>${state.qualityGate.beforeErrors === null ? '—' : state.qualityGate.beforeErrors} → ${state.qualityGate.afterErrors === null ? '—' : state.qualityGate.afterErrors}</strong></div>
        <div class="quality-box"><span>LAST RUN</span><strong>${state.qualityGate.lastRunAt ? escapeHtml(new Date(state.qualityGate.lastRunAt).toLocaleTimeString()) : 'Never'}</strong></div>
      </div>

      <div class="quality-grid">
        <div class="quality-panel">
          <div class="project-group-title">VERIFICATION CHECKS</div>
          <div class="quality-checks">${renderQualityChecks(state.qualityGate.checks)}</div>
        </div>

        <div class="quality-panel">
          <div class="project-group-title">TEST COVERAGE</div>
          ${state.qualityGate.coverage
            ? '<div class="coverage-grid">' +
              '<div><span>LINES</span><strong>' + escapeHtml(state.qualityGate.coverage.lines ?? '—') + '%</strong></div>' +
              '<div><span>STATEMENTS</span><strong>' + escapeHtml(state.qualityGate.coverage.statements ?? '—') + '%</strong></div>' +
              '<div><span>FUNCTIONS</span><strong>' + escapeHtml(state.qualityGate.coverage.functions ?? '—') + '%</strong></div>' +
              '<div><span>BRANCHES</span><strong>' + escapeHtml(state.qualityGate.coverage.branches ?? '—') + '%</strong></div>' +
              '</div>' +
              (state.qualityGate.coverage.weakFiles?.length
                ? '<div class="project-group-title" style="margin-top:10px">WEAK FILES (&lt;80% lines)</div>' +
                  state.qualityGate.coverage.weakFiles.map((item) =>
                    '<div class="history-row"><div><strong>' + escapeHtml(item.file) +
                    '</strong></div><span>' + escapeHtml(item.lines) + '%</span></div>'
                  ).join('')
                : '')
            : '<p class="muted">No coverage/coverage-summary.json detected.</p>'}
        </div>

        <div class="quality-panel">
          <div class="project-group-title">DEPENDENCY RISK</div>
          ${state.qualityGate.dependency
            ? '<div class="coverage-grid">' +
              '<div><span>CRITICAL</span><strong>' + state.qualityGate.dependency.critical + '</strong></div>' +
              '<div><span>HIGH</span><strong>' + state.qualityGate.dependency.high + '</strong></div>' +
              '<div><span>MODERATE</span><strong>' + state.qualityGate.dependency.moderate + '</strong></div>' +
              '<div><span>TOTAL</span><strong>' + state.qualityGate.dependency.total + '</strong></div>' +
              '</div>' +
              '<div class="commit-line">Outdated packages: ' + state.qualityGate.dependency.outdated + '</div>' +
              (state.qualityGate.dependency.error ? '<p class="muted">' + escapeHtml(state.qualityGate.dependency.error) + '</p>' : '')
            : '<p class="muted">Run Scan Dependencies to execute npm audit for this Node project.</p>'}
        </div>

        <div class="quality-panel">
          <div class="project-group-title">RECURRING ERRORS</div>
          ${renderRecurringErrors(state.qualityGate.recurringErrors)}
        </div>
      </div>

      <p class="muted" style="margin:12px 0 0">READY means no blocking diagnostics/conflicts and all available verification scripts passed. Dependency scan is explicit because npm audit may use the network.</p>
    </article>

    <article class="card wide"${widgetAttr(state, 'analytics')}>
      <div class="analytics-head">
        <div>
          <div class="label">DEVELOPER ANALYTICS + PROJECT INTELLIGENCE</div>
          <h3 style="margin-bottom:4px">Your coding signal, project trend, and practice performance</h3>
          <div class="muted">Coding analytics span your VS Code activity; Git, Quality, Health, and CP intelligence are scoped to this workspace.</div>
        </div>
        <button data-command="exportDeveloperAnalytics"><span>⇩</span>Export JSON</button>
      </div>

      <div class="analytics-summary">
        <div class="analytics-stat"><span>CODING · 7 DAYS</span><strong>${escapeHtml(state.developerAnalytics.coding.total7Text)}</strong></div>
        <div class="analytics-stat"><span>CODING · 30 DAYS</span><strong>${escapeHtml(state.developerAnalytics.coding.total30Text)}</strong></div>
        <div class="analytics-stat"><span>STREAK</span><strong>${state.developerAnalytics.coding.streak} day${state.developerAnalytics.coding.streak === 1 ? '' : 's'}</strong></div>
        <div class="analytics-stat"><span>TOP LANGUAGE</span><strong>${escapeHtml(state.developerAnalytics.coding.topLanguage)}</strong></div>
        <div class="analytics-stat"><span>GIT · 30 DAYS</span><strong>${state.developerAnalytics.git.commits30} commits</strong></div>
        <div class="analytics-stat"><span>QUALITY READY</span><strong>${state.developerAnalytics.quality.readyRate}%</strong></div>
      </div>

      <div class="analytics-grid">
        <div class="analytics-panel">
          <div class="project-group-title">CODING ACTIVITY · LAST 7 DAYS</div>
          ${renderAnalyticsCodingBars(state.developerAnalytics.coding.daily7)}
          <div class="commit-line">${state.developerAnalytics.coding.activeDays30} active day(s) in the last 30 days.</div>
        </div>

        <div class="analytics-panel">
          <div class="project-group-title">LANGUAGE DISTRIBUTION · 30 DAYS</div>
          ${renderAnalyticsLanguages(state.developerAnalytics.coding.languages)}
        </div>

        <div class="analytics-panel">
          <div class="project-group-title">GIT ACTIVITY · LAST 7 DAYS</div>
          ${renderAnalyticsGitBars(state.developerAnalytics.git.daily7)}
          <div class="commit-line">${state.developerAnalytics.git.commits7} commits this week · ${state.developerAnalytics.git.activeDays30} Git-active day(s) in 30 days.</div>
        </div>

        <div class="analytics-panel">
          <div class="project-group-title">PROJECT INTELLIGENCE</div>
          <div class="analytics-intel">
            <div><span>HEALTH</span><strong>${state.developerAnalytics.health.currentScore}/100</strong><small class="muted">${state.developerAnalytics.health.delta > 0 ? '+' : ''}${state.developerAnalytics.health.delta} vs previous</small></div>
            <div><span>QUALITY AVG</span><strong>${state.developerAnalytics.quality.averageScore}/100</strong><small class="muted">${state.developerAnalytics.quality.runs} tracked run(s)</small></div>
            <div><span>LATEST GATE</span><strong>${escapeHtml(state.developerAnalytics.quality.latestStatus)}</strong><small class="muted">${state.developerAnalytics.quality.latestScore}/100</small></div>
            <div><span>CP PASS RATE</span><strong>${state.developerAnalytics.cp.passRate}%</strong><small class="muted">${state.developerAnalytics.cp.runs} judged run(s)</small></div>
            <div><span>OFFICIAL AC</span><strong>${state.developerAnalytics.cp.accepted}</strong><small class="muted">preserved across contests</small></div>
            <div><span>CP AVG RUNTIME</span><strong>${state.developerAnalytics.cp.averageRuntimeMs} ms</strong><small class="muted">${state.developerAnalytics.cp.stressRuns} stress run(s)</small></div>
          </div>
        </div>

        <div class="analytics-panel">
          <div class="project-group-title">QUALITY GATE HISTORY</div>
          ${renderAnalyticsQualityHistory(state.developerAnalytics.quality.recent)}
        </div>

        <div class="analytics-panel">
          <div class="project-group-title">PROJECT HEALTH TREND</div>
          ${renderAnalyticsHealthHistory(state.developerAnalytics.health.recent)}
        </div>
      </div>
    </article>

    <article class="card wide"${widgetAttr(state, 'architecture')}>
      <div class="architecture-head">
        <div>
          <div class="label">WORKSPACE ARCHITECTURE INTELLIGENCE</div>
          <h3 style="margin-bottom:4px">Structure map · dependency graph · feature navigation</h3>
          <div class="muted">Local static analysis first. AI receives search snippets only when you explicitly choose AI Explain Matches.</div>
        </div>
        <div class="architecture-actions">
          <button data-command="architectureFindFeature"><span>⌕</span>Find Feature</button>
          <button data-command="architectureExplainMatches"><span>✦</span>AI Explain Matches</button>
          <button data-command="refreshArchitecture"><span>↻</span>Refresh Scan</button>
          <button data-command="exportArchitectureJson"><span>⇩</span>Export JSON</button>
        </div>
      </div>

      ${state.architecture.scan ? `
      <div class="architecture-summary">
        <div class="architecture-stat"><span>SCANNED FILES</span><strong>${state.architecture.scan.totalFiles}</strong></div>
        <div class="architecture-stat"><span>SOURCE LINES</span><strong>${state.architecture.scan.totalLines}</strong></div>
        <div class="architecture-stat"><span>ENTRY POINTS</span><strong>${state.architecture.scan.entryPoints.length}</strong></div>
        <div class="architecture-stat"><span>RELATIONSHIPS</span><strong>${state.architecture.scan.relationships.length}</strong></div>
        <div class="architecture-stat"><span>CYCLES</span><strong>${state.architecture.scan.cycles.length}</strong></div>
        <div class="architecture-stat"><span>SCAN STATUS</span><strong>${state.architecture.scan.truncated ? 'CAPPED' : 'COMPLETE'}</strong></div>
      </div>

      <div class="architecture-grid">
        <div class="architecture-panel">
          <div class="project-group-title">ENTRY POINTS</div>
          ${renderArchitectureEntries(state.architecture.scan.entryPoints)}
        </div>
        <div class="architecture-panel">
          <div class="project-group-title">TOP-LEVEL STRUCTURE</div>
          ${renderArchitectureTopLevel(state.architecture.scan.topLevel)}
        </div>
        <div class="architecture-panel">
          <div class="project-group-title">LANGUAGES</div>
          ${renderArchitectureLanguages(state.architecture.scan.languages)}
        </div>
        <div class="architecture-panel">
          <div class="project-group-title">CENTRAL MODULES</div>
          ${renderArchitectureCentral(state.architecture.scan.centralModules)}
        </div>
        <div class="architecture-panel">
          <div class="project-group-title">RISK HOTSPOTS</div>
          ${renderArchitectureRisk(state.architecture.scan.riskFiles)}
        </div>
        <div class="architecture-panel">
          <div class="project-group-title">LARGEST SOURCE FILES</div>
          ${renderArchitectureLarge(state.architecture.scan.largeFiles)}
        </div>
        <div class="architecture-panel">
          <div class="project-group-title">MODULE RELATIONSHIPS</div>
          ${renderArchitectureRelations(state.architecture.scan.relationships)}
        </div>
        <div class="architecture-panel">
          <div class="project-group-title">DEPENDENCY CYCLES</div>
          ${renderArchitectureCycles(state.architecture.scan.cycles)}
        </div>
        <div class="architecture-panel">
          <div class="project-group-title">FEATURE SEARCH</div>
          ${state.architecture.search.query ? '<div class="commit-line">Query: ' + escapeHtml(state.architecture.search.query) + '</div>' : ''}
          ${renderArchitectureSearch(state.architecture.search.results)}
        </div>
      </div>

      ${state.architecture.search.running
        ? '<div class="architecture-ai">Analyzing matches…</div>'
        : state.architecture.search.error
          ? '<div class="architecture-ai"><strong>AI error</strong>\n\n' + escapeHtml(state.architecture.search.error) + '</div>'
          : state.architecture.search.analysis
            ? '<div class="architecture-ai">' + escapeHtml(state.architecture.search.analysis) + '</div>'
            : ''}
      ` : '<p class="muted">Open a workspace folder to scan its architecture.</p>'}
    </article>

    <article class="card wide"${widgetAttr(state, 'orchestrator')}>
      <div class="orchestrator-head">
        <div>
          <div class="label">WORKSPACE TASK ORCHESTRATOR</div>
          <h3 style="margin-bottom:4px">Command graph · saved workflows · failure-aware pipelines</h3>
          <div class="muted">Auto-discovers package scripts. Sequential workflows stop on failure; parallel workflows run selected scripts together.</div>
        </div>
        <div class="orchestrator-actions">
          ${state.taskOrchestrator.running ? '<button data-command="orchestratorCancel"><span>■</span>Cancel Run</button>' : ''}
          <button data-command="orchestratorVerify"><span>✓</span>Verify Pipeline</button>
          <button data-command="orchestratorShip"><span>⇧</span>Build → Test → Gate → Commit</button>
          <button data-command="orchestratorCreateWorkflow"><span>＋</span>Save Workflow</button>
        </div>
      </div>

      <div class="orchestrator-summary">
        <div class="orchestrator-stat"><span>PACKAGE MANAGER</span><strong>${escapeHtml(state.taskOrchestrator.discovery.packageManager || '—')}</strong></div>
        <div class="orchestrator-stat"><span>DISCOVERED TASKS</span><strong>${state.taskOrchestrator.discovery.tasks.length}</strong></div>
        <div class="orchestrator-stat"><span>GRAPH EDGES</span><strong>${state.taskOrchestrator.discovery.edges.length}</strong></div>
        <div class="orchestrator-stat"><span>SAVED WORKFLOWS</span><strong>${state.taskOrchestrator.workflows.length}</strong></div>
        <div class="orchestrator-stat"><span>STATUS</span><strong>${state.taskOrchestrator.running ? 'RUNNING…' : (state.taskOrchestrator.passed === null ? 'IDLE' : (state.taskOrchestrator.passed ? 'PASS' : 'FAILED'))}</strong></div>
      </div>

      <div class="orchestrator-grid">
        <div class="orchestrator-panel">
          <div class="project-group-title">DISCOVERED SCRIPTS</div>
          ${renderOrchestratorTasks(state.taskOrchestrator.discovery.tasks)}
        </div>
        <div class="orchestrator-panel">
          <div class="project-group-title">COMMAND GRAPH</div>
          ${renderOrchestratorGraph(state.taskOrchestrator.discovery.edges)}
        </div>
        <div class="orchestrator-panel">
          <div class="project-group-title">SAVED WORKFLOWS</div>
          ${renderSavedWorkflows(state.taskOrchestrator.workflows)}
        </div>
        <div class="orchestrator-panel">
          <div class="project-group-title">LAST RUN</div>
          ${state.taskOrchestrator.name ? '<div class="commit-line">' + escapeHtml(state.taskOrchestrator.name) + ' · ' + escapeHtml(state.taskOrchestrator.mode || '') + ' · ' + Math.round(Number(state.taskOrchestrator.durationMs || 0) / 1000) + 's</div>' : ''}
          ${renderOrchestratorResults(state.taskOrchestrator.results)}
          ${state.taskOrchestrator.results?.length ? '<div class="project-group-title" style="margin-top:10px">LAST OUTPUT</div><div class="orchestrator-output">' + escapeHtml(state.taskOrchestrator.results[state.taskOrchestrator.results.length - 1]?.output || '[no output]') + '</div>' : ''}
        </div>
        <div class="orchestrator-panel">
          <div class="project-group-title">RUN HISTORY</div>
          ${renderOrchestratorHistory(state.taskOrchestrator.history)}
        </div>
      </div>
    </article>

    <article class="card wide"${widgetAttr(state, 'cpArena')}>
      <div class="cp-arena-head">
        <div>
          <div class="label">GALAXY CP ARENA</div>
          <h3 style="margin-bottom:4px">Contest cockpit · local judge · AI coach</h3>
          <div class="muted">C/C++, Python, and JavaScript sample runner. Contest/problem history stays in VS Code local storage.</div>
        </div>
        <div class="cp-actions">
          <button data-command="cpStartContest"><span>▶</span>New Contest</button>
          <button data-command="cpStopContest"><span>■</span>Stop</button>
          <button data-command="cpFocusMode"><span>◎</span>CP Focus</button>
          <button data-command="cpResetArena"><span>↺</span>Reset</button>
        </div>
      </div>

      <div class="cp-summary">
        <div class="cp-stat">
          <span>CONTEST</span>
          <strong
            class="cp-clock"
            id="cpContestClock"
            data-running="${state.cpArena.contest.running ? '1' : '0'}"
            data-end-at="${Number(state.cpArena.contest.endAt || 0)}"
            data-remaining="${Number(state.cpArena.contest.remainingMs || 0)}"
          >${escapeHtml(state.cpArena.contest.remainingText)}</strong>
        </div>
        <div class="cp-stat"><span>SOLVED</span><strong>${state.cpArena.solved} / ${state.cpArena.total}</strong></div>
        <div class="cp-stat"><span>CURRENT</span><strong>${escapeHtml(state.cpArena.currentProblem)}</strong></div>
        <div class="cp-stat">
          <span>PROBLEM TIME</span>
          <strong
            class="cp-clock"
            id="cpProblemClock"
            data-running="${state.cpArena.contest.running ? '1' : '0'}"
            data-current-ms="${Number(state.cpArena.problems.find((item) => item.current)?.activeMs || 0)}"
          >${escapeHtml(state.cpArena.currentProblemTime)}</strong>
        </div>
        <div class="cp-stat"><span>LAST VERDICT</span><strong>${escapeHtml(state.cpArena.lastRun?.verdict || '—')}</strong></div>
      </div>

      <div class="project-group-title">PROBLEM TRACKER · CLICK A PROBLEM TO SWITCH</div>
      <div class="cp-problems">${renderCpProblems(state.cpArena.problems)}</div>

      <div class="project-group-title">CURRENT PROBLEM ${escapeHtml(state.cpArena.currentProblem)} · VERDICT / STATE</div>
      <div class="cp-status-actions">
        <button data-cp-status="SOLVING">Solving</button>
        <button data-cp-status="WA">WA</button>
        <button data-cp-status="TLE">TLE</button>
        <button data-cp-status="RE">RE</button>
        <button data-cp-status="AC">AC ✓</button>
        <button data-cp-status="NOT STARTED">Reset Status</button>
      </div>

      <div class="project-group-title">LOCAL SAMPLE JUDGE</div>
      <div class="cp-runner">
        <div class="cp-run-panel">
          <strong>Sample Input</strong>
          <textarea id="cpSampleInput" spellcheck="false" placeholder="Paste sample input here...">${escapeHtml(state.cpArena.lastRun?.input || '')}</textarea>
        </div>
        <div class="cp-run-panel">
          <strong>Expected Output</strong>
          <textarea id="cpSampleExpected" spellcheck="false" placeholder="Paste expected output here...">${escapeHtml(state.cpArena.lastRun?.expected || '')}</textarea>
        </div>
      </div>
      <p class="muted" style="margin:8px 0 0">Multi-case format: separate each input case and each expected-output case with a line containing <code>---</code>.</p>
      <div class="cp-tools">
        <button data-cp-run-sample="1"><span>▶</span>Run Sample</button>
        <button data-cp-run-multi="1"><span>≋</span>Run Multi Cases</button>
        <button data-command="cpStressTest"><span>⚡</span>Stress Test</button>
        <button data-command="cpNewProblemFile"><span>＋</span>New Problem File</button>
        <button data-command="cpSnippetVault"><span>⌘</span>Snippet Vault</button>
        <button data-command="cpAiComplexity"><span>O()</span>Complexity</button>
        <button data-command="cpAiEdgeCases"><span>◇</span>Edge Cases</button>
        <button data-command="cpPanicAssist"><span>!</span>Panic Assist</button>
      </div>

      ${state.cpArena.lastRun ? '<div class="cp-result">' +
        '<div class="commit-line"><strong>' + escapeHtml(state.cpArena.lastRun.verdict) +
        '</strong> · ' + Number(state.cpArena.lastRun.runtimeMs || 0) + ' ms · Problem ' +
        escapeHtml(state.cpArena.lastRun.problem || state.cpArena.currentProblem) + '</div>' +
        '<div class="project-group-title" style="margin-top:10px">ACTUAL OUTPUT</div>' +
        '<div class="cp-output">' + escapeHtml(state.cpArena.lastRun.stdout || '[no stdout]') + '</div>' +
        (state.cpArena.lastRun.stderr
          ? '<div class="project-group-title" style="margin-top:10px">STDERR</div><div class="cp-output">' +
            escapeHtml(state.cpArena.lastRun.stderr) + '</div>'
          : '') +
        '</div>' : ''}

      ${state.cpArena.lastSuite?.cases?.length
        ? '<div class="project-group-title" style="margin-top:14px">LAST MULTI-CASE RUN</div><div class="history-panel">' +
          renderCpSuite(state.cpArena.lastSuite) + '</div>'
        : ''}

      ${state.cpArena.lastStress
        ? '<div class="project-group-title" style="margin-top:14px">LAST STRESS TEST</div><div class="cp-result">' +
          '<div class="commit-line"><strong>' + escapeHtml(state.cpArena.lastStress.verdict || (state.cpArena.lastStress.ok ? 'PASS' : 'FAILED')) +
          '</strong>' +
          (state.cpArena.lastStress.iteration ? ' · iteration ' + Number(state.cpArena.lastStress.iteration) : '') +
          (state.cpArena.lastStress.iterations ? ' · ' + Number(state.cpArena.lastStress.iterations) + ' iterations' : '') +
          '</div>' +
          (state.cpArena.lastStress.input ? '<div class="project-group-title" style="margin-top:10px">FAILING INPUT</div><div class="cp-output">' + escapeHtml(state.cpArena.lastStress.input) + '</div>' : '') +
          (state.cpArena.lastStress.bruteOutput ? '<div class="project-group-title" style="margin-top:10px">BRUTE OUTPUT</div><div class="cp-output">' + escapeHtml(state.cpArena.lastStress.bruteOutput) + '</div>' : '') +
          (state.cpArena.lastStress.optimizedOutput ? '<div class="project-group-title" style="margin-top:10px">OPTIMIZED OUTPUT</div><div class="cp-output">' + escapeHtml(state.cpArena.lastStress.optimizedOutput) + '</div>' : '') +
          (state.cpArena.lastStress.error ? '<div class="cp-output">' + escapeHtml(state.cpArena.lastStress.error) + '</div>' : '') +
          '</div>'
        : ''}

      <div class="project-group-title" style="margin-top:14px">VERDICT HISTORY</div>
      <div class="history-panel">${renderCpHistory(state.cpArena.history)}</div>

      <div class="project-group-title" style="margin-top:14px">CP AI COACH</div>
      ${state.cpAi.running
        ? '<div class="cp-ai-result">Analyzing…</div>'
        : state.cpAi.error
          ? '<div class="cp-ai-result"><strong>AI error</strong>\n\n' + escapeHtml(state.cpAi.error) + '</div>'
          : state.cpAi.result
            ? '<div class="cp-ai-result">' + escapeHtml(state.cpAi.result) + '</div>'
            : '<p class="muted">Complexity and edge-case tools analyze the selected code, or the current file when nothing is selected. Panic Assist reads a copied problem statement and returns hints instead of a full solution.</p>'}

      <div class="project-group-title" style="margin-top:14px">PLATFORMS</div>
      <div class="cp-platforms">
        <button data-cp-platform="codeforces">Codeforces ↗</button>
        <button data-cp-platform="atcoder">AtCoder ↗</button>
        <button data-cp-platform="leetcode">LeetCode ↗</button>
        <button data-cp-platform="codechef">CodeChef ↗</button>
      </div>
    </article>

    <article class="card wide"${widgetAttr(state, 'git')}>
      <div class="hub-head">
        <div>
          <div class="label">REPOSITORY CONTROL HUB</div>
          <div class="muted">Local Git + GitHub / GitLab / Bitbucket / Azure DevOps remote control</div>
        </div>
        <button data-command="cloneRepository"><span>↓</span>Clone Repository</button>
      </div>

      <div class="repo-meta">
        <div class="repo-meta-box"><span>PROVIDER</span><strong>${provider}</strong></div>
        <div class="repo-meta-box"><span>BRANCH</span><strong>${branch}</strong></div>
        <div class="repo-meta-box"><span>ORIGIN</span><strong title="${originUrl}">${originUrl}</strong></div>
      </div>

      <div class="git-grid">
        <div class="git-box"><span>STAGED</span><strong>${state.staged}</strong></div>
        <div class="git-box"><span>UNSTAGED</span><strong>${state.unstaged}</strong></div>
        <div class="git-box"><span>UNTRACKED</span><strong>${state.untracked}</strong></div>
        <div class="git-box"><span>SYNC</span><strong>${sync}</strong></div>
      </div>

      <div class="git-actions">
        <button data-git-action="fetch"><span>↻</span>Fetch</button>
        <button data-git-action="pull"><span>↓</span>Pull</button>
        <button data-git-action="push"><span>↑</span>Push</button>
        <button data-git-action="sync"><span>⇅</span>Sync</button>
        <button data-git-action="stageAll"><span>＋</span>Stage All</button>
        <button data-git-action="unstageAll"><span>−</span>Unstage All</button>
        <button data-command="commitChanges"><span>✓</span>Commit</button>
        <button data-command="openRemoteRepository"><span>↗</span>Open Remote</button>
      </div>

      <div class="repo-tool-grid">
        <button data-command="createBranch"><span>⑂</span>Create Branch</button>
        <button data-command="switchBranch"><span>⇄</span>Switch Branch</button>
        <button data-command="manageOrigin"><span>⌘</span>Manage Origin</button>
        <button data-command="initializeRepository"><span>＋</span>Initialize Git</button>
      </div>

      <div class="commit-line">Last commit: ${lastCommit}</div>

      <div class="advanced-repo">
        <div class="advanced-repo-head">
          <div>
            <strong>ADVANCED REPOSITORY WORKFLOW</strong>
            <div class="muted">Conflicts, diffs, tags, releases, reviews, Actions, and safe cleanup</div>
          </div>
          <div class="launcher-actions">
            <button data-command="safeCommitPush"><span>✓</span>Safe Commit & Push</button>
            <button data-command="openPrReviewCenter"><span>⑂</span>PR Review Center</button>
          </div>
        </div>

        <div class="advanced-repo-grid">
          <div class="advanced-box">
            <div class="advanced-box-head">
              <strong>MERGE CONFLICT ASSISTANT</strong>
              <span class="muted">${state.advancedRepo.conflicts.length} conflict(s)</span>
            </div>
            ${renderConflictFiles(state.advancedRepo.conflicts)}
          </div>

          <div class="advanced-box">
            <div class="advanced-box-head">
              <strong>DIFF / FILE CHANGES</strong>
              <span class="muted">${state.advancedRepo.changedFiles.length} shown</span>
            </div>
            ${renderChangedFiles(state.advancedRepo.changedFiles)}
          </div>

          <div class="advanced-box">
            <div class="advanced-box-head">
              <strong>TAGS & RELEASES</strong>
              <div class="launcher-actions">
                <button data-command="createGitTag">Create Tag</button>
                <button data-command="createDraftRelease">Draft Release</button>
              </div>
            </div>
            <div class="muted">${state.advancedRepo.tags.length ? 'Recent tags: ' + escapeHtml(state.advancedRepo.tags.join(', ')) : 'No tags yet.'}</div>
          </div>

          <div class="advanced-box">
            <div class="advanced-box-head">
              <strong>BRANCH CLEANUP</strong>
              <span class="muted">Merged local branches only</span>
            </div>
            ${renderMergedBranches(state.advancedRepo.mergedBranches)}
          </div>
        </div>
      </div>

      <div class="github-panel">
        <div class="github-head">
          <div>
            <strong>GITHUB COLLABORATION</strong>
            <div class="muted">${state.github.connected ? `Connected as ${githubAccount}` : 'Not connected through VS Code yet'}</div>
          </div>
          <div class="launcher-actions">
            ${state.github.connected
              ? '<button data-command="refreshGitHub"><span>↻</span>Refresh</button>'
              : '<button data-command="connectGitHub"><span>◎</span>Connect GitHub</button>'}
          </div>
        </div>
        <div class="collab-actions">
          <button data-command="createGitHubRepository"><span>＋</span>Create Repo</button>
          <button data-command="publishCurrentProject"><span>⇧</span>Publish Current Project</button>
          <button data-command="createGitHubIssue"><span>!</span>New Issue</button>
          <button data-command="createGitHubPullRequest"><span>⑂</span>New Pull Request</button>
        </div>
        <div class="remote-repo-list">
          ${renderGitHubCollaboration(state.githubCollaboration)}
        </div>
        <div class="project-group-title" style="margin-top:14px">RECENT GITHUB REPOSITORIES</div>
        <div class="remote-repo-list">
          ${renderGitHubRepos(state.github)}
        </div>

        <div class="provider-bridge">
          <div class="project-group-title">PROVIDER-NATIVE BRIDGE</div>
          <div class="provider-bridge-grid">
            <div class="provider-box">
              <div class="provider-box-head">
                <div>
                  <strong>GitLab</strong>
                  <div class="muted">${state.providerBridge.gitlabInstalled ? escapeHtml(state.providerBridge.gitlabVersion) : 'glab not installed'}</div>
                </div>
                <div class="launcher-actions">
                  <button data-provider-action="gitlabLogin">Login</button>
                  <button data-provider-action="gitlabRepos">Repos</button>
                </div>
              </div>
              <div class="remote-repo-list">${renderGitLabCliRepos(state.providerBridge)}</div>
            </div>
            <div class="provider-box">
              <div class="provider-box-head">
                <div>
                  <strong>Bitbucket</strong>
                  <div class="muted">${state.providerBridge.bitbucketInstalled ? escapeHtml(state.providerBridge.bitbucketVersion) : 'twg not installed'}</div>
                </div>
                <div class="launcher-actions">
                  <button data-provider-action="bitbucketSetup">Setup</button>
                  <button data-provider-action="bitbucketRepos">Repos</button>
                </div>
              </div>
              <p class="muted">Provider-native Bitbucket commands run through Atlassian TWG CLI when available.</p>
            </div>
          </div>
        </div>
      </div>
    </article>

    <article class="card wide"${widgetAttr(state, 'commands')}>
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

    <article class="card wide"${widgetAttr(state, 'modes')}>
      <div class="label">DEVELOPER MODES</div>
      <div class="mode-grid">
        <button class="mode-btn ${state.mode.active === 'Frontend' ? 'active' : ''}" data-dev-mode="Frontend">
          <strong>Frontend</strong><small>Explorer + Terminal</small>
        </button>
        <button class="mode-btn ${state.mode.active === 'Python' ? 'active' : ''}" data-dev-mode="Python">
          <strong>Python</strong><small>Explorer + Terminal</small>
        </button>
        <button class="mode-btn ${state.mode.active === 'AI / ML' ? 'active' : ''}" data-dev-mode="AI / ML">
          <strong>AI / ML</strong><small>Workspace + Terminal</small>
        </button>
        <button class="mode-btn ${state.mode.active === 'Debug' ? 'active' : ''}" data-dev-mode="Debug">
          <strong>Debug</strong><small>Run & Debug panel</small>
        </button>
        <button class="mode-btn ${state.mode.active === 'Study' ? 'active' : ''}" data-dev-mode="Study">
          <strong>Study</strong><small>Centered editor layout</small>
        </button>
        <button class="mode-btn ${state.mode.active === 'Focus' ? 'active' : ''}" data-dev-mode="Focus">
          <strong>Focus</strong><small>Zen Mode</small>
        </button>
      </div>
      <div class="focus-bar">
        <div>
          <strong>Active Mode: ${activeMode}</strong>
          <div class="muted">Modes change layout/actions only; they do not overwrite your project files.</div>
        </div>
        <button data-command="focusMode"><span>◉</span>Toggle Focus Mode</button>
      </div>
    </article>

    <article class="card wide"${widgetAttr(state, 'themes')}>
      <div class="theme-meta">
        <div>
          <div class="label">THEME MATRIX</div>
          <div class="muted">Current: ${currentTheme}</div>
        </div>
        <button data-command="theme"><span>✦</span>Open Full Theme Picker</button>
      </div>
      <div class="theme-grid">
        ${renderThemeMatrix(state.themes)}
      </div>
    </article>

    <article class="card wide"${widgetAttr(state, 'ai')}>
      <div class="label">AI HUD</div>
      <div class="ai-grid">
        <div class="ai-stat"><span>ACTIVE FILE</span><strong>${escapeHtml(state.ai.file)}</strong></div>
        <div class="ai-stat"><span>SELECTED CHARS</span><strong>${state.ai.selectionLength}</strong></div>
        <div class="ai-stat"><span>DIAGNOSTICS</span><strong>${state.ai.diagnostics}</strong></div>
      </div>
      <div class="ai-actions">
        <button data-ai-action="selection"><span>✦</span>Explain Selection</button>
        <button data-ai-action="diagnostics"><span>⚠</span>Diagnose File</button>
        <button data-ai-action="commit"><span>⑂</span>Commit Prompt</button>
        <button data-command="openChat"><span>◫</span>Open Chat</button>
      </div>
      ${state.ai.lastPrompt ? `
        <div class="ai-preview-head">
          <strong>GENERATED PROMPT · ${escapeHtml(state.ai.lastPromptKind || 'prompt').toUpperCase()}</strong>
          <button data-command="copyLastAiPrompt"><span>⧉</span>Copy Prompt</button>
        </div>
        <div class="ai-preview">${escapeHtml(state.ai.lastPrompt)}</div>
      ` : '<p class="muted" style="margin-top:12px;margin-bottom:0">Generate a prompt to preview it here instantly.</p>'}
      <p class="muted" style="margin-top:12px;margin-bottom:0">AI HUD prepares context locally. It does not send project data anywhere by itself.</p>
    </article>

    <article class="card wide"${widgetAttr(state, 'debug')}>
      <div class="hub-head">
        <div>
          <div class="label">AI DEBUG ASSISTANT</div>
          <div class="muted">VS Code Problems + language-model analysis, with Auto Analyze off by default</div>
        </div>
        <div class="launcher-actions">
          <button data-command="analyzeDebug"><span>✦</span>${state.debugAssistant.analyzing ? 'Analyzing…' : 'Analyze Error'}</button>
          <button data-command="toggleAutoDebug"><span>◉</span>Auto Analyze: ${state.debugAssistant.autoAnalyze ? 'ON' : 'OFF'}</button>
          ${state.debugAssistant.analysis ? '<button data-command="copyDebugAnalysis"><span>⧉</span>Copy Analysis</button>' : ''}
        </div>
      </div>

      <div class="debug-summary">
        <div class="debug-stat"><span>ERRORS</span><strong>${state.debugAssistant.errors}</strong></div>
        <div class="debug-stat"><span>WARNINGS</span><strong>${state.debugAssistant.warnings}</strong></div>
        <div class="debug-stat"><span>AI MODEL</span><strong>${escapeHtml(state.debugAssistant.model || 'Not used yet')}</strong></div>
      </div>

      <div class="debug-list">${renderDebugDiagnostics(state.debugAssistant.diagnostics)}</div>

      ${state.debugAssistant.lastError
        ? '<div class="debug-analysis"><strong>AI request error</strong>\n\n' + escapeHtml(state.debugAssistant.lastError) + '</div>'
        : ''}
      ${state.debugAssistant.analysis
        ? '<div class="debug-analysis">' + escapeHtml(state.debugAssistant.analysis) + '</div>'
        : ''}

      <p class="muted" style="margin:12px 0 0">Auto Analyze sends only the selected diagnostic and a small nearby code snippet to an available VS Code language model. Full project code is not stored or sent by this feature.</p>
    </article>

    <article class="card wide"${widgetAttr(state, 'notes')}>
      <div class="hub-head">
        <div>
          <div class="label">PROJECT NOTES</div>
          <div class="muted">Workspace-specific note / next task</div>
        </div>
        <button data-command="editProjectNote"><span>✎</span>Edit Note</button>
      </div>
      <div class="note-box">${state.projectNote ? escapeHtml(state.projectNote) : '<span class="muted">No project note yet.</span>'}</div>
    </article>

    <article class="card wide"${widgetAttr(state, 'session')}>
      <div class="label">CODING SESSION STATS</div>
      <div class="session-grid">
        <div class="session-box"><span>SESSION TIME</span><strong>${escapeHtml(state.session.duration)}</strong></div>
        <div class="session-box"><span>FILES TOUCHED</span><strong>${state.session.filesTouched}</strong></div>
        <div class="session-box"><span>COMMANDS RUN</span><strong>${state.session.commandsRun}</strong></div>
        <div class="session-box"><span>SAVES</span><strong>${state.session.saves}</strong></div>
      </div>
    </article>

    <article class="card wide"${widgetAttr(state, 'focus')}>
      <div class="focus-head">
        <div>
          <div class="label">GALAXY FOCUS + CODING HISTORY</div>
          <h3 style="margin-bottom:4px">${escapeHtml(state.codingHistory.activeText)} today · ${state.codingHistory.goalPercent}% of goal</h3>
          <div class="muted">Active coding time only — VS Code focused, code editor active, and recent interaction.</div>
        </div>
        <button data-command="setCodingGoal"><span>◎</span>Edit Daily Goal</button>
      </div>

      <div class="goal-progress"><span style="width:${state.codingHistory.goalPercent}%"></span></div>

      <div class="focus-stats">
        <div class="focus-stat"><span>TODAY</span><strong>${escapeHtml(state.codingHistory.activeText)}</strong></div>
        <div class="focus-stat"><span>DAILY GOAL</span><strong>${escapeHtml(state.codingHistory.goalText)}</strong></div>
        <div class="focus-stat"><span>EDITS</span><strong>${state.codingHistory.edits}</strong></div>
        <div class="focus-stat"><span>SAVES</span><strong>${state.codingHistory.saves}</strong></div>
      </div>

      <div class="focus-timer">
        <div>
          <div class="project-group-title">FOCUS TIMER · ${escapeHtml(state.focusTimer.label)}</div>
          <div
            class="focus-clock"
            id="galaxyFocusClock"
            data-running="${state.focusTimer.running ? '1' : '0'}"
            data-end-at="${Number(state.focusTimer.endAt || 0)}"
            data-remaining="${Number(state.focusTimer.remainingMs || 0)}"
          >${escapeHtml(formatTimerClock(state.focusTimer.remainingMs || 0))}</div>
        </div>
        <div class="focus-controls">
          <button data-focus-action="25">25 min</button>
          <button data-focus-action="50">50 min</button>
          <button data-focus-action="custom">Custom</button>
          ${state.focusTimer.running
            ? '<button data-focus-action="pause">Pause</button>'
            : (state.focusTimer.remainingMs > 0 ? '<button data-focus-action="resume">Resume</button>' : '')}
          <button data-focus-action="stop">Stop</button>
        </div>
      </div>

      <div class="project-group-title">LANGUAGE TIME TODAY</div>
      <div class="language-pills">${renderLanguageHistory(state.codingHistory.languages)}</div>

      <div class="focus-history-grid">
        <div class="history-panel">
          <div class="project-group-title">FILES / ACTIVITY</div>
          ${renderCodingFiles(state.codingHistory.files)}
        </div>
        <div class="history-panel">
          <div class="project-group-title">LAST 7 DAYS</div>
          ${renderRecentCodingDays(state.codingHistory.recentDays)}
        </div>
      </div>
    </article>

    <article class="card wide"${widgetAttr(state, 'snapshots')}>
      <div class="hub-head">
        <div>
          <div class="label">WORKSPACE SNAPSHOTS</div>
          <div class="muted">Lightweight UI state, note, pinned commands, theme, and active file</div>
        </div>
        <button data-command="createSnapshot"><span>＋</span>Create Snapshot</button>
      </div>
      <div class="snapshot-list">
        ${renderWorkspaceSnapshots(state.snapshots)}
      </div>
    </article>

    <article class="card wide"${widgetAttr(state, 'extensions')}>
      <div class="hub-head">
        <div>
          <div class="label">GALAXY EXTENSION HUB</div>
          <div class="muted">${state.galaxyExtensions.length} matching extension(s) detected</div>
        </div>
        <button data-command="searchGalaxyExtensions"><span>⌕</span>Browse gitwithmasum</button>
      </div>
      <div class="hub-list">
        ${renderGalaxyExtensions(state.galaxyExtensions)}
      </div>
    </article>

    <article class="card wide"${widgetAttr(state, 'projects')}>
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

    <article class="card wide"${widgetAttr(state, 'files')}>
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

  document.querySelectorAll('[data-dev-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      vscode.postMessage({ command: 'developerMode', value: button.dataset.devMode });
    });
  });

  document.querySelectorAll('[data-theme-label]').forEach((button) => {
    button.addEventListener('click', () => {
      vscode.postMessage({ command: 'applyTheme', value: button.dataset.themeLabel });
    });
  });

  document.querySelectorAll('[data-ai-action]').forEach((button) => {
    button.addEventListener('click', () => {
      vscode.postMessage({ command: 'aiPrompt', value: button.dataset.aiAction });
    });
  });

  document.querySelectorAll('[data-smart-task]').forEach((button) => {
    button.addEventListener('click', () => {
      vscode.postMessage({ command: 'runSmartProjectTask', value: button.dataset.smartTask });
    });
  });

  document.querySelectorAll('[data-extension-id]').forEach((button) => {
    button.addEventListener('click', () => {
      vscode.postMessage({ command: 'openGalaxyExtension', value: button.dataset.extensionId });
    });
  });

  document.querySelectorAll('[data-restore-snapshot]').forEach((button) => {
    button.addEventListener('click', () => {
      vscode.postMessage({ command: 'restoreSnapshot', value: button.dataset.restoreSnapshot });
    });
  });

  document.querySelectorAll('[data-delete-snapshot]').forEach((button) => {
    button.addEventListener('click', () => {
      vscode.postMessage({ command: 'deleteSnapshot', value: button.dataset.deleteSnapshot });
    });
  });

  document.querySelectorAll('[data-github-open]').forEach((button) => {
    button.addEventListener('click', () => {
      vscode.postMessage({ command: 'openGitHubRepository', value: button.dataset.githubOpen });
    });
  });

  document.querySelectorAll('[data-github-clone]').forEach((button) => {
    button.addEventListener('click', () => {
      vscode.postMessage({ command: 'cloneRepository', value: button.dataset.githubClone });
    });
  });

  document.querySelectorAll('[data-external-url]').forEach((button) => {
    button.addEventListener('click', () => {
      vscode.postMessage({ command: 'openExternalUrl', value: button.dataset.externalUrl });
    });
  });

  document.querySelectorAll('[data-provider-clone]').forEach((button) => {
    button.addEventListener('click', () => {
      vscode.postMessage({ command: 'cloneRepository', value: button.dataset.providerClone });
    });
  });

  document.querySelectorAll('[data-provider-action]').forEach((button) => {
    button.addEventListener('click', () => {
      vscode.postMessage({ command: 'providerBridge', value: button.dataset.providerAction });
    });
  });

  document.querySelectorAll('[data-diff-path]').forEach((button) => {
    button.addEventListener('click', () => {
      vscode.postMessage({ command: 'openChangedFileDiff', value: button.dataset.diffPath });
    });
  });

  document.querySelectorAll('[data-conflict-path]').forEach((button) => {
    button.addEventListener('click', () => {
      vscode.postMessage({ command: 'openConflictFile', value: button.dataset.conflictPath });
    });
  });

  document.querySelectorAll('[data-delete-merged-branch]').forEach((button) => {
    button.addEventListener('click', () => {
      vscode.postMessage({ command: 'deleteMergedBranch', value: button.dataset.deleteMergedBranch });
    });
  });

  document.querySelectorAll('[data-rerun-action]').forEach((button) => {
    button.addEventListener('click', () => {
      vscode.postMessage({ command: 'rerunGitHubAction', value: button.dataset.rerunAction });
    });
  });

  document.querySelectorAll('[data-focus-action]').forEach((button) => {
    button.addEventListener('click', () => {
      vscode.postMessage({ command: 'focusTimerAction', value: button.dataset.focusAction });
    });
  });

  document.querySelectorAll('[data-debug-open]').forEach((button) => {
    button.addEventListener('click', () => {
      vscode.postMessage({ command: 'openDebugDiagnostic', value: button.dataset.debugOpen });
    });
  });

  document.querySelectorAll('[data-debug-fix]').forEach((button) => {
    button.addEventListener('click', () => {
      vscode.postMessage({ command: 'openDebugQuickFix', value: button.dataset.debugFix });
    });
  });

  document.querySelectorAll('[data-orchestrator-task]').forEach((button) => {
    button.addEventListener('click', () => {
      vscode.postMessage({ command: 'orchestratorRunTask', value: button.dataset.orchestratorTask });
    });
  });

  document.querySelectorAll('[data-run-workflow]').forEach((button) => {
    button.addEventListener('click', () => {
      vscode.postMessage({ command: 'orchestratorRunWorkflow', value: button.dataset.runWorkflow });
    });
  });

  document.querySelectorAll('[data-delete-workflow]').forEach((button) => {
    button.addEventListener('click', () => {
      vscode.postMessage({ command: 'orchestratorDeleteWorkflow', value: button.dataset.deleteWorkflow });
    });
  });

  document.querySelectorAll('[data-architecture-file]').forEach((button) => {
    button.addEventListener('click', () => {
      vscode.postMessage({
        command: 'openArchitectureFile',
        value: {
          file: button.dataset.architectureFile,
          line: Number(button.dataset.architectureLine || 1)
        }
      });
    });
  });

  document.querySelectorAll('[data-cp-problem]').forEach((button) => {
    button.addEventListener('click', () => {
      vscode.postMessage({ command: 'cpSwitchProblem', value: button.dataset.cpProblem });
    });
  });

  document.querySelectorAll('[data-cp-status]').forEach((button) => {
    button.addEventListener('click', () => {
      vscode.postMessage({ command: 'cpSetStatus', value: button.dataset.cpStatus });
    });
  });

  document.querySelectorAll('[data-cp-platform]').forEach((button) => {
    button.addEventListener('click', () => {
      vscode.postMessage({ command: 'cpPlatform', value: button.dataset.cpPlatform });
    });
  });

  document.querySelectorAll('[data-cp-run-sample]').forEach((button) => {
    button.addEventListener('click', () => {
      const input = document.getElementById('cpSampleInput')?.value || '';
      const expected = document.getElementById('cpSampleExpected')?.value || '';
      vscode.postMessage({
        command: 'cpRunSample',
        value: { input, expected }
      });
    });
  });

  document.querySelectorAll('[data-cp-run-multi]').forEach((button) => {
    button.addEventListener('click', () => {
      const input = document.getElementById('cpSampleInput')?.value || '';
      const expected = document.getElementById('cpSampleExpected')?.value || '';
      vscode.postMessage({
        command: 'cpRunMulti',
        value: { input, expected }
      });
    });
  });

  const cpFormatClock = (milliseconds) => {
    const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return hours
      ? [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':')
      : [minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
  };

  const cpContestClock = document.getElementById('cpContestClock');
  if (cpContestClock) {
    const running = cpContestClock.dataset.running === '1';
    const endAt = Number(cpContestClock.dataset.endAt || 0);
    const initialRemaining = Number(cpContestClock.dataset.remaining || 0);
    const updateCpContestClock = () => {
      const remaining = running && endAt
        ? Math.max(0, endAt - Date.now())
        : initialRemaining;
      cpContestClock.textContent = cpFormatClock(remaining);
    };
    updateCpContestClock();
    if (running && endAt) setInterval(updateCpContestClock, 1000);
  }

  const cpProblemClock = document.getElementById('cpProblemClock');
  if (cpProblemClock) {
    const running = cpProblemClock.dataset.running === '1';
    const baseMs = Number(cpProblemClock.dataset.currentMs || 0);
    const openedAt = Date.now();
    const updateCpProblemClock = () => {
      const value = running ? baseMs + Math.max(0, Date.now() - openedAt) : baseMs;
      cpProblemClock.textContent = cpFormatClock(value);
    };
    updateCpProblemClock();
    if (running) setInterval(updateCpProblemClock, 1000);
  }

  const focusClock = document.getElementById('galaxyFocusClock');
  if (focusClock) {
    const formatClock = (milliseconds) => {
      const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
    };

    const running = focusClock.dataset.running === '1';
    const endAt = Number(focusClock.dataset.endAt || 0);
    const initialRemaining = Number(focusClock.dataset.remaining || 0);

    const updateClock = () => {
      const remaining = running && endAt
        ? Math.max(0, endAt - Date.now())
        : initialRemaining;
      focusClock.textContent = formatClock(remaining);
    };

    updateClock();
    if (running && endAt) {
      setInterval(updateClock, 1000);
    }
  }
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
    case 'developerMode':
      return setDeveloperMode(context, value);
    case 'focusMode':
      if (context) {
        await context.globalState.update('galaxy.activeDeveloperMode', 'Focus');
      }
      return vscode.commands.executeCommand('workbench.action.toggleZenMode');
    case 'applyTheme':
      return applyTheme(value);
    case 'customizeDashboard':
      return customizeDashboardWidgets(context);
    case 'aiPrompt':
      return copyAiPrompt(value, context?.extensionUri);
    case 'copyLastAiPrompt':
      return copyLastAiPrompt();
    case 'openChat':
      return openAvailableChat();
    case 'openGalaxyExtension':
      return openGalaxyExtension(value);
    case 'searchGalaxyExtensions':
      return searchGalaxyExtensions();
    case 'editProjectNote':
      return editProjectNote(context, context?.extensionUri);
    case 'createSnapshot':
      return createWorkspaceSnapshot(context, context?.extensionUri);
    case 'restoreSnapshot':
      return restoreWorkspaceSnapshot(context, context?.extensionUri, value);
    case 'deleteSnapshot':
      return deleteWorkspaceSnapshot(context, context?.extensionUri, value);
    case 'connectGitHub':
      return connectGitHub();
    case 'refreshGitHub':
      githubStateCache = { at: 0, value: null };
      githubCollaborationCache = { key: '', at: 0, value: null };
      return true;
    case 'openGitHubRepository':
      return openGitHubRepository(value);
    case 'openExternalUrl':
      if (value) return vscode.env.openExternal(vscode.Uri.parse(value));
      return false;
    case 'createGitHubRepository':
      return Boolean(await createGitHubRepository());
    case 'publishCurrentProject':
      return publishCurrentProjectToGitHub(context?.extensionUri);
    case 'createGitHubIssue':
      return createGitHubIssue(context?.extensionUri);
    case 'createGitHubPullRequest':
      return createGitHubPullRequest(context?.extensionUri);
    case 'providerBridge':
      return runProviderBridge(value);
    case 'openChangedFileDiff':
      return openChangedFileDiff(context?.extensionUri, value);
    case 'openConflictFile':
      return openConflictFile(context?.extensionUri, value);
    case 'deleteMergedBranch':
      return deleteMergedBranch(context?.extensionUri, value);
    case 'createGitTag':
      return createGitTag(context?.extensionUri);
    case 'createDraftRelease':
      return createDraftGitHubRelease(context?.extensionUri);
    case 'rerunGitHubAction':
      return rerunGitHubAction(context?.extensionUri, value);
    case 'openPrReviewCenter':
      return openPullRequestReviewCenter(context?.extensionUri);
    case 'safeCommitPush':
      return safeCommitAndPush(context?.extensionUri);
    case 'setCodingGoal':
      return setDailyCodingGoal(context);
    case 'focusTimerAction':
      if (value === '25') return startFocusTimer(context, 25);
      if (value === '50') return startFocusTimer(context, 50);
      if (value === 'custom') return startCustomFocusTimer(context);
      if (value === 'pause') return pauseFocusTimer(context);
      if (value === 'resume') return resumeFocusTimer(context);
      if (value === 'stop') return stopFocusTimer(context);
      return false;
    case 'analyzeDebug':
      return analyzeLatestDiagnostic(context);
    case 'toggleAutoDebug':
      return toggleAutoDebugAnalyze(context);
    case 'copyDebugAnalysis':
      return copyDebugAnalysis();
    case 'openDebugDiagnostic':
      return openDebugDiagnostic(value);
    case 'openDebugQuickFix':
      return openDebugQuickFix(value);
    case 'runSmartProjectTask':
      return runSmartProjectTask(context, context?.extensionUri, value);
    case 'analyzeClipboardError':
      return analyzeClipboardError();
    case 'explainCurrentFileAi':
      return explainCurrentFileAi();
    case 'analyzeGitConflictAi':
      return analyzeFirstGitConflict(context?.extensionUri);
    case 'reviewStagedChangesAi':
      return reviewStagedChangesWithAi(context?.extensionUri);
    case 'copySmartAssistantResult':
      return copySmartAssistantResult();
    case 'generateDiagnosticFix':
      return generateDiagnosticFixProposal();
    case 'refactorSelectedCode':
      return refactorSelectedCodeProposal();
    case 'generateTestsProposal':
      return generateTestsProposal(context?.extensionUri);
    case 'reviewAiEditProposal':
      return reviewAiEditProposal();
    case 'applyAiEditProposal':
      return applyAiEditProposal(context, context?.extensionUri);
    case 'discardAiEditProposal':
      return discardAiEditProposal();
    case 'runQualityGate':
      return runQualityGate(context, context?.extensionUri);
    case 'scanDependencies':
      return scanDependencies(context?.extensionUri);
    case 'revertLastAiApply':
      return revertLastAiApply(context?.extensionUri);
    case 'smartCommitGate':
      return smartCommitGate(context, context?.extensionUri);
    case 'exportDeveloperAnalytics':
      return exportDeveloperAnalytics(context, context?.extensionUri);
    case 'architectureFindFeature':
      return findArchitectureFeature();
    case 'architectureExplainMatches':
      return explainArchitectureMatches();
    case 'refreshArchitecture':
      return refreshArchitectureState();
    case 'exportArchitectureJson':
      return exportArchitectureJson();
    case 'orchestratorRunTask':
      return runSingleWorkspaceTask(context, context?.extensionUri, value);
    case 'orchestratorCancel':
      return cancelTaskOrchestrator();
    case 'orchestratorVerify':
      return runVerifyPipeline(context, context?.extensionUri);
    case 'orchestratorShip':
      return runShipPipeline(context, context?.extensionUri);
    case 'orchestratorCreateWorkflow':
      return createSavedTaskWorkflow(context);
    case 'orchestratorRunWorkflow':
      return runSavedTaskWorkflow(context, context?.extensionUri, value);
    case 'orchestratorDeleteWorkflow':
      return deleteSavedTaskWorkflow(context, value);
    case 'openArchitectureFile':
      return openArchitectureFile(value);
    case 'cpStartContest':
      return startCpContestPrompt(context);
    case 'cpStopContest':
      return stopCpContestAction(context);
    case 'cpResetArena':
      return resetCpArenaAction(context);
    case 'cpSwitchProblem':
      return switchProblem(context, value);
    case 'cpSetStatus':
      return setProblemStatus(context, value);
    case 'cpRunSample':
      return runCpSampleAction(context, value);
    case 'cpRunMulti':
      return runCpMultiCaseAction(context, value);
    case 'cpStressTest':
      return runCpStressAction(context);
    case 'cpNewProblemFile':
      return createCpProblemFile(context);
    case 'cpSnippetVault':
      return openCpSnippetVault();
    case 'cpAiComplexity':
      return runCpAi('complexity');
    case 'cpAiEdgeCases':
      return runCpAi('edge-cases');
    case 'cpPanicAssist':
      return runCpPanicAssist();
    case 'cpFocusMode':
      return toggleCpFocusMode();
    case 'cpPlatform':
      return openCpPlatform(value);
    case 'cloneRepository':
      return cloneRepository(value);
    case 'initializeRepository':
      return initializeRepository(context?.extensionUri);
    case 'manageOrigin':
      return manageOrigin(context?.extensionUri);
    case 'createBranch':
      return createBranch(context?.extensionUri);
    case 'switchBranch':
      return switchBranch(context?.extensionUri);
    case 'commitChanges':
      return commitStagedChanges(context?.extensionUri);
    case 'openRemoteRepository':
      return openRemoteRepository(context?.extensionUri);
    case 'runTerminal': {
      await recordCommand(context, value);
      const terminal = createWorkspaceTerminal('Galaxy Command Center');
      terminal.show();
      terminal.sendText(value, true);
      return;
    }
    case 'runVsCodeCommand':
      sessionCommandCount++;
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
      const vscodeGitCommands = {
        fetch: 'git.fetch',
        pull: 'git.pull',
        push: 'git.push',
        sync: 'git.sync'
      };

      const fallbackCommands = {
        fetch: 'git fetch --all --prune',
        pull: 'git pull',
        push: 'git push',
        stageAll: 'git add -A',
        unstageAll: 'git reset'
      };

      if (vscodeGitCommands[value]) {
        const available = await vscode.commands.getCommands(true);
        const vscodeGitCommand = vscodeGitCommands[value];
        if (available.includes(vscodeGitCommand)) {
          await recordCommand(context, `VS Code Git: ${value}`);
          return vscode.commands.executeCommand(vscodeGitCommand);
        }
      }

      if (value === 'sync') {
        await recordCommand(context, 'git pull → git push');
        const root = getWorkspaceRoot(context?.extensionUri);
        if (!root) return;
        const pulled = runGitLocal(root, ['pull'], '');
        if (pulled === null) return;
        runGitLocal(root, ['push'], 'Git sync complete.');
        return;
      }

      const gitCommand = fallbackCommands[value];
      if (!gitCommand) return;
      await recordCommand(context, gitCommand);
      const terminal = createWorkspaceTerminal('Galaxy Git');
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


function updateGalaxyStatusBar(context, statusItem) {
  if (!statusItem) return;

  const history = getCodingHistoryState(context);
  const timer = getFocusTimerState(context);

  if (timer.running && timer.remainingMs > 0) {
    statusItem.text = '$(clock) Galaxy ' + formatTimerClock(timer.remainingMs);
    statusItem.tooltip =
      'Focus timer running · Today ' + history.activeText +
      ' / ' + history.goalText;
    return;
  }

  statusItem.text =
    '$(rocket) Galaxy ' + history.activeText + '/' + history.goalText;
  statusItem.tooltip =
    'Today coding goal: ' + history.goalPercent + '% complete';
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
    captureEditorContext(vscode.window.activeTextEditor, false);

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

    dashboardRenderCallback = render;

    panel.onDidDispose(() => {
      if (dashboardRenderCallback === render) {
        dashboardRenderCallback = null;
      }
    });

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
        message.command === 'clearHistory' ||
        message.command === 'developerMode' ||
        message.command === 'focusMode' ||
        message.command === 'applyTheme' ||
        message.command === 'customizeDashboard' ||
        message.command === 'aiPrompt' ||
        message.command === 'editProjectNote' ||
        message.command === 'createSnapshot' ||
        message.command === 'restoreSnapshot' ||
        message.command === 'deleteSnapshot' ||
        message.command === 'connectGitHub' ||
        message.command === 'refreshGitHub' ||
        message.command === 'initializeRepository' ||
        message.command === 'manageOrigin' ||
        message.command === 'createBranch' ||
        message.command === 'switchBranch' ||
        message.command === 'commitChanges' ||
        message.command === 'gitAction' ||
        message.command === 'createGitHubRepository' ||
        message.command === 'publishCurrentProject' ||
        message.command === 'createGitHubIssue' ||
        message.command === 'createGitHubPullRequest' ||
        message.command === 'deleteMergedBranch' ||
        message.command === 'createGitTag' ||
        message.command === 'createDraftRelease' ||
        message.command === 'rerunGitHubAction' ||
        message.command === 'safeCommitPush' ||
        message.command === 'setCodingGoal' ||
        message.command === 'focusTimerAction' ||
        message.command === 'analyzeDebug' ||
        message.command === 'toggleAutoDebug' ||
        message.command === 'runSmartProjectTask' ||
        message.command === 'analyzeClipboardError' ||
        message.command === 'explainCurrentFileAi' ||
        message.command === 'analyzeGitConflictAi' ||
        message.command === 'reviewStagedChangesAi' ||
        message.command === 'generateDiagnosticFix' ||
        message.command === 'refactorSelectedCode' ||
        message.command === 'generateTestsProposal' ||
        message.command === 'applyAiEditProposal' ||
        message.command === 'discardAiEditProposal' ||
        message.command === 'runQualityGate' ||
        message.command === 'scanDependencies' ||
        message.command === 'revertLastAiApply' ||
        message.command === 'smartCommitGate' ||
        message.command === 'architectureFindFeature' ||
        message.command === 'architectureExplainMatches' ||
        message.command === 'refreshArchitecture' ||
        message.command === 'orchestratorRunTask' ||
        message.command === 'orchestratorCancel' ||
        message.command === 'orchestratorVerify' ||
        message.command === 'orchestratorShip' ||
        message.command === 'orchestratorCreateWorkflow' ||
        message.command === 'orchestratorRunWorkflow' ||
        message.command === 'orchestratorDeleteWorkflow' ||
        message.command === 'runTerminal' ||
        message.command === 'runVsCodeCommand' ||
        message.command === 'cpStartContest' ||
        message.command === 'cpStopContest' ||
        message.command === 'cpResetArena' ||
        message.command === 'cpSwitchProblem' ||
        message.command === 'cpSetStatus' ||
        message.command === 'cpRunSample' ||
        message.command === 'cpRunMulti' ||
        message.command === 'cpStressTest' ||
        message.command === 'cpNewProblemFile' ||
        message.command === 'cpAiComplexity' ||
        message.command === 'cpAiEdgeCases' ||
        message.command === 'cpPanicAssist'
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
  await migrateRecurringErrorPrivacy(context);
  captureEditorContext(vscode.window.activeTextEditor, true);
  activeDiagnosticSignatures = new Set(
    collectDebugDiagnostics()
      .filter((item) => item.severity === 'Error')
      .map((item) => diagnosticSignature(item))
  );

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((event) => {
      captureEditorContext(event.textEditor, true);
      lastCodingActivityAt = Date.now();
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      captureEditorContext(editor, true);
      lastCodingActivityAt = Date.now();
      if (editor?.document?.uri?.scheme === 'file') {
        sessionTouchedFiles.add(editor.document.uri.fsPath);
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.scheme === 'file' && event.contentChanges.length) {
        sessionTouchedFiles.add(event.document.uri.fsPath);
        lastCodingActivityAt = Date.now();
        void recordCodingEdit(context, event.document);
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.uri.scheme === 'file') {
        sessionTouchedFiles.add(document.uri.fsPath);
        sessionSaveCount++;
        lastCodingActivityAt = Date.now();
        void recordCodingSave(context, document);
      }
    })
  );

  if (vscode.window.activeTextEditor?.document?.uri?.scheme === 'file') {
    sessionTouchedFiles.add(vscode.window.activeTextEditor.document.uri.fsPath);
  }

  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      galaxyWindowFocused = state.focused;
      if (state.focused) lastCodingActivityAt = Date.now();
    })
  );

  context.subscriptions.push(
    vscode.languages.onDidChangeDiagnostics(() => {
      scheduleAutoDebug(context);
      void updateErrorRecurrence(context);
    })
  );

  await rememberCurrentProject(context);

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      await rememberCurrentProject(context);
    })
  );

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      'galaxy-ai-preview',
      new GalaxyAiPreviewProvider()
    )
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
    vscode.commands.registerCommand('galaxyCommandCenter.customize', async () => {
      const changed = await customizeDashboardWidgets(context);
      if (changed) {
        vscode.window.showInformationMessage('Galaxy dashboard widget layout updated.');
      }
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

  updateGalaxyStatusBar(context, statusItem);

  const galaxyHeartbeat = setInterval(() => {
    const now = Date.now();
    const elapsed = Math.min(30000, Math.max(0, now - lastCodingTickAt));
    lastCodingTickAt = now;

    void recordCodingActivity(context, elapsed);
    void checkFocusTimerCompletion(context);
    void checkCpContestCompletion(context);
    updateGalaxyStatusBar(context, statusItem);
  }, 15000);

  context.subscriptions.push({
    dispose() {
      clearInterval(galaxyHeartbeat);
      if (autoDebugTimer) clearTimeout(autoDebugTimer);
    }
  });

  if (context.extensionMode === vscode.ExtensionMode.Development) {
    await openDashboard(context);
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
