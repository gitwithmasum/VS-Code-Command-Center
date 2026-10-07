function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

function moduleState(id, label, status, detail, action, weight = 1) {
  return {
    id,
    label,
    status,
    detail: String(detail || ''),
    action,
    weight
  };
}

function statusPenalty(status) {
  if (status === 'BLOCKED' || status === 'CRITICAL' || status === 'FAIL') return 26;
  if (status === 'REVIEW' || status === 'WARNING' || status === 'RUNNING') return 10;
  if (status === 'UNKNOWN' || status === 'NOT RUN' || status === 'IDLE') return 7;
  return 0;
}

function normalizeModuleStatus(value, goodValues = []) {
  const raw = String(value || '').toUpperCase();
  if (goodValues.includes(raw)) return 'READY';
  if (['BLOCKED', 'CRITICAL', 'FAIL', 'FAILED'].includes(raw)) return 'BLOCKED';
  if (['REVIEW', 'WARNING', 'WARN', 'RUNNING'].includes(raw)) return 'REVIEW';
  if (['READY', 'GOOD', 'PASS', 'TAGGED', 'COMPLETE'].includes(raw)) return 'READY';
  return 'UNKNOWN';
}

function buildModuleRegistry({
  doctor = {},
  quality = {},
  ci = {},
  release = {},
  knowledge = {},
  architecture = {},
  agent = {},
  orchestrator = {},
  git = {}
} = {}) {
  const modules = [];

  modules.push(
    moduleState(
      'doctor',
      'Project Doctor',
      normalizeModuleStatus(doctor.status),
      doctor.status
        ? 'Score ' + Number(doctor.score || 0) + '/100 · ' +
          Number(doctor.counts?.critical || 0) + ' critical · ' +
          Number(doctor.counts?.warning || 0) + ' warning'
        : 'Doctor has not reported yet.',
      'projectDoctorRun',
      1.2
    )
  );

  modules.push(
    moduleState(
      'quality',
      'Quality Gate',
      normalizeModuleStatus(quality.status),
      quality.status
        ? String(quality.status) + ' · score ' + Number(quality.score || 0) + '/100'
        : 'Quality Gate has not run yet.',
      'runQualityGate',
      1.2
    )
  );

  modules.push(
    moduleState(
      'ci',
      'CI Intelligence',
      normalizeModuleStatus(ci.readiness?.verdict || ci.remote?.status),
      ci.readiness?.verdict
        ? 'Ready-to-Push: ' + ci.readiness.verdict
        : 'No Ready-to-Push verdict yet.',
      'ciRunReadyCheck',
      1.1
    )
  );

  modules.push(
    moduleState(
      'release',
      'Release Center',
      normalizeModuleStatus(release.verdict),
      release.verdict
        ? String(release.verdict) + (release.version ? ' · v' + release.version : '')
        : 'No release verdict yet.',
      'releaseRunCheck',
      1
    )
  );

  modules.push(
    moduleState(
      'knowledge',
      'Developer Knowledge Graph',
      Number(knowledge.graph?.totalFiles || 0) > 0 ? 'READY' : 'UNKNOWN',
      Number(knowledge.graph?.totalFiles || 0) > 0
        ? Number(knowledge.graph.totalFiles) + ' files · ' +
          Number(knowledge.graph.totalSymbols || 0) + ' symbols'
        : 'Knowledge graph has not indexed this workspace yet.',
      'knowledgeRefresh',
      0.65
    )
  );

  modules.push(
    moduleState(
      'architecture',
      'Architecture Intelligence',
      Number(architecture.scan?.totalFiles || 0) > 0 ? 'READY' : 'UNKNOWN',
      Number(architecture.scan?.totalFiles || 0) > 0
        ? Number(architecture.scan.totalFiles) + ' files · ' +
          Number(architecture.scan.relationships?.length || 0) + ' relationships'
        : 'Architecture scan is not available yet.',
      'refreshArchitecture',
      0.65
    )
  );

  const agentStatus = agent.running
    ? 'REVIEW'
    : agent.complete
      ? 'READY'
      : agent.nextStep
        ? 'REVIEW'
        : 'UNKNOWN';

  modules.push(
    moduleState(
      'agent',
      'Galaxy AI Agent',
      agentStatus,
      agent.running
        ? 'Agent step is running.'
        : agent.complete
          ? 'Current agent plan is complete.'
          : agent.nextStep
            ? 'Agent plan is waiting for the next approved step.'
            : 'No active agent goal.',
      'agentCreatePlan',
      0.65
    )
  );

  const taskStatus = orchestrator.running
    ? 'REVIEW'
    : orchestrator.passed === false
      ? 'BLOCKED'
      : orchestrator.passed === true
        ? 'READY'
        : 'UNKNOWN';

  modules.push(
    moduleState(
      'tasks',
      'Task Orchestrator',
      taskStatus,
      orchestrator.running
        ? 'A workflow is running.'
        : orchestrator.passed === false
          ? 'Last workflow failed.'
          : orchestrator.passed === true
            ? 'Last workflow passed.'
            : Number(orchestrator.discovery?.tasks?.length || 0) +
              ' task(s) discovered.',
      'orchestratorVerify',
      0.8
    )
  );

  const gitStatus =
    Number(git.conflicts || 0) > 0
      ? 'BLOCKED'
      : Number(git.behind || 0) > 0 || !git.upstream
        ? 'REVIEW'
        : 'READY';

  modules.push(
    moduleState(
      'git',
      'Git Workspace',
      gitStatus,
      gitStatus === 'BLOCKED'
        ? Number(git.conflicts || 0) + ' unresolved conflict(s).'
        : gitStatus === 'REVIEW'
          ? (!git.upstream
              ? 'No upstream branch configured.'
              : 'Branch is behind upstream by ' + Number(git.behind || 0) + '.')
          : 'Branch/upstream state is healthy.',
      'sourceControl',
      1
    )
  );

  return modules;
}

