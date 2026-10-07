const fs = require('fs');
const path = require('path');

const LAYER_RULES = [
  {
    id: 'auth',
    label: 'Authentication',
    pathPattern: /(?:^|\/)(?:auth|authentication|login|session|oauth|jwt)(?:[\/._-]|$)/i,
    contentPattern: /\b(?:authenticate|authentication|authorization|sign\s?in|login|logout|oauth|jwt|session|passport|bcrypt)\b/i
  },
  {
    id: 'database',
    label: 'Database',
    pathPattern: /(?:^|\/)(?:db|database|models?|repositories|prisma|supabase|mongoose|typeorm|sequelize)(?:[\/._-]|$)/i,
    contentPattern: /\b(?:database|query|select\s+.+\s+from|insert\s+into|prisma|supabase|mongoose|sequelize|typeorm|postgres|mysql|sqlite)\b/i
  },
  {
    id: 'api',
    label: 'API / HTTP',
    pathPattern: /(?:^|\/)(?:api|routes?|controllers?|handlers?|server)(?:[\/._-]|$)/i,
    contentPattern: /\b(?:fetch\s*\(|axios\.|express\s*\(|router\.|app\.(?:get|post|put|patch|delete)\s*\(|request|response|endpoint)\b/i
  },
  {
    id: 'ui',
    label: 'UI',
    pathPattern: /(?:^|\/)(?:components?|pages?|views?|ui|screens?)(?:[\/._-]|$)/i,
    contentPattern: /\b(?:react|jsx|tsx|component|render\s*\(|createElement|template|webview|html)\b/i
  },
  {
    id: 'tests',
    label: 'Tests',
    pathPattern: /(?:^|\/)(?:test|tests|__tests__|spec)(?:[\/._-]|$)|\.(?:test|spec)\.[^.]+$/i,
    contentPattern: /\b(?:describe\s*\(|it\s*\(|test\s*\(|assert\.|expect\s*\()\b/i
  },
  {
    id: 'config',
    label: 'Configuration',
    pathPattern: /(?:^|\/)(?:config|configuration|settings?)(?:[\/._-]|$)|(?:package\.json|tsconfig\.json|pyproject\.toml)$/i,
    contentPattern: /\b(?:process\.env|dotenv|configuration|settings)\b/i
  }
];

function readText(filePath, maxBytes = 262144) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return '';
    const size = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(size);
    const fd = fs.openSync(filePath, 'r');
    try {
      fs.readSync(fd, buffer, 0, size, 0);
    } finally {
      fs.closeSync(fd);
    }
    const text = buffer.toString('utf8');
    return text.includes('\u0000') ? '' : text;
  } catch {
    return '';
  }
}

function lineNumberAt(text, index) {
  if (!text || index <= 0) return 1;
  return text.slice(0, index).split(/\r?\n/).length;
}

function addSymbol(target, seen, file, name, kind, index, text) {
  const clean = String(name || '').trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(clean)) return;
  const line = lineNumberAt(text, index);
  const key = file.relative + '|' + kind + '|' + clean + '|' + line;
  if (seen.has(key)) return;
  seen.add(key);
  target.push({
    id: file.relative + '#' + clean + ':' + line,
    name: clean,
    kind,
    file: file.relative,
    line
  });
}

function extractSymbols(file, text) {
  const symbols = [];
  const seen = new Set();
  const extension = path.extname(file.relative || '').toLowerCase();
  const patterns = [];

  if (['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.vue', '.svelte'].includes(extension)) {
    patterns.push(
      { kind: 'function', re: /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g },
      { kind: 'class', re: /\b(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/g },
      { kind: 'function', re: /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g }
    );
  } else if (extension === '.py') {
    patterns.push(
      { kind: 'function', re: /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/gm },
      { kind: 'class', re: /^\s*class\s+([A-Za-z_][\w]*)\b/gm }
    );
  } else if (['.java', '.cs', '.go', '.rs', '.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp'].includes(extension)) {
    patterns.push(
      { kind: 'class', re: /\b(?:class|struct|interface|enum)\s+([A-Za-z_][\w]*)\b/g },
      { kind: 'function', re: /\b([A-Za-z_][\w]*)\s*\([^;{}]*\)\s*\{/g }
    );
  }

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.re.exec(text))) {
      addSymbol(symbols, seen, file, match[1], pattern.kind, match.index, text);
      if (symbols.length >= 120) break;
    }
    if (symbols.length >= 120) break;
  }

  return symbols;
}

function classifyFileLayers(file, text) {
  const relative = String(file.relative || '');
  return LAYER_RULES
    .filter((rule) => rule.pathPattern.test(relative) || rule.contentPattern.test(text))
    .map((rule) => ({ id: rule.id, label: rule.label }));
}

function buildReverseEdges(relationships) {
  const reverse = new Map();
  for (const edge of relationships || []) {
    if (!reverse.has(edge.to)) reverse.set(edge.to, []);
    reverse.get(edge.to).push(edge.from);
  }
  return reverse;
}

function buildKnowledgeGraph(scan, options = {}) {
  const files = Array.isArray(scan?.files) ? scan.files : [];
  const maxFiles = Math.max(50, Math.min(1000, Number(options.maxFiles || 700)));
  const selectedFiles = files.slice(0, maxFiles);
  const symbols = [];
  const layers = new Map(
    LAYER_RULES.map((rule) => [
      rule.id,
      { id: rule.id, label: rule.label, files: [] }
    ])
  );
  const textByFile = new Map();

  for (const file of selectedFiles) {
    const text = file.absolute ? readText(file.absolute) : '';
    textByFile.set(file.relative, text);
    symbols.push(...extractSymbols(file, text));

    for (const layer of classifyFileLayers(file, text)) {
      const state = layers.get(layer.id);
      if (state && state.files.length < 40) state.files.push(file.relative);
    }
  }

  const symbolByName = new Map();
  for (const symbol of symbols) {
    const key = symbol.name.toLowerCase();
    if (!symbolByName.has(key)) symbolByName.set(key, []);
    symbolByName.get(key).push(symbol);
  }

  const references = [];
  const commonNames = new Set([
    'main', 'render', 'get', 'set', 'run', 'open', 'close',
    'test', 'map', 'filter'
  ]);

  for (const file of selectedFiles) {
    const text = textByFile.get(file.relative) || '';
    if (!text) continue;

    const identifiers = new Set(text.match(/\b[A-Za-z_$][\w$]*\b/g) || []);
    for (const name of identifiers) {
      if (commonNames.has(name.toLowerCase())) continue;
      const candidates = symbolByName.get(name.toLowerCase());
      if (!candidates || candidates.length !== 1) continue;

      const symbol = candidates[0];
      if (symbol.file === file.relative) continue;

      references.push({
        from: file.relative,
        to: symbol.file,
        symbol: symbol.name,
        kind: 'symbol-reference',
        confidence: 'heuristic'
      });

      if (references.length >= 2500) break;
    }

    if (references.length >= 2500) break;
  }

  const relationships = Array.isArray(scan?.relationships)
    ? scan.relationships
    : [];
  const reverseEdges = buildReverseEdges(relationships);
  const outboundCounts = new Map();

  for (const edge of relationships) {
    outboundCounts.set(edge.from, Number(outboundCounts.get(edge.from) || 0) + 1);
  }

  const fileNodes = selectedFiles.map((file) => ({
    file: file.relative,
    language: file.language || '',
    lines: Number(file.lines || 0),
    inbound: (reverseEdges.get(file.relative) || []).length,
    outbound: Number(outboundCounts.get(file.relative) || 0)
  }));

  return {
    builtAt: Date.now(),
    totalFiles: selectedFiles.length,
    totalSymbols: symbols.length,
    totalRelations: relationships.length,
    totalReferences: references.length,
    files: fileNodes,
    symbols: symbols.slice(0, 4000),
    relationships: relationships.slice(0, 2500),
    references: references.slice(0, 2500),
    layers: Array.from(layers.values()).filter((layer) => layer.files.length > 0)
  };
}

function getFileImpact(graph, file, maxDepth = 3) {
  const target = String(file || '');
  if (!target) return null;

  const outgoing = new Map();
  const incoming = new Map();

  for (const edge of graph?.relationships || []) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    if (!incoming.has(edge.to)) incoming.set(edge.to, []);
    outgoing.get(edge.from).push(edge.to);
    incoming.get(edge.to).push(edge.from);
  }

  const dependencies = Array.from(new Set(outgoing.get(target) || []));
  const directDependents = Array.from(new Set(incoming.get(target) || []));
  const impacted = [];
  const seen = new Set([target]);
  const frontier = directDependents.map((item) => ({ file: item, depth: 1 }));

  while (frontier.length) {
    const current = frontier.shift();
    if (!current || seen.has(current.file) || current.depth > maxDepth) continue;

    seen.add(current.file);
    impacted.push(current);

    for (const next of incoming.get(current.file) || []) {
      if (!seen.has(next)) {
        frontier.push({ file: next, depth: current.depth + 1 });
      }
    }

    if (impacted.length >= 60) break;
  }

  return {
    file: target,
    dependencies,
    directDependents,
    impacted,
    symbols: (graph?.symbols || [])
      .filter((symbol) => symbol.file === target)
      .slice(0, 40),
    risk: impacted.length >= 12
      ? 'HIGH'
      : impacted.length >= 4
        ? 'MEDIUM'
        : 'LOW'
  };
}

function findSymbol(graph, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return [];

  return (graph?.symbols || [])
    .map((symbol) => {
      const name = symbol.name.toLowerCase();
      let score = 0;

      if (name === needle) score = 100;
      else if (name.startsWith(needle)) score = 70;
      else if (name.includes(needle)) score = 45;

      return { ...symbol, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, 30);
}

function getSymbolCallers(graph, query, limit = 30) {
  const matches = findSymbol(graph, query);

  if (!matches.length) {
    return { symbol: null, matches: [], callers: [] };
  }

  const needle = String(query || '').trim().toLowerCase();
  const exact = matches.find((item) => item.name.toLowerCase() === needle);
  const symbol = exact || matches[0];

  const callers = (graph?.references || [])
    .filter((ref) => ref.symbol === symbol.name && ref.to === symbol.file)
    .map((ref) => ({
      file: ref.from,
      confidence: ref.confidence || 'heuristic'
    }))
    .filter(
      (item, index, all) =>
        all.findIndex((other) => other.file === item.file) === index
    )
    .slice(0, Math.max(1, Math.min(60, Number(limit || 30))));

  return { symbol, matches, callers };
}

function searchKnowledgeGraph(graph, query, limit = 20) {
  const tokens = Array.from(
    new Set(
      String(query || '')
        .toLowerCase()
        .split(/[^a-z0-9_$-]+/)
        .filter((item) => item.length >= 2)
    )
  ).slice(0, 12);

  if (!tokens.length) return [];

  const scores = new Map();

  const add = (file, amount, reason) => {
    if (!file) return;
    const current = scores.get(file) || {
      file,
      score: 0,
      reasons: []
    };

    current.score += amount;
    if (reason && !current.reasons.includes(reason)) {
      current.reasons.push(reason);
    }
    scores.set(file, current);
  };

  for (const file of graph?.files || []) {
    const lower = file.file.toLowerCase();
    for (const token of tokens) {
      if (lower.includes(token)) add(file.file, 18, 'filename');
    }
  }

  for (const symbol of graph?.symbols || []) {
    const lower = symbol.name.toLowerCase();
    for (const token of tokens) {
      if (lower === token) add(symbol.file, 30, 'symbol ' + symbol.name);
      else if (lower.includes(token)) add(symbol.file, 12, 'symbol ' + symbol.name);
    }
  }

  const semanticLayerMap = {
    auth: ['auth', 'authentication', 'login', 'session', 'oauth', 'jwt'],
    database: ['database', 'db', 'data', 'storage', 'model', 'repository'],
    api: ['api', 'http', 'route', 'endpoint', 'server'],
    ui: ['ui', 'component', 'page', 'screen', 'view'],
    tests: ['test', 'tests', 'spec']
  };

  for (const layer of graph?.layers || []) {
    const aliases = semanticLayerMap[layer.id] || [layer.id];
    if (
      tokens.some((token) =>
        aliases.some(
          (alias) => alias.includes(token) || token.includes(alias)
        )
      )
    ) {
      for (const file of layer.files) {
        add(file, 24, layer.label + ' layer');
      }
    }
  }

  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, Math.max(1, Math.min(50, Number(limit || 20))));
}

function getLayerFiles(graph, layerId) {
  const needle = String(layerId || '').toLowerCase();
  const layer = (graph?.layers || []).find(
    (item) =>
      item.id === needle ||
      item.label.toLowerCase().includes(needle)
  );

  return layer
    ? { ...layer, files: [...layer.files] }
    : null;
}

function toKnowledgeGraphView(graph) {
  if (!graph) return null;

  return {
    builtAt: graph.builtAt,
    totalFiles: graph.totalFiles,
    totalSymbols: graph.totalSymbols,
    totalRelations: graph.totalRelations,
    totalReferences: graph.totalReferences,
    layers: (graph.layers || []).map((layer) => ({
      id: layer.id,
      label: layer.label,
      count: layer.files.length,
      files: layer.files.slice(0, 12)
    }))
  };
}

module.exports = {
  buildKnowledgeGraph,
  getFileImpact,
  findSymbol,
  getSymbolCallers,
  searchKnowledgeGraph,
  getLayerFiles,
  toKnowledgeGraphView
};
