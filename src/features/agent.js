const ACTIONS = {
  inspectWorkspace: {
    id: 'inspectWorkspace',
    label: 'Inspect Workspace',
    risk: 'safe',
    description: 'Refresh local workspace architecture and project intelligence.'
  },
  verifyProject: {
    id: 'verifyProject',
    label: 'Run Verify Pipeline',
    risk: 'confirm',
    description: 'Run detected lint, typecheck, test, and build scripts.'
  },
  runQualityGate: {
    id: 'runQualityGate',
    label: 'Run Quality Gate',
    risk: 'confirm',
    description: 'Run diagnostics and available verification checks.'
  },
  refreshCi: {
    id: 'refreshCi',
    label: 'Refresh CI Intelligence',
    risk: 'safe',
    description: 'Refresh local workflow mapping and GitHub Actions status.'
  },
  reviewStaged: {
    id: 'reviewStaged',
    label: 'AI Review Staged Changes',
    risk: 'confirm',
    description: 'Send the staged diff to the configured VS Code language model for review.'
  },
  analyzeDiagnostics: {
    id: 'analyzeDiagnostics',
    label: 'AI Analyze Current Diagnostic',
    risk: 'confirm',
    description: 'Send the current diagnostic and a small nearby code snippet to the configured VS Code language model.'
  },
  proposeFix: {
    id: 'proposeFix',
    label: 'Generate AI Fix Proposal',
    risk: 'confirm',
    description: 'Generate a reviewable code-edit proposal without applying it.'
  },
  smartCommit: {
    id: 'smartCommit',
    label: 'Smart Commit Gate',
    risk: 'write',
    description: 'Generate and create a Git commit only after explicit confirmation.'
  },
  pushIfReady: {
    id: 'pushIfReady',
    label: 'Push If Ready',
    risk: 'write',
    description: 'Run readiness checks and push only after explicit confirmation.'
  }
};

function getAgentActions() {
  return Object.values(ACTIONS).map((item) => ({ ...item }));
}

function actionById(id) {
  return ACTIONS[String(id || '')] || null;
}

function normalizeAgentPlan(raw, goal = '') {
  const source = raw && typeof raw === 'object' ? raw : {};
  const steps = Array.isArray(source.steps) ? source.steps : [];
  const normalized = [];
  const seen = new Set();

  for (const item of steps) {
    const action = actionById(item?.action || item?.id);
    if (!action || seen.has(action.id)) continue;
    seen.add(action.id);

    normalized.push({
      id: action.id,
      action: action.id,
      label: action.label,
      risk: action.risk,
      description: action.description,
      reason: String(item?.reason || '').slice(0, 500),
      status: 'PENDING',
      result: ''
    });

    if (normalized.length >= 12) break;
  }

  return {
    goal: String(source.goal || goal || '').trim().slice(0, 1200),
    summary: String(source.summary || '').trim().slice(0, 1200),
    steps: normalized
  };
}

function fallbackAgentPlan(goal = '') {
  const text = String(goal || '').toLowerCase();
  const steps = [];

  const add = (action, reason) => {
    const item = actionById(action);
    if (!item || steps.some((step) => step.action === action)) return;
    steps.push({ action, reason });
  };

  add('inspectWorkspace', 'Start with a local workspace inspection.');

  if (/error|bug|fail|diagnostic|debug/.test(text)) {
    add('analyzeDiagnostics', 'Inspect the current diagnostic before proposing a change.');
    add('proposeFix', 'Create a reviewable fix proposal if a diagnostic is available.');
  }

  if (/release|ship|push|commit|ready|verify|check|build|test/.test(text)) {
    add('verifyProject', 'Run the project verification pipeline.');
    add('runQualityGate', 'Confirm the workspace quality gate.');
    add('refreshCi', 'Refresh CI status before deciding whether the branch is ready.');
  }

  if (/review|commit/.test(text)) {
    add('reviewStaged', 'Review staged changes before creating a commit.');
  }

  if (/commit|release|ship/.test(text)) {
    add('smartCommit', 'Create a commit only after the quality gate and explicit confirmation.');
  }

  if (/push|release|ship/.test(text)) {
    add('pushIfReady', 'Push only after readiness checks and explicit confirmation.');
  }

  if (steps.length === 1) {
    add('verifyProject', 'Run a general local verification pass.');
    add('runQualityGate', 'Check overall project readiness.');
  }

  return normalizeAgentPlan({
    goal,
    summary: 'Fallback deterministic plan generated locally.',
    steps
  }, goal);
}

function advanceAgentPlan(plan, actionId, status, result = '') {
  const next = {
    ...(plan || {}),
    steps: Array.isArray(plan?.steps)
      ? plan.steps.map((step) => ({ ...step }))
      : []
  };

  const index = next.steps.findIndex((step) => step.action === actionId);
  if (index < 0) return next;

  next.steps[index].status = String(status || 'PENDING');
  next.steps[index].result = String(result || '').slice(0, 1200);
  return next;
}

function getNextAgentStep(plan) {
  return (plan?.steps || []).find((step) => step.status === 'PENDING') || null;
}

function isAgentPlanComplete(plan) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  return steps.length > 0 && steps.every((step) =>
    ['PASS', 'SKIPPED', 'FAILED'].includes(step.status)
  );
}

module.exports = {
  getAgentActions,
  actionById,
  normalizeAgentPlan,
  fallbackAgentPlan,
  advanceAgentPlan,
  getNextAgentStep,
  isAgentPlanComplete
};
