const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { getWorkspaceRoot } = require('../core/workspace');

const PROBLEM_LABELS = ['A','B','C','D','E','F','G','H'];
const VALID_STATUSES = ['NOT STARTED','SOLVING','WA','TLE','RE','AC'];

function cpWorkspaceKey() {
  return getWorkspaceRoot() || '__no_workspace__';
}

function defaultProblems() {
  return Object.fromEntries(
    PROBLEM_LABELS.map((label) => [
      label,
      { status: 'NOT STARTED', activeMs: 0, attempts: 0 }
    ])
  );
}

function defaultSession() {
  return {
    contest: {
      running: false,
      durationMinutes: 120,
      startedAt: 0,
      endAt: 0,
      remainingMs: 0
    },
    currentProblem: 'A',
    problemStartedAt: 0,
    problems: defaultProblems(),
    lastRun: null
  };
}

function normalizeSession(session) {
  const base = defaultSession();
  const value = session && typeof session === 'object' ? session : {};
  const problems = { ...base.problems };

  for (const label of PROBLEM_LABELS) {
    const item = value.problems?.[label] || {};
    problems[label] = {
      status: VALID_STATUSES.includes(item.status) ? item.status : 'NOT STARTED',
      activeMs: Math.max(0, Number(item.activeMs || 0)),
      attempts: Math.max(0, Number(item.attempts || 0))
    };
  }

  return {
    contest: {
      ...base.contest,
      ...(value.contest || {})
    },
    currentProblem: PROBLEM_LABELS.includes(value.currentProblem)
      ? value.currentProblem
      : 'A',
    problemStartedAt: Math.max(0, Number(value.problemStartedAt || 0)),
    problems,
    lastRun: value.lastRun || null
  };
}

function getAllCpSessions(context) {
  return context?.globalState.get('galaxy.cpArenaSessions', {}) || {};
}

function getStoredSession(context) {
  const all = getAllCpSessions(context);
  return normalizeSession(all[cpWorkspaceKey()]);
}

async function saveSession(context, session) {
  if (!context) return;
  const all = getAllCpSessions(context);
  all[cpWorkspaceKey()] = normalizeSession(session);
  await context.globalState.update('galaxy.cpArenaSessions', all);
}

function liveProblemMs(session, label, now = Date.now()) {
  const problem = session.problems[label];
  let value = Number(problem.activeMs || 0);
  if (
    session.contest.running &&
    session.currentProblem === label &&
    session.problemStartedAt
  ) {
    const effectiveNow = session.contest.endAt
      ? Math.min(now, Number(session.contest.endAt))
      : now;
    value += Math.max(0, effectiveNow - session.problemStartedAt);
  }
  return value;
}

function formatCpDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) {
    return [hours, minutes, seconds]
      .map((value) => String(value).padStart(2, '0'))
      .join(':');
  }
  return [minutes, seconds]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

function getCpArenaState(context) {
  const session = getStoredSession(context);
  const now = Date.now();

  let remainingMs = Number(session.contest.remainingMs || 0);
  if (session.contest.running && session.contest.endAt) {
    remainingMs = Math.max(0, Number(session.contest.endAt) - now);
  }

  const problems = PROBLEM_LABELS.map((label) => ({
    label,
    status: session.problems[label].status,
    attempts: session.problems[label].attempts,
    activeMs: liveProblemMs(session, label, now),
    activeText: formatCpDuration(liveProblemMs(session, label, now)),
    current: session.currentProblem === label
  }));

  return {
    ...session,
    contest: {
      ...session.contest,
      remainingMs,
      remainingText: formatCpDuration(remainingMs)
    },
    problems,
    solved: problems.filter((item) => item.status === 'AC').length,
    total: problems.length,
    currentProblemTime: formatCpDuration(
      liveProblemMs(session, session.currentProblem, now)
    )
  };
}

async function startNewContest(context, durationMinutes = 120) {
  const minutes = Math.max(1, Math.min(720, Number(durationMinutes || 120)));
  const now = Date.now();
  const session = defaultSession();

  session.contest = {
    running: true,
    durationMinutes: minutes,
    startedAt: now,
    endAt: now + minutes * 60000,
    remainingMs: minutes * 60000
  };
  session.currentProblem = 'A';
  session.problemStartedAt = now;
  session.problems.A.status = 'SOLVING';

  await saveSession(context, session);
  return session;
}

async function stopContest(context) {
  const session = getStoredSession(context);
  const now = Date.now();

  if (session.contest.running && session.problemStartedAt) {
    const current = session.problems[session.currentProblem];
    const effectiveNow = session.contest.endAt
      ? Math.min(now, Number(session.contest.endAt))
      : now;
    current.activeMs += Math.max(0, effectiveNow - session.problemStartedAt);
  }

  const remainingMs = session.contest.endAt
    ? Math.max(0, session.contest.endAt - now)
    : Number(session.contest.remainingMs || 0);

  session.contest.running = false;
  session.contest.endAt = 0;
  session.contest.remainingMs = remainingMs;
  session.problemStartedAt = 0;

  await saveSession(context, session);
  return session;
}

