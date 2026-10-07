const crypto = require('crypto');
const path = require('path');

function createQualityGateState() {
  return {
    running: false,
    status: 'NOT RUN',
    score: 0,
    errors: 0,
    warnings: 0,
    conflicts: 0,
    checks: [],
    beforeErrors: null,
    afterErrors: null,
    dependency: null,
    coverage: null,
    lastRunAt: 0,
    fingerprint: '',
    message: ''
  };
}

function calculateQualityGate({
  errors = 0,
  warnings = 0,
  conflicts = 0,
  checks = [],
  dependency = null
} = {}) {
  let score = 100;

  score -= Math.min(Math.max(0, Number(errors || 0)) * 20, 60);
  score -= Math.min(Math.max(0, Number(warnings || 0)) * 2, 12);
  if (Number(conflicts || 0) > 0) score -= 30;

  const safeChecks = Array.isArray(checks) ? checks : [];
  const failedChecks = safeChecks.filter((item) => !item?.passed).length;
  score -= Math.min(failedChecks * 15, 45);

  if (Number(dependency?.critical || 0) > 0) score -= 25;
  else if (Number(dependency?.high || 0) > 0) score -= 15;
  else if (Number(dependency?.moderate || 0) > 0) score -= 5;

  score = Math.max(0, Math.min(100, score));

  let status = 'READY';
  if (
    Number(errors || 0) > 0 ||
    Number(conflicts || 0) > 0 ||
    failedChecks > 0 ||
    Number(dependency?.critical || 0) > 0
  ) {
    status = 'BLOCKED';
  } else if (
    Number(warnings || 0) > 0 ||
    Number(dependency?.high || 0) > 0 ||
    Number(dependency?.moderate || 0) > 0 ||
    Number(dependency?.outdated || 0) > 0 ||
    score < 90
  ) {
    status = 'REVIEW';
  }

  return { score, status };
}

function normalizeCoverageSummary(root, summary) {
  if (!summary || typeof summary !== 'object') return null;

  const total = summary.total || {};
  const value = (key) => {
    const pct = Number(total[key]?.pct);
    return Number.isFinite(pct) ? pct : null;
  };

  const weakFiles = Object.entries(summary)
    .filter(([key]) => key !== 'total')
    .map(([file, metrics]) => {
      const displayFile = path.isAbsolute(file)
        ? (path.relative(root, file) || path.basename(file))
        : String(file).replace(/\\/g, '/');

      return {
        file: displayFile,
        lines: Number(metrics?.lines?.pct)
      };
    })
    .filter((item) => Number.isFinite(item.lines) && item.lines < 80)
    .sort((a, b) => a.lines - b.lines)
    .slice(0, 5);

  return {
    lines: value('lines'),
    statements: value('statements'),
    functions: value('functions'),
    branches: value('branches'),
    weakFiles
  };
}

function createQualityFingerprint(head, stagedDiff) {
  return crypto
    .createHash('sha256')
    .update(String(head || '') + '\0' + String(stagedDiff || ''))
    .digest('hex');
}

function diagnosticPrivacyKey(item) {
  const material = [
    item?.file || '',
    item?.source || '',
    item?.code || '',
    item?.message || ''
  ].join('|');

  return crypto.createHash('sha256').update(material).digest('hex');
}

function migrateRecurringErrorRecords(stored) {
  const entries = Object.values(stored || {});
  const migrated = {};

  for (const item of entries) {
    if (!item) continue;

    const key =
      item.key && !String(item.key).includes('|')
        ? String(item.key)
        : diagnosticPrivacyKey(item);

    const current = migrated[key] || {
      key,
      file: String(item.file || ''),
      source: String(item.source || ''),
      code: String(item.code || ''),
      count: 0,
      lastSeenAt: 0
    };

    current.count += Math.max(0, Number(item.count || 0));
    current.lastSeenAt = Math.max(
      Number(current.lastSeenAt || 0),
      Number(item.lastSeenAt || 0)
    );
    migrated[key] = current;
  }

  return migrated;
}

module.exports = {
  createQualityGateState,
  calculateQualityGate,
  normalizeCoverageSummary,
  createQualityFingerprint,
  diagnosticPrivacyKey,
  migrateRecurringErrorRecords
};
