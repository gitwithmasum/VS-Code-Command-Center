const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  createQualityGateState,
  calculateQualityGate,
  normalizeCoverageSummary,
  createQualityFingerprint,
  migrateRecurringErrorRecords
} = require('../src/features/quality');

test('quality state starts isolated and neutral', () => {
  const state = createQualityGateState();
  assert.equal(state.status, 'NOT RUN');
  assert.equal(state.score, 0);
  assert.equal(state.running, false);
  assert.equal(state.fingerprint, '');
});

test('quality scoring returns READY, REVIEW, and BLOCKED correctly', () => {
  assert.deepEqual(
    calculateQualityGate({ errors: 0, warnings: 0, conflicts: 0, checks: [] }),
    { score: 100, status: 'READY' }
  );

  const review = calculateQualityGate({
    errors: 0,
    warnings: 2,
    conflicts: 0,
    checks: [{ passed: true }],
    dependency: { outdated: 1 }
  });
  assert.equal(review.status, 'REVIEW');
  assert.ok(review.score < 100);

  const blocked = calculateQualityGate({
    errors: 1,
    warnings: 0,
    conflicts: 0,
    checks: [{ passed: false }]
  });
  assert.equal(blocked.status, 'BLOCKED');
  assert.ok(blocked.score < review.score);
});

test('coverage normalization handles absolute and relative file keys', () => {
  const root = path.resolve('/tmp/galaxy-quality');
  const absolute = path.join(root, 'src', 'a.js');
  const result = normalizeCoverageSummary(root, {
    total: {
      lines: { pct: 80 },
      statements: { pct: 82 },
      functions: { pct: 85 },
      branches: { pct: 70 }
    },
    [absolute]: { lines: { pct: 55 } },
    'src/b.js': { lines: { pct: 75 } },
    'src/c.js': { lines: { pct: 90 } }
  });

  assert.equal(result.lines, 80);
  assert.equal(result.branches, 70);
  assert.equal(result.weakFiles.length, 2);
  assert.equal(result.weakFiles[0].lines, 55);
  assert.ok(result.weakFiles.some((item) => item.file.replace(/\\/g, '/') === 'src/a.js'));
  assert.ok(result.weakFiles.some((item) => item.file === 'src/b.js'));
});

test('quality fingerprint changes with staged content', () => {
  const one = createQualityFingerprint('abc', 'diff-one');
  const two = createQualityFingerprint('abc', 'diff-two');
  assert.equal(one, createQualityFingerprint('abc', 'diff-one'));
  assert.notEqual(one, two);
});

test('recurring diagnostic migration removes raw messages', () => {
  const migrated = migrateRecurringErrorRecords({
    old: {
      key: 'src/a.js|eslint|x|secret diagnostic text',
      file: 'src/a.js',
      source: 'eslint',
      code: 'x',
      message: 'secret diagnostic text',
      count: 3,
      lastSeenAt: 100
    }
  });

  const records = Object.values(migrated);
  assert.equal(records.length, 1);
  assert.equal(records[0].file, 'src/a.js');
  assert.equal(records[0].count, 3);
  assert.equal(Object.prototype.hasOwnProperty.call(records[0], 'message'), false);
  assert.equal(records[0].key.includes('secret diagnostic text'), false);
});
