const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  discoverWorkspaceTasks,
  standardVerifyTasks,
  shipTasks
} = require('../src/features/orchestrator');

function withWorkspace(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'galaxy-orchestrator-'));
  try {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        scripts: {
          prebuild: 'node prep.js',
          build: 'npm run compile',
          compile: 'node build.js',
          lint: 'eslint .',
          test: 'vitest run',
          dev: 'vite'
        }
      }, null, 2)
    );
    fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('task discovery classifies scripts and detects manager', () => {
  withWorkspace((root) => {
    const discovery = discoverWorkspaceTasks(root);
    assert.equal(discovery.packageManager, 'pnpm');
    assert.equal(discovery.packageName, 'fixture');

    const build = discovery.tasks.find((item) => item.name === 'build');
    const lint = discovery.tasks.find((item) => item.name === 'lint');
    const dev = discovery.tasks.find((item) => item.name === 'dev');

    assert.equal(build.kind, 'build');
    assert.equal(lint.kind, 'lint');
    assert.equal(dev.kind, 'dev');
    assert.ok(build.dependencies.includes('prebuild'));
    assert.ok(build.dependencies.includes('compile'));
  });
});

test('command graph contains pre-script and script-reference edges', () => {
  withWorkspace((root) => {
    const discovery = discoverWorkspaceTasks(root);
    assert.ok(discovery.edges.some((edge) =>
      edge.from === 'prebuild' && edge.to === 'build' && edge.reason === 'npm pre-script'
    ));
    assert.ok(discovery.edges.some((edge) =>
      edge.from === 'compile' && edge.to === 'build'
    ));
  });
});

test('verify and ship plans use deterministic task order', () => {
  withWorkspace((root) => {
    const discovery = discoverWorkspaceTasks(root);
    assert.deepEqual(standardVerifyTasks(discovery), ['lint', 'test', 'build']);
    assert.deepEqual(shipTasks(discovery), ['build', 'test']);
  });
});
