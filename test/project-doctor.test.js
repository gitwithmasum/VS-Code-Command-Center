const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  collectProjectDoctorSignals,
  evaluateProjectDoctor
} = require('../src/features/project-doctor');

function withFixture(files, callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'galaxy-doctor-'));
  try {
    for (const [relative, content] of Object.entries(files)) {
      const absolute = path.join(root, relative);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, content);
    }
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function baseInput(signals) {
  return {
    signals,
    environment: {
      node: 'v22.0.0',
      npm: '10.0.0',
      git: '2.50.0',
      python: 'Python 3.13'
    },
    tasks: {
      packageManager: 'npm',
      tasks: [
        { name: 'lint' },
        { name: 'test' },
        { name: 'build' }
      ],
      standard: {
        lint: 'lint',
        test: 'test',
        build: 'build',
        typecheck: ''
      }
    },
    diagnostics: { errors: 0, warnings: 0 },
    git: {
      isGitRepo: true,
      upstream: 'origin/main',
      behind: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicts: 0
    },
    dependency: {
      critical: 0,
      high: 0,
      moderate: 0,
      outdated: 0
    },
    trackedSensitiveFiles: [],
    ignoredSensitiveFiles: []
  };
}

test('signals detect package manager, hygiene files, and sensitive names', () => {
  withFixture({
    'package.json': '{"name":"fixture","scripts":{"test":"node --test"}}',
    'pnpm-lock.yaml': 'lockfileVersion: 9',
    '.gitignore': 'node_modules\n.env\n',
    'README.md': '# Fixture',
    'LICENSE': 'MIT',
    '.env': 'SECRET=example'
  }, (root) => {
    const signals = collectProjectDoctorSignals(root);
    assert.equal(signals.packageManager, 'pnpm');
    assert.equal(signals.hasGitIgnore, true);
    assert.equal(signals.hasReadme, true);
    assert.equal(signals.hasLicense, true);
    assert.ok(signals.sensitiveFiles.includes('.env'));
  });
});

test('healthy project report is GOOD when all applicable checks pass', () => {
  withFixture({
    'package.json': '{"name":"fixture"}',
    'package-lock.json': '{}',
    '.gitignore': 'node_modules\n',
    'README.md': '# Fixture',
    'LICENSE': 'MIT'
  }, (root) => {
    const signals = collectProjectDoctorSignals(root);
    signals.hasNodeModules = true;
    const report = evaluateProjectDoctor(baseInput(signals));
    assert.equal(report.status, 'GOOD');
    assert.equal(report.counts.critical, 0);
    assert.equal(report.counts.warning, 0);
  });
});

test('doctor flags diagnostics, conflicts, missing tools, and tracked secrets', () => {
  withFixture({
    'package.json': '{"name":"fixture"}',
    'package-lock.json': '{}',
    '.env': 'SECRET=example'
  }, (root) => {
    const signals = collectProjectDoctorSignals(root);
    const input = baseInput(signals);
    input.environment.node = 'Not installed';
    input.diagnostics.errors = 3;
    input.git.conflicts = 1;
    input.trackedSensitiveFiles = ['.env'];

    const report = evaluateProjectDoctor(input);
    assert.equal(report.status, 'CRITICAL');
    assert.ok(report.findings.some((item) => item.title === 'Node.js missing'));
    assert.ok(report.findings.some((item) => item.title === 'Workspace errors'));
    assert.ok(report.findings.some((item) => item.title === 'Merge conflicts'));
    assert.ok(report.findings.some((item) => item.title === 'Sensitive-looking files tracked'));
  });
});

test('doctor reports warnings for missing scripts and unrun dependency audit', () => {
  withFixture({
    'package.json': '{"name":"fixture","scripts":{"start":"node index.js"}}',
    'package-lock.json': '{}',
    '.gitignore': 'node_modules\n',
    'README.md': '# Fixture',
    'LICENSE': 'MIT'
  }, (root) => {
    const signals = collectProjectDoctorSignals(root);
    signals.hasNodeModules = true;
    const input = baseInput(signals);
    input.tasks = {
      packageManager: 'npm',
      tasks: [{ name: 'start' }],
      standard: { lint: '', test: '', build: '', typecheck: '' }
    };
    input.dependency = null;

    const report = evaluateProjectDoctor(input);
    assert.equal(report.status, 'WARNING');
    assert.ok(report.findings.some((item) => item.title === 'Dependency audit not run'));
    assert.ok(report.findings.some((item) => item.title === 'test script missing'));
    assert.ok(report.findings.some((item) => item.title === 'build script missing'));
  });
});
