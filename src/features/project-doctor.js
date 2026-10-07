const fs = require('fs');
const path = require('path');

const SENSITIVE_NAMES = [
  '.env',
  '.env.local',
  '.env.production',
  '.npmrc',
  '.pypirc',
  'id_rsa',
  'id_ed25519'
];

function exists(root, relative) {
  try {
    return fs.existsSync(path.join(root, relative));
  } catch {
    return false;
  }
}

function readJson(root, relative) {
  try {
    return {
      value: JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8')),
      error: ''
    };
  } catch (error) {
    return {
      value: null,
      error: error?.message || 'Unable to parse JSON.'
    };
  }
}

function listRootFiles(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function detectPackageManagerFromSignals(signals) {
  if (signals.lockfiles.includes('pnpm-lock.yaml')) return 'pnpm';
  if (signals.lockfiles.includes('yarn.lock')) return 'yarn';
  if (signals.lockfiles.includes('package-lock.json')) return 'npm';
  return signals.hasPackageJson ? 'npm' : '';
}

function collectProjectDoctorSignals(root) {
  const rootFiles = listRootFiles(root);
  const packageResult = exists(root, 'package.json')
    ? readJson(root, 'package.json')
    : { value: null, error: '' };
  const lockfiles = [
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock'
  ].filter((name) => exists(root, name));

  const sensitiveFiles = rootFiles
    .filter((name) => {
      const lower = name.toLowerCase();
      return SENSITIVE_NAMES.includes(lower) ||
        /\.(?:pem|key|p12|pfx)$/i.test(name) ||
        /(?:secret|credentials?|token)/i.test(name);
    })
    .slice(0, 30);

  const hasPython =
    exists(root, 'pyproject.toml') ||
    exists(root, 'requirements.txt') ||
    exists(root, 'Pipfile');

  return {
    root,
    rootAccessible: Boolean(root && fs.existsSync(root)),
    hasPackageJson: exists(root, 'package.json'),
    packageJson: packageResult.value,
    packageJsonError: packageResult.error,
    lockfiles,
    packageManager: detectPackageManagerFromSignals({
      hasPackageJson: exists(root, 'package.json'),
      lockfiles
    }),
    hasNodeModules: exists(root, 'node_modules'),
    hasPython,
    hasGo: exists(root, 'go.mod'),
    hasRust: exists(root, 'Cargo.toml'),
    hasGitIgnore: exists(root, '.gitignore'),
    hasReadme:
      exists(root, 'README.md') ||
      exists(root, 'README') ||
      exists(root, 'readme.md'),
    hasLicense:
      exists(root, 'LICENSE') ||
      exists(root, 'LICENSE.md') ||
      exists(root, 'LICENSE.txt'),
    hasEditorConfig: exists(root, '.editorconfig'),
    hasTsConfig: exists(root, 'tsconfig.json'),
    hasWorkflowDir: exists(root, path.join('.github', 'workflows')),
    sensitiveFiles,
    rootFiles
  };
}

function normalizeToolValue(value) {
  const text = String(value || '').trim();
  if (!text) return { available: false, value: 'Not detected' };
  if (/not\s+(?:installed|found|available)|missing|unavailable/i.test(text)) {
    return { available: false, value: text };
  }
  return { available: true, value: text };
}

function createFinding(category, status, title, detail, id) {
  return {
    id: id || category + ':' + title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    category,
    status,
    title,
    detail: String(detail || '')
  };
}

function evaluateProjectDoctor({
  signals = {},
  environment = {},
  tasks = null,
  diagnostics = {},
  git = {},
  dependency = null,
  trackedSensitiveFiles = [],
  ignoredSensitiveFiles = []
} = {}) {
  const findings = [];
  const add = (category, status, title, detail, id) => {
    findings.push(createFinding(category, status, title, detail, id));
  };

  if (!signals.rootAccessible) {
    add('Environment', 'CRITICAL', 'Workspace unavailable', 'Open a readable workspace folder first.');
  } else {
    add('Environment', 'GOOD', 'Workspace accessible', 'Project root is readable.');
  }

  const gitTool = normalizeToolValue(environment.git);
  if (gitTool.available) {
    add('Environment', 'GOOD', 'Git available', gitTool.value);
  } else {
    add('Environment', 'CRITICAL', 'Git missing', gitTool.value);
  }

  if (signals.hasPackageJson) {
    const node = normalizeToolValue(environment.node);
    const npm = normalizeToolValue(environment.npm);

    add(
      'Environment',
      node.available ? 'GOOD' : 'CRITICAL',
      node.available ? 'Node.js available' : 'Node.js missing',
      node.value
    );

    const manager = signals.packageManager || tasks?.packageManager || 'npm';
    const managerValue =
      manager === 'npm'
        ? npm
        : normalizeToolValue(environment[manager]);

    add(
      'Package Manager',
      managerValue.available ? 'GOOD' : 'CRITICAL',
      managerValue.available
        ? manager + ' available'
        : manager + ' missing',
      managerValue.value
    );
  }

  if (signals.hasPython) {
    const python = normalizeToolValue(environment.python);
    add(
      'Environment',
      python.available ? 'GOOD' : 'CRITICAL',
      python.available ? 'Python available' : 'Python missing',
      python.value
    );
  }

  if (signals.packageJsonError) {
    add('Configuration', 'CRITICAL', 'Invalid package.json', signals.packageJsonError);
  } else if (signals.hasPackageJson) {
    add('Configuration', 'GOOD', 'package.json parsed', 'Project manifest is valid JSON.');
  }

  if (signals.hasPackageJson) {
    if ((signals.lockfiles || []).length > 1) {
      add(
        'Package Manager',
        'WARNING',
        'Multiple lockfiles',
        'Found: ' + signals.lockfiles.join(', ') + '. Keep one package-manager lockfile.'
      );
    } else if ((signals.lockfiles || []).length === 1) {
      add(
        'Package Manager',
        'GOOD',
        'Lockfile detected',
        signals.lockfiles[0]
      );
    } else {
      add(
        'Package Manager',
        'WARNING',
        'No lockfile',
        'Commit a lockfile for reproducible dependency installs.'
      );
    }

    if (signals.hasNodeModules) {
      add('Dependencies', 'GOOD', 'Dependencies installed', 'node_modules is present.');
    } else {
      add('Dependencies', 'WARNING', 'Dependencies not installed', 'node_modules is missing.');
    }
  }

  if (dependency) {
    if (Number(dependency.critical || 0) > 0) {
      add(
        'Dependencies',
        'CRITICAL',
        'Critical dependency vulnerabilities',
        Number(dependency.critical) + ' critical issue(s) reported by the latest explicit dependency scan.'
      );
    } else if (Number(dependency.high || 0) > 0) {
      add(
        'Dependencies',
        'WARNING',
        'High dependency vulnerabilities',
        Number(dependency.high) + ' high issue(s) reported.'
      );
    } else if (Number(dependency.moderate || 0) > 0) {
      add(
        'Dependencies',
        'WARNING',
        'Moderate dependency vulnerabilities',
        Number(dependency.moderate) + ' moderate issue(s) reported.'
      );
    } else {
      add('Dependencies', 'GOOD', 'No known audit blockers', 'Latest explicit dependency scan has no critical/high/moderate issues.');
    }

    if (Number(dependency.outdated || 0) > 0) {
      add(
        'Dependencies',
        'WARNING',
        'Outdated packages',
        Number(dependency.outdated) + ' package(s) reported outdated.'
      );
    }
  } else if (signals.hasPackageJson) {
    add(
      'Dependencies',
      'WARNING',
      'Dependency audit not run',
      'Run the existing explicit dependency scan when network access is appropriate.'
    );
  }

  if (!git?.isGitRepo) {
    add('Git', 'WARNING', 'Git repository not initialized', 'Initialize Git to enable history and readiness checks.');
  } else {
    if (Number(git.conflicts || 0) > 0) {
      add('Git', 'CRITICAL', 'Merge conflicts', Number(git.conflicts) + ' unresolved conflict(s).');
    } else {
      add('Git', 'GOOD', 'No merge conflicts', 'Working tree has no unresolved conflicts.');
    }

    if (Number(git.behind || 0) > 0) {
      add('Git', 'WARNING', 'Branch behind upstream', 'Behind by ' + Number(git.behind) + ' commit(s).');
    } else if (git.upstream) {
      add('Git', 'GOOD', 'Upstream synchronized', 'Branch is not behind its upstream.');
    } else {
      add('Git', 'WARNING', 'No upstream branch', 'Configure an upstream branch for safer sync/readiness checks.');
    }

    const dirty =
      Number(git.staged || 0) +
      Number(git.unstaged || 0) +
      Number(git.untracked || 0);

    if (dirty > 0) {
      add('Git', 'WARNING', 'Uncommitted changes', dirty + ' working-tree change(s) detected.');
    } else {
      add('Git', 'GOOD', 'Working tree clean', 'No uncommitted changes detected.');
    }
  }

  const standard = tasks?.standard || {};
  if (signals.hasPackageJson) {
    const taskList = tasks?.tasks || [];
    if (!taskList.length) {
      add('Scripts', 'WARNING', 'No package scripts', 'package.json does not define runnable scripts.');
    } else {
      add('Scripts', 'GOOD', 'Package scripts detected', taskList.length + ' script(s) discovered.');
    }

    for (const kind of ['lint', 'test', 'build']) {
      if (standard[kind]) {
        add('Scripts', 'GOOD', kind + ' script available', standard[kind]);
      } else {
        add('Scripts', 'WARNING', kind + ' script missing', 'No standard ' + kind + ' script was detected.');
      }
    }
  }

  const errors = Number(diagnostics.errors || 0);
  const warnings = Number(diagnostics.warnings || 0);

  if (errors > 0) {
    add('Diagnostics', 'CRITICAL', 'Workspace errors', errors + ' error diagnostic(s) detected.');
  } else if (warnings > 0) {
    add('Diagnostics', 'WARNING', 'Workspace warnings', warnings + ' warning diagnostic(s) detected.');
  } else {
    add('Diagnostics', 'GOOD', 'Diagnostics clean', 'No VS Code error or warning diagnostics detected.');
  }

  const tracked = Array.from(new Set(trackedSensitiveFiles || []));
  if (tracked.length) {
    add(
      'Security',
      'CRITICAL',
      'Sensitive-looking files tracked',
      tracked.slice(0, 8).join(', ') + (tracked.length > 8 ? '…' : '')
    );
  } else if ((signals.sensitiveFiles || []).length) {
    const ignored = new Set(ignoredSensitiveFiles || []);
    const unconfirmed = signals.sensitiveFiles.filter((file) => !ignored.has(file));
    if (unconfirmed.length) {
      add(
        'Security',
        'WARNING',
        'Sensitive-looking local files',
        unconfirmed.slice(0, 8).join(', ') + '. Verify they are ignored and contain no committed secrets.'
      );
    } else {
      add(
        'Security',
        'GOOD',
        'Sensitive files ignored',
        'Detected sensitive-looking files are ignored by Git.'
      );
    }
  } else {
    add('Security', 'GOOD', 'No root secret files detected', 'No common sensitive filename was found at project root.');
  }

  if (signals.hasGitIgnore) {
    add('Hygiene', 'GOOD', '.gitignore present', 'Repository ignore rules are available.');
  } else if (git?.isGitRepo) {
    add('Hygiene', 'WARNING', '.gitignore missing', 'Add ignore rules for generated files, dependencies, logs, and secrets.');
  }

  add(
    'Hygiene',
    signals.hasReadme ? 'GOOD' : 'WARNING',
    signals.hasReadme ? 'README present' : 'README missing',
    signals.hasReadme ? 'Project documentation entry point exists.' : 'Add a README for setup and usage.'
  );

  add(
    'Hygiene',
    signals.hasLicense ? 'GOOD' : 'WARNING',
    signals.hasLicense ? 'License present' : 'License missing',
    signals.hasLicense ? 'A project license file exists.' : 'Add a license when the repository is intended for distribution.'
  );

  const counts = {
    critical: findings.filter((item) => item.status === 'CRITICAL').length,
    warning: findings.filter((item) => item.status === 'WARNING').length,
    good: findings.filter((item) => item.status === 'GOOD').length
  };

  const score = Math.max(
    0,
    Math.min(100, 100 - counts.critical * 18 - counts.warning * 4)
  );

  return {
    status: counts.critical > 0
      ? 'CRITICAL'
      : counts.warning > 0
        ? 'WARNING'
        : 'GOOD',
    score,
    counts,
    findings,
    checkedAt: Date.now()
  };
}

module.exports = {
  collectProjectDoctorSignals,
  detectPackageManagerFromSignals,
  evaluateProjectDoctor
};