function buildBootSequence({
  workspaceOpen = false,
  modules = []
} = {}) {
  const byId = new Map((modules || []).map((item) => [item.id, item]));
  const stages = [
    {
      id: 'workspace',
      label: 'Workspace',
      status: workspaceOpen ? 'READY' : 'BLOCKED',
      detail: workspaceOpen ? 'Workspace mounted.' : 'Open a workspace folder.'
    },
    {
      id: 'health',
      label: 'Health',
      status: byId.get('doctor')?.status || 'UNKNOWN',
      detail: byId.get('doctor')?.detail || 'Doctor unavailable.'
    },
    {
      id: 'quality',
      label: 'Quality',
      status: byId.get('quality')?.status || 'UNKNOWN',
      detail: byId.get('quality')?.detail || 'Quality unavailable.'
    },
    {
      id: 'delivery',
      label: 'Delivery',
      status:
        byId.get('ci')?.status === 'BLOCKED' ||
        byId.get('release')?.status === 'BLOCKED'
          ? 'BLOCKED'
          : byId.get('ci')?.status === 'READY' &&
            byId.get('release')?.status === 'READY'
            ? 'READY'
            : 'REVIEW',
      detail:
        'CI ' + (byId.get('ci')?.status || 'UNKNOWN') +
        ' · Release ' + (byId.get('release')?.status || 'UNKNOWN')
    }
  ];
  return stages;
}

function buildMissions(modules) {
  const priority = {
    doctor: 100,
    quality: 90,
    git: 85,
    tasks: 78,
    ci: 72,
    release: 65,
    knowledge: 35,
    architecture: 30,
    agent: 25
  };

  const missions = (modules || [])
    .filter((item) => item.status !== 'READY')
    .map((item) => ({
      id: 'mission:' + item.id,
      module: item.id,
      title:
        item.status === 'BLOCKED'
          ? 'Resolve ' + item.label
          : 'Review ' + item.label,
      detail: item.detail,
      action: item.action,
      severity: item.status,
      priority:
        Number(priority[item.id] || 10) +
        (item.status === 'BLOCKED' ? 40 : item.status === 'REVIEW' ? 15 : 0)
    }))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 6);

  if (!missions.length) {
    missions.push({
      id: 'mission:ship',
      module: 'release',
      title: 'Workspace is operational',
      detail: 'Core modules are READY. Use Release Center when you are preparing a version.',
      action: 'releaseRunCheck',
      severity: 'READY',
      priority: 1
    });
  }

  return missions;
}

function buildDeveloperOsState(input = {}) {
  const workspaceOpen = Boolean(input.workspaceOpen);
  const modules = buildModuleRegistry(input);
  const boot = buildBootSequence({ workspaceOpen, modules });

  const weightedPenalty = modules.reduce(
    (sum, item) => sum + statusPenalty(item.status) * Number(item.weight || 1),
    0
  );
  const maxPenalty = modules.reduce(
    (sum, item) => sum + 26 * Number(item.weight || 1),
    0
  ) || 1;

  let score = Math.round(100 - (weightedPenalty / maxPenalty) * 100);
  if (!workspaceOpen) score = 0;
  score = clamp(score);

  const blocked = modules.filter((item) => item.status === 'BLOCKED').length;
  const review = modules.filter((item) => item.status === 'REVIEW').length;
  const ready = modules.filter((item) => item.status === 'READY').length;
  const unknown = modules.filter((item) => item.status === 'UNKNOWN').length;

  const status = !workspaceOpen || blocked > 0
    ? 'DEGRADED'
    : review > 0 || unknown > 0
      ? 'ATTENTION'
      : 'OPERATIONAL';

  return {
    status,
    score,
    counts: { blocked, review, ready, unknown },
    modules,
    boot,
    missions: buildMissions(modules),
    headline:
      status === 'OPERATIONAL'
        ? 'Developer OS operational'
        : status === 'ATTENTION'
          ? 'Developer OS needs attention'
          : 'Developer OS degraded'
  };
}

module.exports = {
  normalizeModuleStatus,
  buildModuleRegistry,
  buildBootSequence,
  buildMissions,
  buildDeveloperOsState
};
