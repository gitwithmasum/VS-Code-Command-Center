const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildDeveloperOsState,
  buildMissions
} = require('../src/features/developer-os');

function healthyInput() {
  return {
    workspaceOpen: true,
    doctor: { status: 'GOOD', score: 100, counts: { critical: 0, warning: 0 } },
    quality: { status: 'READY', score: 100 },
    ci: { readiness: { verdict: 'READY' }, remote: { status: 'PASS' } },
    release: { verdict: 'READY', version: '4.0.0' },
    knowledge: { graph: { totalFiles: 50, totalSymbols: 300 } },
    architecture: { scan: { totalFiles: 50, relationships: [1, 2, 3] } },
    agent: { running: false, complete: true, nextStep: null },
    orchestrator: { running: false, passed: true, discovery: { tasks: [1, 2] } },
    git: { conflicts: 0, behind: 0, upstream: 'origin/main' }
  };
}

test('healthy modules produce OPERATIONAL state', () => {
  const state = buildDeveloperOsState(healthyInput());
  assert.equal(state.status, 'OPERATIONAL');
  assert.equal(state.counts.blocked, 0);
  assert.equal(state.counts.review, 0);
  assert.ok(state.score >= 95);
});

test('critical doctor and git conflicts degrade the OS', () => {
  const input = healthyInput();
  input.doctor = { status: 'CRITICAL', score: 42, counts: { critical: 2, warning: 4 } };
  input.git.conflicts = 2;

  const state = buildDeveloperOsState(input);
  assert.equal(state.status, 'DEGRADED');
  assert.ok(state.counts.blocked >= 2);
  assert.equal(state.missions[0].module, 'doctor');
});

test('unknown modules produce ATTENTION instead of false-ready', () => {
  const input = healthyInput();
  input.agent = { running: false, complete: false, nextStep: null };
  input.knowledge = { graph: null };

  const state = buildDeveloperOsState(input);
  assert.equal(state.status, 'ATTENTION');
  assert.ok(state.counts.unknown >= 2);
});

test('closed workspace forces DEGRADED score zero', () => {
  const state = buildDeveloperOsState({ workspaceOpen: false });
  assert.equal(state.status, 'DEGRADED');
  assert.equal(state.score, 0);
  assert.equal(state.boot[0].status, 'BLOCKED');
});

test('missions prioritize blockers over review items', () => {
  const missions = buildMissions([
    { id: 'release', label: 'Release Center', status: 'REVIEW', detail: 'review', action: 'releaseRunCheck' },
    { id: 'quality', label: 'Quality Gate', status: 'BLOCKED', detail: 'blocked', action: 'runQualityGate' }
  ]);

  assert.equal(missions[0].module, 'quality');
  assert.equal(missions[0].severity, 'BLOCKED');
});
