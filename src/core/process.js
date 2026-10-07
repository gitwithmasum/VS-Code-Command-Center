const { spawn } = require('child_process');

function quoteWindowsArg(value) {
  const text = String(value ?? '');
  if (!text) return '""';
  if (!/[\s"&|<>^]/.test(text)) return text;
  return '"' + text.replace(/(["\\])/g, '\\$1') + '"';
}

function normalizeExecutable(command) {
  return String(command || '').trim();
}

function runCapturedProcess(command, args = [], cwd, timeoutMs = 120000, options = {}) {
  return new Promise((resolve) => {
    const executable = normalizeExecutable(command);
    const safeArgs = Array.isArray(args) ? args.map((value) => String(value)) : [];
    const maxOutput = Math.max(4000, Math.min(100000, Number(options.maxOutput || 24000)));

    let stdout = '';
    let stderr = '';
    let settled = false;
    let child = null;
    let timer = null;
    let abortHandler = null;

    const append = (target, chunk) => {
      const next = target + String(chunk || '');
      return next.length > maxOutput ? next.slice(-maxOutput) : next;
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (abortHandler && options.signal) {
        options.signal.removeEventListener('abort', abortHandler);
      }
      resolve({
        exitCode: Number.isInteger(result.exitCode) ? result.exitCode : -1,
        stdout,
        stderr,
        timedOut: Boolean(result.timedOut),
        cancelled: Boolean(result.cancelled),
        command: executable,
        args: safeArgs
      });
    };

    if (options.signal?.aborted) {
      stderr = append(stderr, '[Galaxy] Task cancelled before start.');
      finish({ exitCode: -1, timedOut: false, cancelled: true });
      return;
    }

    try {
      const isWindowsCmd =
        process.platform === 'win32' &&
        /\.(?:cmd|bat)$/i.test(executable);

      if (isWindowsCmd) {
        const comspec = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
        const commandLine = [
          quoteWindowsArg(executable),
          ...safeArgs.map(quoteWindowsArg)
        ].join(' ');

        child = spawn(comspec, ['/d', '/s', '/c', commandLine], {
          cwd,
          windowsHide: true,
          shell: false,
          env: process.env
        });
      } else {
        child = spawn(executable, safeArgs, {
          cwd,
          windowsHide: true,
          shell: false,
          env: process.env
        });
      }
    } catch (error) {
      stderr = append(stderr, error?.message || String(error));
      finish({ exitCode: -1, timedOut: false });
      return;
    }

    child.stdout?.on('data', (chunk) => {
      stdout = append(stdout, chunk);
    });

    child.stderr?.on('data', (chunk) => {
      stderr = append(stderr, chunk);
    });

    child.on('error', (error) => {
      stderr = append(stderr, error?.message || String(error));
      finish({ exitCode: -1, timedOut: false });
    });

    child.on('close', (code) => {
      finish({
        exitCode: Number.isInteger(code) ? code : -1,
        timedOut: false,
        cancelled: false
      });
    });

    if (options.signal) {
      abortHandler = () => {
        try {
          child.kill();
        } catch {}
        stderr = append(stderr, '\n[Galaxy] Task cancelled by user.');
        finish({ exitCode: -1, timedOut: false, cancelled: true });
      };
      options.signal.addEventListener('abort', abortHandler, { once: true });
    }

    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      stderr = append(stderr, '\n[Galaxy] Task timed out and was stopped.');
      finish({ exitCode: -1, timedOut: true, cancelled: false });
    }, Math.max(1000, Number(timeoutMs || 120000)));
  });
}

module.exports = {
  runCapturedProcess
};
