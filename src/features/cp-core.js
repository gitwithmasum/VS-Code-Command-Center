function normalizeOutput(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/g, ''))
    .join('\n')
    .trim();
}

function verdictFromResult(result, expectedOutput = '') {
  if (result?.timedOut) return 'TLE';
  if (Number(result?.exitCode ?? -1) !== 0) return 'RUNTIME ERROR';

  if (
    String(expectedOutput || '').trim() &&
    normalizeOutput(result?.stdout) !== normalizeOutput(expectedOutput)
  ) {
    return 'WRONG ANSWER';
  }

  return 'PASS';
}

function splitCases(value) {
  const text = String(value || '').replace(/\r\n/g, '\n').trim();
  if (!text) return [''];
  return text
    .split(/^\s*---+\s*$/m)
    .map((item) => item.trim());
}

function statusFromVerdict(verdict) {
  if (verdict === 'WRONG ANSWER' || verdict === 'MISMATCH') return 'WA';
  if (verdict === 'TLE') return 'TLE';
  if (verdict === 'RUNTIME ERROR') return 'RE';
  if (verdict === 'COMPILE ERROR') return 'CE';
  return '';
}

module.exports = {
  normalizeOutput,
  verdictFromResult,
  splitCases,
  statusFromVerdict
};