async function switchProblem(context, label) {
  if (!PROBLEM_LABELS.includes(label)) return false;

  const session = getStoredSession(context);
  const now = Date.now();
  const previous = session.currentProblem;

  if (
    session.contest.running &&
    session.problemStartedAt &&
    previous &&
    session.problems[previous]
  ) {
    session.problems[previous].activeMs += Math.max(
      0,
      now - session.problemStartedAt
    );
  }

  session.currentProblem = label;
  if (session.problems[label].status === 'NOT STARTED') {
    session.problems[label].status = 'SOLVING';
  }
  session.problemStartedAt = session.contest.running ? now : 0;

  await saveSession(context, session);
  return true;
}

async function setProblemStatus(context, status) {
  if (!VALID_STATUSES.includes(status)) return false;

  const session = getStoredSession(context);
  const problem = session.problems[session.currentProblem];
  if (!problem) return false;

  problem.status = status;
  if (['WA','TLE','RE'].includes(status)) {
    problem.attempts += 1;
  }

  await saveSession(context, session);
  return true;
}

async function resetCpSession(context) {
  await saveSession(context, defaultSession());
}

function normalizeOutput(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/g, ''))
    .join('\n')
    .trim();
}

function runProcessWithInput(command, args, cwd, input, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let settled = false;

    let child;
    try {
      child = spawn(command, args, {
        cwd,
        windowsHide: true,
        shell: false,
        env: process.env
      });
    } catch (error) {
      resolve({
        exitCode: -1,
        stdout: '',
        stderr: error.message || String(error),
        timedOut: false,
        runtimeMs: Date.now() - started
      });
      return;
    }

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve({ ...result, runtimeMs: Date.now() - started });
    };

    const append = (current, chunk) => {
      const next = current + String(chunk || '');
      return next.length > 20000 ? next.slice(-20000) : next;
    };

    child.stdout?.on('data', (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = append(stderr, chunk);
    });

    child.on('error', (error) => {
      finish({
        exitCode: -1,
        stdout,
        stderr: append(stderr, error.message || String(error)),
        timedOut: false
      });
    });

    child.on('close', (code) => {
      finish({
        exitCode: Number.isInteger(code) ? code : -1,
        stdout,
        stderr,
        timedOut: false
      });
    });

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish({
        exitCode: -1,
        stdout,
        stderr: append(stderr, '\n[Galaxy CP] Time limit exceeded.'),
        timedOut: true
      });
    }, timeoutMs);

    child.on('exit', () => clearTimeout(timer));

    try {
      child.stdin?.write(String(input || ''));
      child.stdin?.end();
    } catch {}
  });
}

async function compileNative(filePath, language) {
  const tempBase = path.join(
    os.tmpdir(),
    'galaxy-cp-' + process.pid + '-' + Date.now()
  );
  const outputPath = process.platform === 'win32'
    ? tempBase + '.exe'
    : tempBase;

  const isC = language === 'c';
  const compiler = isC ? 'gcc' : 'g++';
  const standard = isC ? '-std=c17' : '-std=c++17';

  const result = await runProcessWithInput(
    compiler,
    [filePath, standard, '-O2', '-pipe', '-o', outputPath],
    path.dirname(filePath),
    '',
    20000
  );

  return { ...result, outputPath, compiler };
}

async function runCurrentFile(document, input, expectedOutput) {
  if (!document || document.uri.scheme !== 'file') {
    return {
      verdict: 'NO FILE',
      runtimeMs: 0,
      stdout: '',
      stderr: 'Open a local source file first.',
      expected: expectedOutput || ''
    };
  }

  const filePath = document.uri.fsPath;
  const cwd = path.dirname(filePath);
  const language = document.languageId;
  let result;
  let compiledPath = '';

  try {
    if (language === 'cpp' || language === 'c') {
      const compile = await compileNative(filePath, language);
      compiledPath = compile.outputPath;
      if (compile.exitCode !== 0 || compile.timedOut) {
        return {
          verdict: 'COMPILE ERROR',
          runtimeMs: compile.runtimeMs,
          stdout: compile.stdout,
          stderr: compile.stderr,
          expected: expectedOutput || ''
        };
      }
      result = await runProcessWithInput(
        compiledPath,
        [],
        cwd,
        input,
        5000
      );
    } else if (language === 'python') {
      const python = process.platform === 'win32' ? 'python' : 'python3';
      result = await runProcessWithInput(
        python,
        [filePath],
        cwd,
        input,
        5000
      );
      if (result.exitCode === -1 && /ENOENT|not found/i.test(result.stderr)) {
        result = await runProcessWithInput(
          process.platform === 'win32' ? 'py' : 'python',
          [filePath],
          cwd,
          input,
          5000
        );
      }
    } else if (language === 'javascript') {
      result = await runProcessWithInput(
        process.execPath,
        [filePath],
        cwd,
        input,
        5000
      );
    } else {
      return {
        verdict: 'UNSUPPORTED',
        runtimeMs: 0,
        stdout: '',
        stderr:
          'Sample Runner currently supports C/C++, Python, and JavaScript.',
        expected: expectedOutput || ''
      };
    }

    let verdict = 'PASS';
    if (result.timedOut) verdict = 'TLE';
    else if (result.exitCode !== 0) verdict = 'RUNTIME ERROR';
    else if (
      String(expectedOutput || '').trim() &&
      normalizeOutput(result.stdout) !== normalizeOutput(expectedOutput)
    ) {
      verdict = 'WRONG ANSWER';
    }

    return {
      verdict,
      runtimeMs: result.runtimeMs,
      stdout: result.stdout,
      stderr: result.stderr,
      expected: expectedOutput || '',
      language
    };
  } finally {
    if (compiledPath) {
      try {
        fs.unlinkSync(compiledPath);
      } catch {}
    }
  }
}

