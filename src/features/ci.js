const fs = require('fs');
const path = require('path');
const { runGit } = require('../core/git');

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function parseWorkflowScripts(text) {
  const refs = new Set();
  const patterns = [
    /\bnpm(?:\.cmd)?\s+run\s+([\w:.-]+)/gi,
    /\bpnpm(?:\.cmd)?\s+(?:run\s+)?([\w:.-]+)/gi,
    /\byarn(?:\.cmd)?\s+(?:run\s+)?([\w:.-]+)/gi
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(String(text || '')))) {
      refs.add(match[1]);
    }
  }

  if (/\bnpm(?:\.cmd)?\s+test\b/i.test(text)) refs.add('test');
  return Array.from(refs).sort();
}

function parseWorkflowJobs(text) {
  const jobs = [];
  const lines = String(text || '').split(/\r?\n/);
  let inJobs = false;

  for (const line of lines) {
    if (/^jobs:\s*(?:#.*)?$/i.test(line.trimEnd())) {
      inJobs = true;
      continue;
    }

    if (inJobs && /^\S/.test(line) && !/^\s/.test(line)) {
      break;
    }

    if (!inJobs) continue;
    const match = line.match(/^\s{2}([A-Za-z0-9_-]+):\s*(?:#.*)?$/);
    if (match) jobs.push(match[1]);
  }

  return Array.from(new Set(jobs)).slice(0, 30);
}

function parseWorkflowName(text, fallback) {
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^name:\s*(.+?)\s*$/);
    if (!match) continue;
    const value = match[1].replace(/^['"]|['"]$/g, '').trim();
    if (value) return value;
  }
  return fallback;
}

function detectLocalWorkflows(root) {
  if (!root) return [];
  const dir = path.join(root, '.github', 'workflows');
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 40)
    .map((entry) => {
      const absolute = path.join(dir, entry.name);
      const text = readText(absolute);
      return {
        file: '.github/workflows/' + entry.name,
        name: parseWorkflowName(text, entry.name.replace(/\.ya?ml$/i, '')),
        jobs: parseWorkflowJobs(text),
        scriptRefs: parseWorkflowScripts(text)
      };
    });
}

function normalizeCiStatus(run) {
  const raw = String(run?.conclusion || run?.status || '').toLowerCase();

  if (['success', 'neutral', 'skipped'].includes(raw)) return 'PASS';
  if (
    ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']
      .includes(raw)
  ) {
    return 'FAIL';
  }
  if (
    ['queued', 'requested', 'waiting', 'pending', 'in_progress']
      .includes(raw)
  ) {
    return 'RUNNING';
  }
  return 'UNKNOWN';
}

function normalizeBranchProtection(raw, options = {}) {
  if (!raw || typeof raw !== 'object') {
    return {
      available: options.available === true,
      protected: false,
      requiresPullRequest: false,
      requiredReviews: 0,
      requiredStatusChecks: [],
      enforceAdmins: false,
      restrictPushes: false,
      error: String(options.error || '')
    };
  }

  const reviewRule = raw.required_pull_request_reviews || null;
  const statusRule = raw.required_status_checks || null;
  const contexts = Array.isArray(statusRule?.contexts)
    ? statusRule.contexts
    : Array.isArray(statusRule?.checks)
      ? statusRule.checks.map((item) => item?.context).filter(Boolean)
      : [];

  return {
    available: true,
    protected: true,
    requiresPullRequest: Boolean(reviewRule),
    requiredReviews: Math.max(
      0,
      Number(reviewRule?.required_approving_review_count || 0)
    ),
    requiredStatusChecks: Array.from(new Set(contexts.map(String))).slice(0, 30),
    enforceAdmins: Boolean(raw.enforce_admins?.enabled),
    restrictPushes: Boolean(raw.restrictions),
    error: ''
  };
}

function summarizeCiRuns(runs, branch, localHeadSha = '') {
  const items = (Array.isArray(runs) ? runs : [])
    .filter((run) => !branch || run.head_branch === branch)
    .map((run) => ({
      id: String(run.id || ''),
      name: run.name || run.display_title || 'Workflow',
      branch: run.head_branch || '',
      headSha: run.head_sha || '',
      status: normalizeCiStatus(run),
      rawStatus: run.conclusion || run.status || 'unknown',
      event: run.event || '',
      url: run.html_url || '',
      createdAt: run.created_at || '',
      updatedAt: run.updated_at || ''
    }));

  const latest = items[0] || null;
  const currentHeadRun =
    (localHeadSha && items.find((item) => item.headSha === localHeadSha)) || null;

  const status = currentHeadRun?.status || latest?.status || 'UNKNOWN';
  return {
    runs: items.slice(0, 10),
    latest,
    currentHeadRun,
    status,
    currentHeadCovered: Boolean(currentHeadRun)
  };
}

function mapCiScripts(workflows, discovery) {
  const available = new Set(
    (discovery?.tasks || []).map((task) => String(task.name || ''))
  );
  const referenced = Array.from(
    new Set(
      (workflows || []).flatMap((workflow) =>
        Array.isArray(workflow.scriptRefs) ? workflow.scriptRefs : []
      )
    )
  ).sort();

  return {
    referenced,
    mapped: referenced.filter((name) => available.has(name)),
    missingLocal: referenced.filter((name) => !available.has(name)),
    localNotInCi: Array.from(available)
      .filter((name) => !referenced.includes(name))
      .sort()
  };
}

function getGitPushState(root) {
  if (!root || runGit(root, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
    return {
      isGitRepo: false,
      branch: '',
      headSha: '',
      upstream: '',
      ahead: 0,
      behind: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicts: 0,
      clean: false,
      hasCommitsToPush: false
    };
  }

  const branch = runGit(root, ['branch', '--show-current']);
  const headSha = runGit(root, ['rev-parse', 'HEAD']);
  const upstream = runGit(
    root,
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']
  );

  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const counts = runGit(
      root,
      ['rev-list', '--left-right', '--count', 'HEAD...@{u}']
    ).split(/\s+/);
    ahead = Number(counts[0] || 0);
    behind = Number(counts[1] || 0);
  }

  const status = runGit(root, ['status', '--porcelain=v1'])
    .split(/\r?\n/)
    .filter(Boolean);

  let staged = 0;
  let unstaged = 0;
  let untracked = 0;

  for (const line of status) {
    if (line.startsWith('??')) {
      untracked++;
      continue;
    }
    if ((line[0] || ' ') !== ' ') staged++;
    if ((line[1] || ' ') !== ' ') unstaged++;
  }

  const conflicts = runGit(root, ['diff', '--name-only', '--diff-filter=U'])
    .split(/\r?\n/)
    .filter(Boolean).length;

  return {
    isGitRepo: true,
    branch,
    headSha,
    upstream,
    ahead,
    behind,
    staged,
    unstaged,
    untracked,
    conflicts,
    clean: status.length === 0 && conflicts === 0,
    hasCommitsToPush: upstream ? ahead > 0 : Boolean(headSha)
  };
}

function evaluatePushReadiness({
  git,
  quality,
  orchestrator,
  ci,
  branchProtection = null,
  workflows = [],
  qualityFingerprintCurrent = false,
  now = Date.now()
} = {}) {
  const reasons = [];
  const checks = [];

  const add = (id, label, status, detail = '') => {
    checks.push({ id, label, status, detail });
    if (status === 'BLOCK') reasons.push(detail || label);
  };

  if (!git?.isGitRepo) {
    add('git', 'Git repository', 'BLOCK', 'Workspace is not a Git repository.');
  } else {
    add('git', 'Git repository', 'PASS', git.branch || 'Git repository detected.');
  }

  if (git?.conflicts > 0) {
    add('conflicts', 'Merge conflicts', 'BLOCK', git.conflicts + ' unresolved conflict(s).');
  } else {
    add('conflicts', 'Merge conflicts', 'PASS', 'No unresolved conflicts.');
  }

  if (git?.behind > 0) {
    add('behind', 'Upstream sync', 'BLOCK', 'Branch is behind upstream by ' + git.behind + ' commit(s).');
  } else if (!git?.upstream) {
    add('behind', 'Upstream sync', 'REVIEW', 'No upstream branch is configured.');
  } else {
    add('behind', 'Upstream sync', 'PASS', 'Branch is not behind upstream.');
  }

  const dirtyCount =
    Number(git?.staged || 0) +
    Number(git?.unstaged || 0) +
    Number(git?.untracked || 0);

  if (dirtyCount > 0) {
    add('working-tree', 'Working tree', 'REVIEW', dirtyCount + ' uncommitted change(s) remain.');
  } else {
    add('working-tree', 'Working tree', 'PASS', 'Working tree is clean.');
  }

  if (!git?.hasCommitsToPush) {
    add('ahead', 'Commits to push', 'REVIEW', 'No local commit is ahead of upstream.');
  } else {
    add('ahead', 'Commits to push', 'PASS', String(git?.ahead || 1) + ' commit(s) ready to push.');
  }

  if (branchProtection?.available === false && branchProtection?.error) {
    add(
      'branch-protection',
      'Branch protection',
      'REVIEW',
      'Branch protection status is unavailable: ' + branchProtection.error
    );
  } else if (branchProtection?.protected) {
    if (branchProtection.requiresPullRequest) {
      add(
        'branch-protection',
        'Branch protection',
        'REVIEW',
        'Protected branch requires a pull request before merge.'
      );
    } else {
      add(
        'branch-protection',
        'Branch protection',
        'PASS',
        'Protected branch detected; direct-push restrictions will still be enforced by GitHub.'
      );
    }
  } else if (branchProtection?.available) {
    add(
      'branch-protection',
      'Branch protection',
      'PASS',
      'No branch protection rule is reported for the current branch.'
    );
  }

  const qualityFresh =
    quality?.status === 'READY' &&
    Boolean(qualityFingerprintCurrent) &&
    Number(quality?.lastRunAt || 0) > 0 &&
    now - Number(quality.lastRunAt) < 30 * 60 * 1000;

  if (qualityFresh) {
    add('quality', 'Quality Gate', 'PASS', 'Quality Gate is READY for the current HEAD/staged state.');
  } else if (quality?.status === 'BLOCKED') {
    add('quality', 'Quality Gate', 'BLOCK', 'Quality Gate is BLOCKED.');
  } else {
    add('quality', 'Quality Gate', 'REVIEW', 'Run Quality Gate for the current Git state.');
  }

  if (orchestrator?.passed === false && !orchestrator?.cancelled) {
    add('local-tasks', 'Local task pipeline', 'BLOCK', 'Latest task workflow failed.');
  } else if (orchestrator?.passed === true) {
    add('local-tasks', 'Local task pipeline', 'PASS', 'Latest task workflow passed.');
  } else {
    add('local-tasks', 'Local task pipeline', 'REVIEW', 'No successful task workflow is recorded in this session.');
  }

  if (!workflows.length) {
    add('ci', 'CI workflows', 'REVIEW', 'No local GitHub Actions workflow was detected.');
  } else if (ci?.error) {
    add('ci', 'GitHub Actions', 'REVIEW', ci.error);
  } else if (ci?.status === 'FAIL') {
    add('ci', 'GitHub Actions', 'BLOCK', 'Latest relevant GitHub Actions run failed.');
  } else if (ci?.status === 'RUNNING') {
    add('ci', 'GitHub Actions', 'REVIEW', 'GitHub Actions is still running.');
  } else if (ci?.status === 'PASS') {
    add(
      'ci',
      'GitHub Actions',
      'PASS',
      ci.currentHeadCovered
        ? 'Current HEAD passed GitHub Actions.'
        : 'Latest branch CI passed; local ahead commits will be tested after push.'
    );
  } else {
    add('ci', 'GitHub Actions', 'REVIEW', 'No relevant GitHub Actions result is available.');
  }

  const hasBlock = checks.some((item) => item.status === 'BLOCK');
  const hasReview = checks.some((item) => item.status === 'REVIEW');

  return {
    verdict: hasBlock ? 'BLOCKED' : hasReview ? 'REVIEW' : 'READY',
    checks,
    reasons
  };
}

module.exports = {
  detectLocalWorkflows,
  parseWorkflowScripts,
  parseWorkflowJobs,
  normalizeCiStatus,
  normalizeBranchProtection,
  summarizeCiRuns,
  mapCiScripts,
  getGitPushState,
  evaluatePushReadiness
};
