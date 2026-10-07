const fs = require('fs');
const path = require('path');

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  'coverage',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  '.idea',
  '.cache',
  'target',
  'bin',
  'obj'
]);

const SOURCE_EXTENSIONS = new Set([
  '.js', '.jsx', '.mjs', '.cjs',
  '.ts', '.tsx',
  '.py',
  '.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp',
  '.java',
  '.cs',
  '.go',
  '.rs',
  '.php',
  '.rb',
  '.vue',
  '.svelte'
]);

const LANGUAGE_BY_EXTENSION = {
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.py': 'Python',
  '.c': 'C',
  '.cc': 'C++',
  '.cpp': 'C++',
  '.cxx': 'C++',
  '.h': 'C/C++ Header',
  '.hh': 'C/C++ Header',
  '.hpp': 'C/C++ Header',
  '.java': 'Java',
  '.cs': 'C#',
  '.go': 'Go',
  '.rs': 'Rust',
  '.php': 'PHP',
  '.rb': 'Ruby',
  '.vue': 'Vue',
  '.svelte': 'Svelte'
};

const ENTRY_NAMES = new Set([
  'index.js', 'index.ts', 'index.tsx', 'index.jsx',
  'main.js', 'main.ts', 'main.tsx', 'main.jsx',
  'app.js', 'app.ts', 'app.tsx', 'app.jsx',
  'server.js', 'server.ts',
  'extension.js', 'extension.ts',
  'manage.py', 'main.py', 'app.py',
  'main.go', 'main.rs',
  'program.cs'
]);

function normalizeRelative(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function readTextSample(filePath, maxBytes = 196608) {
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
    if (text.includes('\u0000')) return '';
    return text;
  } catch {
    return '';
  }
}

function countLines(text) {
  if (!text) return 0;
  return text.split(/\r?\n/).length;
}

function countPattern(text, pattern) {
  if (!text) return 0;
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

function collectFiles(root, maxFiles = 900) {
  const files = [];
  const stack = [root];

  while (stack.length && files.length < maxFiles) {
    const current = stack.pop();
    let entries = [];

    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      if (entry.name.startsWith('.') && entry.name !== '.vscode') {
        if (entry.isDirectory()) continue;
      }

      const absolute = path.join(current, entry.name);

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        stack.push(absolute);
        continue;
      }

      if (!entry.isFile()) continue;

      const extension = path.extname(entry.name).toLowerCase();
      const isSource = SOURCE_EXTENSIONS.has(extension);
      const isConfig = [
        'package.json',
        'pyproject.toml',
        'requirements.txt',
        'cargo.toml',
        'go.mod',
        'pom.xml',
        'build.gradle',
        'settings.gradle',
        'tsconfig.json'
      ].includes(entry.name.toLowerCase());

      if (!isSource && !isConfig) continue;

      const stat = safeStat(absolute);
      if (!stat) continue;

      files.push({
        absolute,
        relative: normalizeRelative(root, absolute),
        name: entry.name,
        extension,
        language: LANGUAGE_BY_EXTENSION[extension] || 'Config',
        size: stat.size,
        isSource
      });
    }
  }

  return files;
}

function resolveCandidate(index, importer, specifier) {
  if (!specifier) return '';
  const importerDir = path.dirname(importer.absolute);

  let base = '';
  if (specifier.startsWith('.')) {
    base = path.resolve(importerDir, specifier);
  } else {
    return '';
  }

  const candidates = [
    base,
    ...Array.from(SOURCE_EXTENSIONS).map((extension) => base + extension),
    ...Array.from(SOURCE_EXTENSIONS).map((extension) => path.join(base, 'index' + extension))
  ];

  for (const candidate of candidates) {
    const relative = index.byAbsolute.get(path.resolve(candidate));
    if (relative) return relative;
  }

  return '';
}

function extractRelations(index, file, text) {
  const relations = [];
  const extension = file.extension;

  if (['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.vue', '.svelte'].includes(extension)) {
    const patterns = [
      /\bfrom\s*['"]([^'"]+)['"]/g,
      /\bimport\s*['"]([^'"]+)['"]/g,
      /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(text))) {
        const target = resolveCandidate(index, file, match[1]);
        if (target) relations.push(target);
      }
    }
  }

  if (['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp'].includes(extension)) {
    const includePattern = /^\s*#include\s*"([^"]+)"/gm;
    let match;
    while ((match = includePattern.exec(text))) {
      const target = resolveCandidate(index, file, './' + match[1]);
      if (target) relations.push(target);
    }
  }

  if (extension === '.py') {
    const relativePattern = /^\s*from\s+(\.+[A-Za-z0-9_\.]+)\s+import\s+/gm;
    let match;
    while ((match = relativePattern.exec(text))) {
      const dots = match[1].match(/^\.+/)?.[0]?.length || 0;
      const tail = match[1].slice(dots).replace(/\./g, '/');
      let baseDir = path.dirname(file.absolute);
      for (let i = 1; i < dots; i++) baseDir = path.dirname(baseDir);
      const specifier = './' + path.relative(path.dirname(file.absolute), path.join(baseDir, tail || '__init__')).split(path.sep).join('/');
      const target = resolveCandidate(index, file, specifier);
      if (target) relations.push(target);
    }
  }

  return Array.from(new Set(relations)).filter((target) => target !== file.relative);
}

