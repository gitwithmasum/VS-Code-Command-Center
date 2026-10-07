const fs = require('fs');
const path = require('path');
const { runCapturedProcess } = require('../core/process');

function readPackageJson(root) {
  if (!root) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

function detectPackageManager(root) {
  if (!root) return 'npm';
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function classifyTask(name, command) {
  const value = (String(name || '') + ' ' + String(command || '')).toLowerCase();
  if (/\b(lint|eslint|stylelint)\b/.test(value)) return 'lint';
  if (/\b(typecheck|type-check|tsc\b)/.test(value)) return 'typecheck';
  if (/\b(test|jest|vitest|mocha|playwright|cypress)\b/.test(value)) return 'test';
  if (/\b(build|compile|bundle)\b/.test(value)) return 'build';
  if (/\b(dev|serve|start|preview)\b/.test(value)) return 'dev';
  if (/\b(format|prettier)\b/.test(value)) return 'format';
  if (/\b(clean)\b/.test(value)) return 'clean';
  if (/\b(deploy|publish|release)\b/.test(value)) return 'release';
  return 'custom';
}

function parseScriptReferences(command, scripts) {
  const text = String(command || '');
  const refs = new Set();
  const patterns = [
    /\bnpm(?:\.cmd)?\s+run\s+([\w:.-]+)/gi,
    /\bpnpm(?:\.cmd)?\s+(?:run\s+)?([\w:.-]+)/gi,
    /\byarn(?:\.cmd)?\s+(?:run\s+)?([\w:.-]+)/gi
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text))) {
      if (Object.prototype.hasOwnProperty.call(scripts, match[1])) {
        refs.add(match[1]);
      }
    }
  }

  return Array.from(refs);
}

function discoverWorkspaceTasks(root) {
  const pkg = readPackageJson(root);
  const scripts = pkg?.scripts || {};
  const names = Object.keys(scripts).sort((a, b) => a.localeCompare(b));

  const tasks = names.map((name) => {
    const command = String(scripts[name] || '');
    const dependencies = parseScriptReferences(command, scripts);

    const preName = 'pre' + name;
    if (
      preName !== name &&
      Object.prototype.hasOwnProperty.call(scripts, preName) &&
      !dependencies.includes(preName)
    ) {
      dependencies.unshift(preName);
    }

    return {
      id: 'package:' + name,
      name,
      label: name,
      command,
      kind: classifyTask(name, command),
      dependencies,
      source: 'package.json'
    };
  });

  const edges = [];
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      edges.push({
        from: dependency,
        to: task.name,
        reason: dependency === 'pre' + task.name ? 'npm pre-script' : 'script reference'
      });
    }
  }

  const preferred = {
    lint: ['lint'],
    typecheck: ['typecheck', 'type-check', 'check:types'],
    test: ['test', 'test:unit', 'test:ci'],
    build: ['build']
  };

  const standard = {};
  for (const [kind, candidates] of Object.entries(preferred)) {
    standard[kind] = candidates.find((name) =>
      Object.prototype.hasOwnProperty.call(scripts, name)
    ) || '';
  }

  return {
    packageManager: detectPackageManager(root),
    packageName: pkg?.name || path.basename(root || ''),
    tasks,
    edges,
    standard
  };
}

function executableForPackageManager(packageManager) {
  const name =
    packageManager === 'pnpm' ? 'pnpm' :
    packageManager === 'yarn' ? 'yarn' :
    'npm';

  return process.platform === 'win32' ? name + '.cmd' : name;
}

function argsForScript(packageManager, script) {
  if (packageManager === 'yarn') return [script];
  return ['run', script];
}

function normalizeOutput(stdout, stderr, maxLength = 12000) {
  const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
  if (!combined) return '[no output]';
  return combined.length > maxLength ? combined.slice(-maxLength) : combined;
}

async function runWorkspaceTask(root, discovery, taskName, options = {}) {
  const task = discovery?.tasks?.find((item) => item.name === taskName);
  if (!task) {
    return {
      name: taskName,
      kind: 'missing',
      passed: false,
      exitCode: -1,
      timedOut: false,
      durationMs: 0,
      output: 'Task not found.'
    };
  }

  const startedAt = Date.now();
  const executable = executableForPackageManager(discovery.packageManager);
  const args = argsForScript(discovery.packageManager, task.name);

  const result = await runCapturedProcess(
    executable,
    args,
    root,
    Math.max(1000, Number(options.timeoutMs || 180000)),
    {
      maxOutput: 32000,
      signal: options.signal
    }
  );

  return {
    name: task.name,
    kind: task.kind,
    command: discovery.packageManager + ' ' + args.join(' '),
    passed: result.exitCode === 0,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    cancelled: Boolean(result.cancelled),
    durationMs: Date.now() - startedAt,
    output: normalizeOutput(result.stdout, result.stderr)
  };
}

async function runTaskPlan(root, discovery, taskNames, options = {}) {
  const uniqueNames = Array.from(
    new Set((taskNames || []).map((item) => String(item || '')).filter(Boolean))
  ).slice(0, 20);

  const mode = options.mode === 'parallel' ? 'parallel' : 'sequential';
  const stopOnFailure = options.stopOnFailure !== false;
  const startedAt = Date.now();
  const results = [];

  if (mode === 'parallel') {
    const parallel = await Promise.all(
      uniqueNames.map((name) =>
        runWorkspaceTask(root, discovery, name, options)
      )
    );
    results.push(...parallel);
  } else {
    for (const name of uniqueNames) {
      if (options.signal?.aborted) break;
      const result = await runWorkspaceTask(root, discovery, name, options);
      results.push(result);
      if (result.cancelled) break;
      if (!result.passed && stopOnFailure) break;
    }
  }

  const cancelled = Boolean(options.signal?.aborted) ||
    results.some((item) => item.cancelled);
  const passed = !cancelled &&
    results.length === uniqueNames.length &&
    results.every((item) => item.passed);

  return {
    mode,
    stopOnFailure,
    requested: uniqueNames,
    results,
    passed,
    cancelled,
    startedAt,
    finishedAt: Date.now(),
    durationMs: Date.now() - startedAt
  };
}

function standardVerifyTasks(discovery) {
  const order = ['lint', 'typecheck', 'test', 'build'];
  return order
    .map((kind) => discovery?.standard?.[kind])
    .filter(Boolean);
}

function shipTasks(discovery) {
  const order = ['build', 'test'];
  const selected = order
    .map((kind) => discovery?.standard?.[kind])
    .filter(Boolean);

  return selected.length ? selected : standardVerifyTasks(discovery);
}

module.exports = {
  discoverWorkspaceTasks,
  runWorkspaceTask,
  runTaskPlan,
  standardVerifyTasks,
  shipTasks
};
