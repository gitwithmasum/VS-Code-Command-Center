const path = require('path');
const { getWorkspaceRoot } = require('../core/workspace');
const { runGit } = require('../core/git');

function localDayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return year + '-' + month + '-' + day;
}

function dayKeys(count, from = new Date()) {
  const keys = [];
  for (let offset = 0; offset < count; offset++) {
    const date = new Date(from);
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - offset);
    keys.push(localDayKey(date));
  }
  return keys;
}

function formatDuration(ms) {
  const minutes = Math.max(0, Math.floor(Number(ms || 0) / 60000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours && rest) return hours + 'h ' + rest + 'm';
  if (hours) return hours + 'h';
  return rest + 'm';
}

function workspaceKey() {
  return getWorkspaceRoot() || '__no_workspace__';
}

function getQualityHistory(context) {
  const all = context?.globalState.get('galaxy.qualityGateHistory', {}) || {};
  return Array.isArray(all[workspaceKey()]) ? all[workspaceKey()] : [];
}

async function recordQualityGateHistory(context, state) {
  if (!context || !state || state.status === 'RUNNING') return;
  const all = context.globalState.get('galaxy.qualityGateHistory', {}) || {};
  const key = workspaceKey();
  const list = Array.isArray(all[key]) ? all[key] : [];

  const entry = {
    at: Number(state.lastRunAt || Date.now()),
    status: String(state.status || 'NOT RUN'),
    score: Number(state.score || 0),
    errors: Number(state.errors || 0),
    warnings: Number(state.warnings || 0),
    conflicts: Number(state.conflicts || 0),
    checksPassed: Array.isArray(state.checks)
      ? state.checks.filter((item) => item.passed).length
      : 0,
    checksTotal: Array.isArray(state.checks) ? state.checks.length : 0
  };

  const next = [
    entry,
    ...list.filter((item) => Number(item.at || 0) !== entry.at)
  ].slice(0, 50);

  all[key] = next;
  await context.globalState.update('galaxy.qualityGateHistory', all);
}

function getProjectHealthHistory(context) {
  const all = context?.globalState.get('galaxy.projectHealthHistory', {}) || {};
  return Array.isArray(all[workspaceKey()]) ? all[workspaceKey()] : [];
}

async function recordProjectHealthHistory(context, health) {
  if (!context || !health || !getWorkspaceRoot()) return;
  const all = context.globalState.get('galaxy.projectHealthHistory', {}) || {};
  const key = workspaceKey();
  const list = Array.isArray(all[key]) ? all[key] : [];
  const day = localDayKey();

  const entry = {
    day,
    at: Date.now(),
    score: Number(health.score || 0),
    errors: Number(health.errors || 0),
    warnings: Number(health.warnings || 0),
    todos: Number(health.todos || 0),
    dependencies: String(health.dependencies || 'N/A')
  };

  const currentToday = list.find((item) => item.day === day);
  if (
    currentToday &&
    Number(currentToday.score || 0) === entry.score &&
    Number(currentToday.errors || 0) === entry.errors &&
    Number(currentToday.warnings || 0) === entry.warnings &&
    Number(currentToday.todos || 0) === entry.todos &&
    String(currentToday.dependencies || '') === entry.dependencies
  ) {
    return;
  }

  const next = [
    entry,
    ...list.filter((item) => item.day !== day)
  ]
    .sort((a, b) => String(b.day).localeCompare(String(a.day)))
    .slice(0, 30);

  all[key] = next;
  await context.globalState.update('galaxy.projectHealthHistory', all);
}

function aggregateCoding(history) {
  const keys30 = dayKeys(30);
  const keys7 = keys30.slice(0, 7);
  const getDay = (key) => history?.[key] || {};

  const total7Ms = keys7.reduce(
    (sum, key) => sum + Number(getDay(key).activeMs || 0),
    0
  );
  const total30Ms = keys30.reduce(
    (sum, key) => sum + Number(getDay(key).activeMs || 0),
    0
  );

  const languageMap = {};
  for (const key of keys30) {
    for (const [language, ms] of Object.entries(getDay(key).languages || {})) {
      languageMap[language] = Number(languageMap[language] || 0) + Number(ms || 0);
    }
  }

  const languages = Object.entries(languageMap)
    .map(([name, activeMs]) => ({
      name,
      activeMs,
      text: formatDuration(activeMs),
      percent: total30Ms > 0 ? Math.round((activeMs / total30Ms) * 100) : 0
    }))
    .sort((a, b) => b.activeMs - a.activeMs)
    .slice(0, 8);

  let streak = 0;
  let startIndex = Number(getDay(keys30[0]).activeMs || 0) > 0 ? 0 : 1;
  for (let index = startIndex; index < keys30.length; index++) {
    if (Number(getDay(keys30[index]).activeMs || 0) <= 0) break;
    streak++;
  }

  const activeDays30 = keys30.filter(
    (key) => Number(getDay(key).activeMs || 0) > 0
  ).length;

  const daily7 = [...keys7]
    .reverse()
    .map((key) => ({
      day: key,
      activeMs: Number(getDay(key).activeMs || 0),
      text: formatDuration(getDay(key).activeMs || 0)
    }));

  const maxDailyMs = Math.max(1, ...daily7.map((item) => item.activeMs));
  for (const item of daily7) {
    item.percent = Math.max(
      item.activeMs > 0 ? 4 : 0,
      Math.round((item.activeMs / maxDailyMs) * 100)
    );
  }

  return {
    total7Ms,
    total7Text: formatDuration(total7Ms),
    total30Ms,
    total30Text: formatDuration(total30Ms),
    activeDays30,
    streak,
    languages,
    topLanguage: languages[0]?.name || '—',
    daily7
  };
}

function aggregateGit(root) {
  if (!root || runGit(root, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
    return {
      commits7: 0,
      commits30: 0,
      activeDays30: 0,
      daily7: []
    };
  }

  const raw = runGit(root, [
    'log',
    '--since=30 days ago',
    '--date=format:%Y-%m-%d',
    '--pretty=format:%ad'
  ]);

  const counts = {};
  for (const day of raw.split(/\r?\n/).filter(Boolean)) {
    counts[day] = Number(counts[day] || 0) + 1;
  }

  const keys7 = dayKeys(7);
  const commits7 = keys7.reduce((sum, key) => sum + Number(counts[key] || 0), 0);
  const commits30 = Object.values(counts).reduce(
    (sum, count) => sum + Number(count || 0),
    0
  );

  const daily7 = [...keys7]
    .reverse()
    .map((day) => ({ day, commits: Number(counts[day] || 0) }));

  const maxCommits = Math.max(1, ...daily7.map((item) => item.commits));
  for (const item of daily7) {
    item.percent = Math.max(
      item.commits > 0 ? 5 : 0,
      Math.round((item.commits / maxCommits) * 100)
    );
  }

  return {
    commits7,
    commits30,
    activeDays30: Object.keys(counts).length,
    daily7
  };
}

function aggregateQuality(history) {
  const recent = (history || []).slice(0, 12);
  if (!recent.length) {
    return {
      runs: 0,
      averageScore: 0,
      readyRate: 0,
      latestStatus: 'NOT RUN',
      latestScore: 0,
      recent: []
    };
  }

  const averageScore = Math.round(
    recent.reduce((sum, item) => sum + Number(item.score || 0), 0) /
      recent.length
  );
  const ready = recent.filter((item) => item.status === 'READY').length;

  return {
    runs: recent.length,
    averageScore,
    readyRate: Math.round((ready / recent.length) * 100),
    latestStatus: recent[0]?.status || 'NOT RUN',
    latestScore: Number(recent[0]?.score || 0),
    recent: recent.slice(0, 6)
  };
}

function aggregateHealth(history, currentHealth) {
  const recent = (history || []).slice(0, 7);
  const currentScore = Number(currentHealth?.score || recent[0]?.score || 0);
  const previousScore = Number(recent[1]?.score ?? recent[0]?.score ?? currentScore);
  const delta = currentScore - previousScore;

  return {
    currentScore,
    delta,
    direction: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
    recent
  };
}

function aggregateCp(cpState) {
  const history = Array.isArray(cpState?.history) ? cpState.history : [];
  const judged = history.filter((item) =>
    ['PASS', 'WRONG ANSWER', 'TLE', 'RUNTIME ERROR', 'COMPILE ERROR', 'MISMATCH']
      .includes(String(item.verdict || ''))
  );
  const passes = judged.filter((item) => item.verdict === 'PASS').length;
  const failures = judged.length - passes;
  const stressRuns = history.filter((item) => item.type === 'stress').length;
  const accepted = history.filter(
    (item) => item.type === 'official' && item.verdict === 'AC'
  ).length;
  const solved = Array.isArray(cpState?.problems)
    ? cpState.problems.filter((item) => item.status === 'AC').length
    : 0;

  const sampleRuntimes = history
    .filter((item) => item.type === 'sample' && Number.isFinite(Number(item.runtimeMs)))
    .map((item) => Number(item.runtimeMs));

  const averageRuntimeMs = sampleRuntimes.length
    ? Math.round(
        sampleRuntimes.reduce((sum, value) => sum + value, 0) /
          sampleRuntimes.length
      )
    : 0;

  return {
    runs: judged.length,
    passes,
    failures,
    passRate: judged.length ? Math.round((passes / judged.length) * 100) : 0,
    stressRuns,
    accepted,
    solved,
    averageRuntimeMs
  };
}

function getDeveloperAnalytics(context, options = {}) {
  const codingHistory = context?.globalState.get('galaxy.codingHistory', {}) || {};
  const root = getWorkspaceRoot();
  const qualityHistory = getQualityHistory(context);
  const healthHistory = getProjectHealthHistory(context);

  return {
    coding: aggregateCoding(codingHistory),
    git: aggregateGit(root),
    quality: aggregateQuality(qualityHistory),
    health: aggregateHealth(healthHistory, options.health),
    cp: aggregateCp(options.cpState),
    workspace: root ? path.basename(root) : 'No workspace',
    generatedAt: Date.now()
  };
}

module.exports = {
  getDeveloperAnalytics,
  recordQualityGateHistory,
  recordProjectHealthHistory
};