function detectPackageEntries(root, fileSet) {
  const results = [];

  const packagePath = path.join(root, 'package.json');
  if (fs.existsSync(packagePath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
      for (const candidate of [
        pkg.main,
        pkg.module,
        pkg.browser,
        typeof pkg.exports === 'string' ? pkg.exports : ''
      ]) {
        if (!candidate) continue;
        const normalized = String(candidate).replace(/^\.\//, '').split(path.sep).join('/');
        if (fileSet.has(normalized)) {
          results.push({ file: normalized, reason: 'package.json entry' });
        }
      }
    } catch {}
  }

  return results;
}

function findCycles(edges) {
  const graph = new Map();
  for (const edge of edges) {
    if (!graph.has(edge.from)) graph.set(edge.from, []);
    graph.get(edge.from).push(edge.to);
  }

  const cycles = [];
  const visiting = new Set();
  const visited = new Set();
  const stack = [];

  function dfs(node) {
    if (cycles.length >= 8) return;
    if (visiting.has(node)) {
      const index = stack.indexOf(node);
      if (index >= 0) {
        const cycle = [...stack.slice(index), node];
        const signature = cycle.join('>');
        if (!cycles.some((item) => item.signature === signature)) {
          cycles.push({ signature, nodes: cycle });
        }
      }
      return;
    }
    if (visited.has(node)) return;

    visiting.add(node);
    stack.push(node);
    for (const next of graph.get(node) || []) dfs(next);
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  }

  for (const node of graph.keys()) dfs(node);
  return cycles.map((item) => item.nodes);
}

function scanWorkspaceArchitecture(root, options = {}) {
  if (!root || !fs.existsSync(root)) {
    return {
      scannedAt: Date.now(),
      root: '',
      totalFiles: 0,
      totalLines: 0,
      truncated: false,
      languages: [],
      topLevel: [],
      entryPoints: [],
      relationships: [],
      centralModules: [],
      largeFiles: [],
      riskFiles: [],
      cycles: [],
      files: []
    };
  }

  const maxFiles = Math.max(100, Math.min(1500, Number(options.maxFiles || 900)));
  const files = collectFiles(root, maxFiles);
  const byAbsolute = new Map();
  const byRelative = new Map();

  for (const file of files) {
    byAbsolute.set(path.resolve(file.absolute), file.relative);
    byRelative.set(file.relative, file);
  }

  const index = { byAbsolute, byRelative };
  const languageCounts = {};
  const topLevelCounts = {};
  const edges = [];
  const riskFiles = [];
  let totalLines = 0;

  for (const file of files) {
    const top = file.relative.split('/')[0] || file.relative;
    const topState = topLevelCounts[top] || { name: top, files: 0, lines: 0 };
    topState.files += 1;

    const text = file.isSource ? readTextSample(file.absolute) : '';
    const lines = file.isSource ? countLines(text) : 0;
    file.lines = lines;
    file.todoCount = file.isSource
      ? countPattern(text, /\b(?:TODO|FIXME|HACK|XXX)\b/gi)
      : 0;

    totalLines += lines;
    topState.lines += lines;
    topLevelCounts[top] = topState;

    languageCounts[file.language] = Number(languageCounts[file.language] || 0) + 1;

    if (file.isSource && text) {
      const relations = extractRelations(index, file, text);
      for (const target of relations) {
        edges.push({ from: file.relative, to: target });
      }

      const riskScore =
        Math.min(60, Math.floor(lines / 120) * 5) +
        Math.min(30, file.todoCount * 6) +
        (file.size > 250000 ? 10 : 0);

      if (riskScore > 0) {
        riskFiles.push({
          file: file.relative,
          lines,
          size: file.size,
          todoCount: file.todoCount,
          riskScore: Math.min(100, riskScore)
        });
      }
    }
  }

  const inbound = {};
  const outbound = {};
  for (const edge of edges) {
    outbound[edge.from] = Number(outbound[edge.from] || 0) + 1;
    inbound[edge.to] = Number(inbound[edge.to] || 0) + 1;
  }

  const centralModules = Array.from(
    new Set([...Object.keys(inbound), ...Object.keys(outbound)])
  )
    .map((file) => ({
      file,
      inbound: Number(inbound[file] || 0),
      outbound: Number(outbound[file] || 0),
      score: Number(inbound[file] || 0) * 2 + Number(outbound[file] || 0)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);

  const fileSet = new Set(files.map((file) => file.relative));
  const entryMap = new Map();

  for (const file of files) {
    if (ENTRY_NAMES.has(file.name.toLowerCase())) {
      entryMap.set(file.relative, {
        file: file.relative,
        reason: 'common entry filename'
      });
    }
  }

  for (const item of detectPackageEntries(root, fileSet)) {
    entryMap.set(item.file, item);
  }

  const zeroInbound = files
    .filter((file) => file.isSource && Number(inbound[file.relative] || 0) === 0)
    .filter((file) => /(^|\/)(main|app|server|index|extension)\.[^.]+$/i.test(file.relative))
    .slice(0, 12);

  for (const file of zeroInbound) {
    if (!entryMap.has(file.relative)) {
      entryMap.set(file.relative, {
        file: file.relative,
        reason: 'root module with no local inbound imports'
      });
    }
  }

  const languages = Object.entries(languageCounts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  const topLevel = Object.values(topLevelCounts)
    .sort((a, b) => b.files - a.files)
    .slice(0, 16);

  const largeFiles = files
    .filter((file) => file.isSource)
    .map((file) => ({
      file: file.relative,
      lines: Number(file.lines || 0),
      size: Number(file.size || 0)
    }))
    .sort((a, b) => b.lines - a.lines || b.size - a.size)
    .slice(0, 12);

  return {
    scannedAt: Date.now(),
    root,
    totalFiles: files.length,
    totalLines,
    truncated: files.length >= maxFiles,
    languages,
    topLevel,
    entryPoints: Array.from(entryMap.values()).slice(0, 16),
    relationships: edges.slice(0, 160),
    centralModules,
    largeFiles,
    riskFiles: riskFiles
      .sort((a, b) => b.riskScore - a.riskScore)
      .slice(0, 12),
    cycles: findCycles(edges),
    files: files.map((file) => ({
      absolute: file.absolute,
      relative: file.relative,
      language: file.language,
      lines: Number(file.lines || 0),
      size: Number(file.size || 0),
      todoCount: Number(file.todoCount || 0)
    }))
  };
}

function tokenizeQuery(query) {
  return Array.from(
    new Set(
      String(query || '')
        .toLowerCase()
        .split(/[^a-z0-9_\-]+/)
        .map((item) => item.trim())
        .filter((item) => item.length >= 2)
    )
  ).slice(0, 12);
}

function snippetAround(text, index, radius = 220) {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

function searchArchitecture(scan, query, limit = 12) {
  if (!scan?.files?.length) return [];
  const tokens = tokenizeQuery(query);
  if (!tokens.length) return [];

  const results = [];

  for (const file of scan.files) {
    const fileName = file.relative.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (fileName.includes(token)) score += 12;
    }

    const text = readTextSample(file.absolute, 262144);
    if (!text) {
      if (score > 0) {
        results.push({
          file: file.relative,
          score,
          line: 1,
          snippet: ''
        });
      }
      continue;
    }

    const lower = text.toLowerCase();
    let firstIndex = -1;

    for (const token of tokens) {
      let index = lower.indexOf(token);
      let occurrences = 0;
      while (index >= 0 && occurrences < 8) {
        if (firstIndex < 0 || index < firstIndex) firstIndex = index;
        score += 3;
        occurrences++;
        index = lower.indexOf(token, index + token.length);
      }
    }

    if (score <= 0) continue;

    const before = firstIndex >= 0 ? text.slice(0, firstIndex) : '';
    const line = firstIndex >= 0 ? before.split(/\r?\n/).length : 1;

    results.push({
      file: file.relative,
      score,
      line,
      snippet: firstIndex >= 0 ? snippetAround(text, firstIndex) : ''
    });
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(30, Number(limit || 12))));
}

function getArchitectureFile(scan, relative) {
  if (!scan?.files?.length) return null;
  return scan.files.find((file) => file.relative === relative) || null;
}

function toArchitectureView(scan) {
  if (!scan) return null;
  const {
    files,
    root,
    ...view
  } = scan;
  return view;
}

module.exports = {
  scanWorkspaceArchitecture,
  searchArchitecture,
  getArchitectureFile,
  toArchitectureView
};
