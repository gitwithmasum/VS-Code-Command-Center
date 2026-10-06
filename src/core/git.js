const { execFileSync } = require('child_process');

function runGit(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return '';
  }
}

function remoteToWebUrl(remoteUrl) {
  const raw = String(remoteUrl || '').trim();
  if (!raw) return '';

  const scpMatch = raw.match(/^git@([^:]+):(.+)$/);
  if (scpMatch) {
    return `https://${scpMatch[1]}/${scpMatch[2].replace(/\.git$/i, '')}`;
  }

  const sshMatch = raw.match(/^ssh:\/\/git@([^/]+)\/(.+)$/);
  if (sshMatch) {
    return `https://${sshMatch[1]}/${sshMatch[2].replace(/\.git$/i, '')}`;
  }

  if (/^https?:\/\//i.test(raw)) {
    return raw.replace(/\.git$/i, '');
  }

  return '';
}

function detectRemoteProvider(remoteUrl) {
  const value = String(remoteUrl || '').toLowerCase();
  if (!value) return 'Local only';
  if (value.includes('github.com')) return 'GitHub';
  if (value.includes('gitlab.com')) return 'GitLab';
  if (value.includes('bitbucket.org')) return 'Bitbucket';
  if (value.includes('dev.azure.com') || value.includes('visualstudio.com')) {
    return 'Azure DevOps';
  }
  return 'Git Remote';
}

module.exports = {
  runGit,
  remoteToWebUrl,
  detectRemoteProvider
};
