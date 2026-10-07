const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeVersion,
  extractChangelogSection,
  evaluateReleaseReadiness,
  nextVersion
} = require('../src/features/release-center');

function readyInput() {
  return {
    version: '3.7.0',
    packageLockVersion: '3.7.0',
    changelog: '# Changelog\n\n## 3.7.0\n\n- Release Center\n\n## 3.6.0\n\n- Doctor\n',
    git: {
      isGitRepo: true,
      branch: 'main',
      upstream: 'origin/main',
      behind: 0,
      conflicts: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0
    },
    quality: { status: 'READY' },
    qualityFingerprintCurrent: true,
    ci: { status: 'PASS', currentHeadCovered: true },
    doctor: { status: 'GOOD' },
    tags: []
  };
}

test('normalizes semantic versions and generates canonical tags', () => {
  assert.equal(normalizeVersion('v3.7.0').raw, '3.7.0');
  assert.equal(normalizeVersion('3.7.0-beta.1').tag, 'v3.7.0-beta.1');
  assert.equal(normalizeVersion('version-three'), null);
});

test('extracts only the requested changelog section', () => {
  const changelog = [
    '# Changelog',
    '',
    '## 3.7.0',
    '',
    '- Release Center',
    '- Release checks',
    '',
    '## 3.6.0',
    '',
    '- Project Doctor'
  ].join('\n');

  const section = extractChangelogSection(changelog, '3.7.0');
  assert.match(section, /Release Center/);
  assert.doesNotMatch(section, /Project Doctor/);
});

test('release readiness is READY when all gates pass and tag is available', () => {
  const result = evaluateReleaseReadiness(readyInput());
  assert.equal(result.verdict, 'READY');
  assert.equal(result.tag, 'v3.7.0');
  assert.equal(result.counts.block, 0);
  assert.equal(result.counts.review, 0);
});

test('release readiness becomes TAGGED when version tag points to HEAD', () => {
  const input = readyInput();
  input.tags = ['v3.7.0'];
  input.tagHeadMatches = true;
  const result = evaluateReleaseReadiness(input);
  assert.equal(result.verdict, 'TAGGED');
});

test('release readiness blocks dirty worktree, stale tag, and version mismatch', () => {
  const input = readyInput();
  input.packageLockVersion = '3.6.0';
  input.git.unstaged = 2;
  input.tags = ['v3.7.0'];
  input.tagHeadMatches = false;
  const result = evaluateReleaseReadiness(input);
  assert.equal(result.verdict, 'BLOCKED');
  assert.ok(result.checks.some((item) => item.id === 'lock-version' && item.status === 'BLOCK'));
  assert.ok(result.checks.some((item) => item.id === 'working-tree' && item.status === 'BLOCK'));
  assert.ok(result.checks.some((item) => item.id === 'tag' && item.status === 'BLOCK'));
});

test('missing current CI or Doctor warnings require REVIEW', () => {
  const input = readyInput();
  input.ci = { status: 'UNKNOWN', currentHeadCovered: false };
  input.doctor = { status: 'WARNING' };
  const result = evaluateReleaseReadiness(input);
  assert.equal(result.verdict, 'REVIEW');
});

test('calculates next semantic version', () => {
  assert.equal(nextVersion('3.7.0', 'patch'), '3.7.1');
  assert.equal(nextVersion('3.7.0', 'minor'), '3.8.0');
  assert.equal(nextVersion('3.7.0', 'major'), '4.0.0');
});
