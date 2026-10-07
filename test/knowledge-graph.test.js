const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildKnowledgeGraph,
  getFileImpact,
  getSymbolCallers,
  searchKnowledgeGraph,
  getLayerFiles
} = require('../src/features/knowledge-graph');

function fixture(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'galaxy-kg-'));
  const src = path.join(root, 'src');
  fs.mkdirSync(path.join(src, 'auth'), { recursive: true });
  fs.mkdirSync(path.join(src, 'db'), { recursive: true });

  const files = {
    'src/auth/session.js':
      'export function createSession(user) { return { user }; }\n',
    'src/controller.js':
      "const { createSession } = require('./auth/session');\n" +
      'function login(user) { return createSession(user); }\n',
    'src/app.js':
      "const controller = require('./controller');\n" +
      'function startApp() { return controller; }\n',
    'src/db/client.js':
      "const database = { query(sql) { return sql; } };\n" +
      'module.exports = database;\n'
  };

  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }

  const scan = {
    files: Object.keys(files).map((relative) => ({
      absolute: path.join(root, relative),
      relative,
      language: 'JavaScript',
      lines: files[relative].split(/\r?\n/).length
    })),
    relationships: [
      { from: 'src/controller.js', to: 'src/auth/session.js' },
      { from: 'src/app.js', to: 'src/controller.js' }
    ]
  };

  try {
    return callback(scan);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('knowledge graph indexes symbols, references and semantic layers', () => {
  fixture((scan) => {
    const graph = buildKnowledgeGraph(scan);

    assert.ok(
      graph.symbols.some((item) => item.name === 'createSession')
    );
    assert.ok(
      graph.references.some(
        (item) =>
          item.from === 'src/controller.js' &&
          item.symbol === 'createSession'
      )
    );
    assert.ok(
      getLayerFiles(graph, 'auth').files.includes('src/auth/session.js')
    );
    assert.ok(
      getLayerFiles(graph, 'database').files.includes('src/db/client.js')
    );
  });
});

test('symbol callers reports files referencing a unique symbol', () => {
  fixture((scan) => {
    const graph = buildKnowledgeGraph(scan);
    const result = getSymbolCallers(graph, 'createSession');

    assert.equal(result.symbol.name, 'createSession');
    assert.ok(
      result.callers.some((item) => item.file === 'src/controller.js')
    );
  });
});

test('file impact follows reverse dependency edges transitively', () => {
  fixture((scan) => {
    const graph = buildKnowledgeGraph(scan);
    const impact = getFileImpact(graph, 'src/auth/session.js');

    assert.deepEqual(
      impact.directDependents,
      ['src/controller.js']
    );
    assert.ok(
      impact.impacted.some(
        (item) => item.file === 'src/app.js' && item.depth === 2
      )
    );
  });
});

test('knowledge search discovers feature/layer files', () => {
  fixture((scan) => {
    const graph = buildKnowledgeGraph(scan);
    const auth = searchKnowledgeGraph(graph, 'authentication flow');
    const db = searchKnowledgeGraph(graph, 'database layer');

    assert.ok(
      auth.some((item) => item.file === 'src/auth/session.js')
    );
    assert.ok(
      db.some((item) => item.file === 'src/db/client.js')
    );
  });
});
