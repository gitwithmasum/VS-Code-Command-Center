function normalizeVersion(value) {
  const text = String(value || '').trim().replace(/^v/i, '');
  const match = text.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/);
  if (!match) return null;

  return {
    raw: text,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || '',
    build: match[5] || '',
    tag: 'v' + text
  };
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^\x24{}()|[\]\\]/g, '\\$&');
}

function extractChangelogSection(markdown, version) {
  const normalized = normalizeVersion(version);
  if (!normalized) return '';

  const lines = String(markdown || '').split(/\r?\n/);
  const header = new RegExp(
    '^#{2,3}\\s+(?:v)?' +
      escapeRegex(normalized.raw) +
      '(?:\\s|$)',
    'i'
  );

  let start = -1;
  let level = 0;

  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^(#{2,3})\s+(.+)$/);
    if (!match || !header.test(lines[index])) continue;
    start = index + 1;
    level = match[1].length;
    break;
  }

  if (start < 0) return '';

  const body = [];
  for (let index = start; index < lines.length; index++) {
    const match = lines[index].match(/^(#{1,6})\s+/);
    if (match && match[1].length <= level) break;
    body.push(lines[index]);
  }

  return body.join('\n').trim();
}

function createCheck(id, label, status, detail) {
  return {
    id,
    label,
    status,
    detail: String(detail || '')
  };
}

function evaluateReleaseReadiness({
  version,
  packageLockVersion = '',
  changelog = '',
  git = {},
  quality = {},
  qualityFingerprintCurrent = false,
  ci = {},
  doctor = {},
  tags = [],
  tagHeadMatches = false
} = {}) {
  const checks = [];
  const add = (id, label, status, detail) => {
    checks.push(createCheck(id, label, status, detail));
  };

  const parsed = normalizeVersion(version);
  if (!parsed) {
    add('version', 'Package version', 'BLOCK', 'package.json version is not valid semantic versioning.');
  } else {
    add('version', 'Package version', 'PASS', parsed.raw);
  }

  if (packageLockVersion) {
    if (parsed && String(packageLockVersion).trim() === parsed.raw) {
      add('lock-version', 'Lockfile version', 'PASS', packageLockVersion);
    } else {
      add(
        'lock-version',
        'Lockfile version',
        'BLOCK',
        'package-lock.json version does not match package.json.'
      );
    }
  }

  const notes = parsed ? extractChangelogSection(changelog, parsed.raw) : '';
  if (notes) {
    add('changelog', 'Changelog entry', 'PASS', 'Release notes found for ' + parsed.raw + '.');
  } else {
    add(
      'changelog',
      'Changelog entry',
      'BLOCK',
      parsed
        ? 'CHANGELOG.md has no section for ' + parsed.raw + '.'
        : 'A valid package version is required before checking the changelog.'
    );
  }

  if (!git?.isGitRepo) {
    add('git', 'Git repository', 'BLOCK', 'Workspace is not a Git repository.');
  } else {
    add('git', 'Git repository', 'PASS', git.branch || 'Git repository detected.');

    if (Number(git.conflicts || 0) > 0) {
      add('conflicts', 'Merge conflicts', 'BLOCK', Number(git.conflicts) + ' unresolved conflict(s).');
    } else {
      add('conflicts', 'Merge conflicts', 'PASS', 'No unresolved conflicts.');
    }

    const dirty =
      Number(git.staged || 0) +
      Number(git.unstaged || 0) +
      Number(git.untracked || 0);

    if (dirty > 0) {
      add('working-tree', 'Working tree', 'BLOCK', dirty + ' uncommitted change(s) remain.');
    } else {
      add('working-tree', 'Working tree', 'PASS', 'Working tree is clean.');
    }

    if (Number(git.behind || 0) > 0) {
      add('upstream', 'Upstream sync', 'BLOCK', 'Branch is behind upstream by ' + Number(git.behind) + ' commit(s).');
    } else if (!git.upstream) {
      add('upstream', 'Upstream sync', 'REVIEW', 'No upstream branch is configured.');
    } else {
      add('upstream', 'Upstream sync', 'PASS', 'Branch is not behind upstream.');
    }
  }

  if (quality?.status === 'BLOCKED') {
    add('quality', 'Quality Gate', 'BLOCK', 'Quality Gate is BLOCKED.');
  } else if (quality?.status === 'READY' && qualityFingerprintCurrent) {
    add('quality', 'Quality Gate', 'PASS', 'Quality Gate is READY for the current Git state.');
  } else {
    add('quality', 'Quality Gate', 'REVIEW', 'Run Quality Gate for the current Git state.');
  }

  if (ci?.status === 'FAIL') {
    add('ci', 'GitHub Actions', 'BLOCK', 'Latest relevant CI failed.');
  } else if (ci?.status === 'RUNNING') {
    add('ci', 'GitHub Actions', 'REVIEW', 'CI is still running.');
  } else if (ci?.status === 'PASS') {
    add(
      'ci',
      'GitHub Actions',
      ci.currentHeadCovered ? 'PASS' : 'REVIEW',
      ci.currentHeadCovered
        ? 'Current HEAD passed CI.'
        : 'Latest branch CI passed; current HEAD is not explicitly covered.'
    );
  } else {
    add('ci', 'GitHub Actions', 'REVIEW', ci?.error || 'No relevant CI result is available.');
  }

  if (doctor?.status === 'CRITICAL') {
    add('doctor', 'Project Doctor', 'BLOCK', 'Project Doctor reports critical findings.');
  } else if (doctor?.status === 'WARNING') {
    add('doctor', 'Project Doctor', 'REVIEW', 'Project Doctor still has warning findings.');
  } else if (doctor?.status === 'GOOD') {
    add('doctor', 'Project Doctor', 'PASS', 'Project Doctor is GOOD.');
  } else {
    add('doctor', 'Project Doctor', 'REVIEW', 'Run Project Doctor before release.');
  }

  const tag = parsed?.tag || '';
  const tagExists = Boolean(tag && (tags || []).includes(tag));

  if (tagExists && tagHeadMatches) {
    add('tag', 'Version tag', 'PASS', tag + ' points to current HEAD.');
  } else if (tagExists) {
    add('tag', 'Version tag', 'BLOCK', tag + ' already exists but does not point to current HEAD.');
  } else if (tag) {
    add('tag', 'Version tag', 'PASS', tag + ' is available to create.');
  }

  const hasBlock = checks.some((item) => item.status === 'BLOCK');
  const hasReview = checks.some((item) => item.status === 'REVIEW');

  return {
    verdict: hasBlock
      ? 'BLOCKED'
      : hasReview
        ? 'REVIEW'
        : tagExists && tagHeadMatches
          ? 'TAGGED'
          : 'READY',
    version: parsed?.raw || String(version || ''),
    tag,
    notes,
    checks,
    counts: {
      block: checks.filter((item) => item.status === 'BLOCK').length,
      review: checks.filter((item) => item.status === 'REVIEW').length,
      pass: checks.filter((item) => item.status === 'PASS').length
    }
  };
}

function nextVersion(version, kind = 'patch') {
  const parsed = normalizeVersion(version);
  if (!parsed) return '';

  if (kind === 'major') return (parsed.major + 1) + '.0.0';
  if (kind === 'minor') return parsed.major + '.' + (parsed.minor + 1) + '.0';
  return parsed.major + '.' + parsed.minor + '.' + (parsed.patch + 1);
}

module.exports = {
  normalizeVersion,
  extractChangelogSection,
  evaluateReleaseReadiness,
  nextVersion
};
