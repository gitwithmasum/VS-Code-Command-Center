const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeOutput,
  verdictFromResult,
  splitCases,
  statusFromVerdict
} = require('../src/features/cp-core');

test('CP output normalization ignores CRLF and trailing whitespace', () => {
  assert.equal(
    normalizeOutput('1 2 3   \r\nhello\t\r\n\r\n'),
    '1 2 3\nhello'
  );
});

test('CP verdict mapping handles pass, WA, TLE, and runtime errors', () => {
  assert.equal(
    verdictFromResult({ exitCode: 0, timedOut: false, stdout: '42\n' }, '42'),
    'PASS'
  );
  assert.equal(
    verdictFromResult({ exitCode: 0, timedOut: false, stdout: '41' }, '42'),
    'WRONG ANSWER'
  );
  assert.equal(
    verdictFromResult({ exitCode: 0, timedOut: true, stdout: '' }, ''),
    'TLE'
  );
  assert.equal(
    verdictFromResult({ exitCode: 1, timedOut: false, stdout: '' }, ''),
    'RUNTIME ERROR'
  );
});

test('multi-case parser splits on separator-only lines', () => {
  assert.deepEqual(
    splitCases('1\n---\n2\n---\n3'),
    ['1', '2', '3']
  );
  assert.deepEqual(splitCases(''), ['']);
});

test('judge verdicts map to tracker states without auto-AC', () => {
  assert.equal(statusFromVerdict('WRONG ANSWER'), 'WA');
  assert.equal(statusFromVerdict('MISMATCH'), 'WA');
  assert.equal(statusFromVerdict('TLE'), 'TLE');
  assert.equal(statusFromVerdict('RUNTIME ERROR'), 'RE');
  assert.equal(statusFromVerdict('COMPILE ERROR'), 'CE');
  assert.equal(statusFromVerdict('PASS'), '');
});
