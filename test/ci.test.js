const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseWorkflowScripts,
  parseWorkflowJobs,
  normalizeCiStatus,
  summarizeCiRuns,
  mapCiScripts,
  evaluatePushReadiness
} = require('../src/features/ci');

test('workflow parser extracts package scripts and job ids', () => {
  const yaml = [
    'name: CI',
    'on: [push]',
    'jobs:',
    '  test:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: npm run lint',
    '      - run: npm test',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: pnpm run build'
  ].join('\n');

  assert.deepEqual(parseWorkflowScripts(yaml), ['build', 'lint', 'test']);
  assert.deepEqual(parseWorkflowJobs(yaml), ['test', 'build']);
});

test('CI status normalization handles pass, fail, running, and unknown', () => {
  assert.equal(normalizeCiStatus({ conclusion: 'success' }), 'PASS');
  assert.equal(normalizeCiStatus({ conclusion: 'failure' }), 'FAIL');
  assert.equal(normalizeCiStatus({ status: 'in_progress' }), 'RUNNING');
  assert.equal(normalizeCiStatus({ status: 'mystery' }), 'UNKNOWN');
});

test('CI run summary prefers a run matching local HEAD', () => {
  const runs = [
    {
      id: 2,
      name: 'CI',
      head_branch: 'main',
      head_sha: 'remote-new',
      conclusion: 'success',
      html_url: 'https://example.com/2'
    },
    {
      id: 1,
      name: 'CI',
      head_branch: 'main',
      head_sha: 'local-head',
      conclusion: 'failure',
      html_url: 'https://example.com/1'
    }
  ];

  const summary = summarizeCiRuns(runs, 'main', 'local-head');
  assert.equal(summary.currentHeadCovered, true);
  assert.equal(summary.currentHeadRun.id, '1');
  assert.equal(summary.status, 'FAIL');
});

test('local to CI script mapping reports covered and missing scripts', () => {
  const workflows = [
    { scriptRefs: ['lint', 'test', 'ghost'] }
  ];
  const discovery = {
    tasks: [
      { name: 'lint' },
      { name: 'test' },
      { name: 'build' }
    ]
  };

  const mapping = mapCiScripts(workflows, discovery);
  assert.deepEqual(mapping.mapped, ['lint', 'test']);
  assert.deepEqual(mapping.missingLocal, ['ghost']);
  assert.deepEqual(mapping.localNotInCi, ['build']);
});

function baseReadyInput() {
  return {
    git: {
      isGitRepo: true,
      branch: 'feature',
      upstream: 'origin/feature',
      ahead: 1,
      behind: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicts: 0,
      clean: true,
      hasCommitsToPush: true
    },
    quality: {
      status: 'READY',
      lastRunAt: Date.now()
    },
    orchestrator: {
      passed: true,
      cancelled: false,
      discovery: {
        standard: { lint: 'lint', test: 'test', build: 'build' }
      }
    },
    ci: {
      status: 'PASS',
      currentHeadCovered: false,
      error: ''
    },
    workflows: [{ name: 'CI' }],
    qualityFingerprintCurrent: true
  };
}

test('ready-to-push verdict becomes READY when all gates are satisfied', () => {
  const result = evaluatePushReadiness(baseReadyInput());
  assert.equal(result.verdict, 'READY');
  assert.equal(result.checks.every((item) => item.status === 'PASS'), true);
});

test('readiness blocks conflicts, behind branches, failed quality, or failed CI', () => {
  const input = baseReadyInput();
  input.git.conflicts = 1;
  input.git.behind = 2;
  input.quality.status = 'BLOCKED';
  input.qualityFingerprintCurrent = false;
  input.ci.status = 'FAIL';

  const result = evaluatePushReadiness(input);
  assert.equal(result.verdict, 'BLOCKED');
  assert.ok(result.checks.some((item) => item.id === 'conflicts' && item.status === 'BLOCK'));
  assert.ok(result.checks.some((item) => item.id === 'ci' && item.status === 'BLOCK'));
});

test('readiness asks for review when CI or current verification is unavailable', () => {
  const input = baseReadyInput();
  input.ci = { status: 'UNKNOWN', error: 'Connect GitHub to load Actions status.' };
  input.qualityFingerprintCurrent = false;

  const result = evaluatePushReadiness(input);
  assert.equal(result.verdict, 'REVIEW');
  assert.ok(result.checks.some((item) => item.status === 'REVIEW'));
});
