const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  scanWorkspaceArchitecture,
  searchArchitecture
} = require('../src/features/architecture');

function fixture(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'galaxy-architecture-'));
  const src = path.join(root, 'src');
  fs.mkdirSync(src, { recursive: true });

  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', main: './src/index.js' }, null, 2)
  );
  fs.writeFileSync(
    path.join(src, 'index.js'),
    "const util = require('./util');\nmodule.exports = util;\n"
  );
  fs.writeFileSync(
    path.join(src, 'util.js'),
    "// TODO improve helper\nmodule.exports = function helper(){ return 1; };\n"
  );
  fs.writeFileSync(
    path.join(src, 'a.js'),
    "require('./b');\nmodule.exports = 'a';\n"
  );
  fs.writeFileSync(
    path.join(src, 'b.js'),
    "require('./a');\nmodule.exports = 'b';\n"
  );

  try {
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('architecture scan detects entry points and local relationships', () => {
  fixture((root) => {
    const scan = scanWorkspaceArchitecture(root, { maxFiles: 100 });
    assert.ok(scan.entryPoints.some((item) => item.file === 'src/index.js'));
    assert.ok(scan.relationships.some((edge) =>
      edge.from === 'src/index.js' && edge.to === 'src/util.js'
    ));
    assert.ok(scan.languages.some((item) => item.name === 'JavaScript'));
  });
});

test('architecture scan detects cycles and risk hotspots', () => {
  fixture((root) => {
    const scan = scanWorkspaceArchitecture(root, { maxFiles: 100 });
    assert.ok(scan.cycles.some((cycle) =>
      cycle.includes('src/a.js') && cycle.includes('src/b.js')
    ));
    assert.ok(scan.riskFiles.some((item) =>
      item.file === 'src/util.js' && item.todoCount >= 1
    ));
  });
});

test('feature search returns matching workspace files', () => {
  fixture((root) => {
    const scan = scanWorkspaceArchitecture(root, { maxFiles: 100 });
    const results = searchArchitecture(scan, 'improve helper');
    assert.ok(results.length > 0);
    assert.equal(results[0].file, 'src/util.js');
    assert.ok(results[0].line >= 1);
  });
});