async function saveLastRun(context, run) {
  const session = getStoredSession(context);
  session.lastRun = {
    ...run,
    at: Date.now(),
    problem: session.currentProblem
  };
  await saveSession(context, session);
}

const SNIPPETS = {
  cpp: [
    {
      label: 'C++ Fast I/O',
      detail: 'ios::sync_with_stdio(false)',
      code: 'ios::sync_with_stdio(false);\ncin.tie(nullptr);'
    },
    {
      label: 'C++ Binary Search',
      detail: 'lower_bound style manual binary search',
      code:
        'int lo = 0, hi = n - 1, ans = -1;\n' +
        'while (lo <= hi) {\n' +
        '    int mid = lo + (hi - lo) / 2;\n' +
        '    if (/* condition */) { ans = mid; hi = mid - 1; }\n' +
        '    else lo = mid + 1;\n' +
        '}'
    },
    {
      label: 'C++ BFS',
      detail: 'queue-based graph traversal',
      code:
        'queue<int> q;\nvector<int> dist(n, -1);\n' +
        'q.push(src); dist[src] = 0;\n' +
        'while (!q.empty()) {\n' +
        '    int u = q.front(); q.pop();\n' +
        '    for (int v : g[u]) if (dist[v] == -1) {\n' +
        '        dist[v] = dist[u] + 1;\n        q.push(v);\n    }\n}'
    },
    {
      label: 'C++ DSU',
      detail: 'disjoint set union with path compression',
      code:
        'struct DSU {\n' +
        '    vector<int> p, sz;\n' +
        '    DSU(int n): p(n), sz(n, 1) { iota(p.begin(), p.end(), 0); }\n' +
        '    int find(int x) { return p[x] == x ? x : p[x] = find(p[x]); }\n' +
        '    bool unite(int a, int b) {\n' +
        '        a = find(a); b = find(b);\n' +
        '        if (a == b) return false;\n' +
        '        if (sz[a] < sz[b]) swap(a, b);\n' +
        '        p[b] = a; sz[a] += sz[b];\n' +
        '        return true;\n    }\n};'
    },
    {
      label: 'C++ Dijkstra',
      detail: 'shortest paths with priority_queue',
      code:
        'const long long INF = (1LL << 62);\n' +
        'vector<long long> dist(n, INF);\n' +
        'priority_queue<pair<long long,int>, vector<pair<long long,int>>, greater<pair<long long,int>>> pq;\n' +
        'dist[src] = 0; pq.push({0, src});\n' +
        'while (!pq.empty()) {\n' +
        '    auto [d, u] = pq.top(); pq.pop();\n' +
        '    if (d != dist[u]) continue;\n' +
        '    for (auto [v, w] : g[u]) if (dist[v] > d + w) {\n' +
        '        dist[v] = d + w;\n        pq.push({dist[v], v});\n    }\n}'
    },
    {
      label: 'C++ Prefix Sum',
      detail: '1-indexed prefix sum',
      code:
        'vector<long long> pref(n + 1);\n' +
        'for (int i = 0; i < n; ++i) pref[i + 1] = pref[i] + a[i];\n' +
        '// sum [l, r] = pref[r + 1] - pref[l];'
    }
  ],
  python: [
    {
      label: 'Python Fast Input',
      detail: 'sys.stdin.readline',
      code: 'import sys\ninput = sys.stdin.readline'
    },
    {
      label: 'Python BFS',
      detail: 'deque-based traversal',
      code:
        'from collections import deque\n' +
        'q = deque([src])\ndist = [-1] * n\ndist[src] = 0\n' +
        'while q:\n    u = q.popleft()\n' +
        '    for v in g[u]:\n        if dist[v] == -1:\n' +
        '            dist[v] = dist[u] + 1\n            q.append(v)'
    },
    {
      label: 'Python Prefix Sum',
      detail: 'accumulate values',
      code:
        'pref = [0]\nfor x in a:\n    pref.append(pref[-1] + x)\n' +
        '# sum [l, r] = pref[r + 1] - pref[l]'
    }
  ]
};

function getCpSnippets(languageId) {
  if (languageId === 'python') return SNIPPETS.python;
  return SNIPPETS.cpp;
}

module.exports = {
  PROBLEM_LABELS,
  VALID_STATUSES,
  formatCpDuration,
  getCpArenaState,
  startNewContest,
  stopContest,
  switchProblem,
  setProblemStatus,
  resetCpSession,
  runCurrentFile,
  saveLastRun,
  getCpSnippets
};
