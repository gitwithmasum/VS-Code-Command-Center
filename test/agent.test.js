const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeAgentPlan,
  fallbackAgentPlan,
  advanceAgentPlan,
  getNextAgentStep,
  isAgentPlanComplete,
  actionById
} = require('../src/features/agent');

test('agent plan drops unknown actions and duplicate steps', () => {
  const plan = normalizeAgentPlan({
    goal: 'ship project',
    steps: [
      { action: 'inspectWorkspace', reason: 'inspect' },
      { action: 'unknownShell', reason: 'bad' },
      { action: 'inspectWorkspace', reason: 'duplicate' },
      { action: 'pushIfReady', reason: 'push' }
    ]
  });

  assert.deepEqual(
    plan.steps.map((step) => step.action),
    ['inspectWorkspace', 'pushIfReady']
  );
  assert.equal(plan.steps[0].status, 'PENDING');
});

test('agent action catalog marks write actions explicitly', () => {
  assert.equal(actionById('smartCommit').risk, 'write');
  assert.equal(actionById('pushIfReady').risk, 'write');
  assert.equal(actionById('inspectWorkspace').risk, 'safe');
});

test('fallback release plan includes verification, quality, CI, commit and push', () => {
  const plan = fallbackAgentPlan('prepare this project for release and push it');
  const actions = plan.steps.map((step) => step.action);

  for (const required of [
    'inspectWorkspace',
    'verifyProject',
    'runQualityGate',
    'refreshCi',
    'smartCommit',
    'pushIfReady'
  ]) {
    assert.ok(actions.includes(required), required + ' should be included');
  }
});

test('fallback debug plan includes diagnostic analysis and fix proposal', () => {
  const plan = fallbackAgentPlan('find why this bug fails and propose a fix');
  const actions = plan.steps.map((step) => step.action);

  assert.ok(actions.includes('analyzeDiagnostics'));
  assert.ok(actions.includes('proposeFix'));
});

test('agent plan advances one known step without mutating others', () => {
  const plan = normalizeAgentPlan({
    goal: 'verify project',
    steps: [
      { action: 'inspectWorkspace' },
      { action: 'verifyProject' }
    ]
  });

  const next = advanceAgentPlan(plan, 'inspectWorkspace', 'PASS', 'done');
  assert.equal(next.steps[0].status, 'PASS');
  assert.equal(next.steps[0].result, 'done');
  assert.equal(next.steps[1].status, 'PENDING');
  assert.equal(plan.steps[0].status, 'PENDING');
});

test('next step and completion state follow pending workflow', () => {
  let plan = normalizeAgentPlan({
    goal: 'verify',
    steps: [
      { action: 'inspectWorkspace' },
      { action: 'verifyProject' }
    ]
  });

  assert.equal(getNextAgentStep(plan).action, 'inspectWorkspace');
  assert.equal(isAgentPlanComplete(plan), false);

  plan = advanceAgentPlan(plan, 'inspectWorkspace', 'PASS');
  plan = advanceAgentPlan(plan, 'verifyProject', 'SKIPPED');

  assert.equal(getNextAgentStep(plan), null);
  assert.equal(isAgentPlanComplete(plan), true);
});
