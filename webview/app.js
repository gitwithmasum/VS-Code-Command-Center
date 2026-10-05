const vscode = acquireVsCodeApi();

document.querySelectorAll('[data-command]').forEach((button) => {
  button.addEventListener('click', () => {
    vscode.postMessage({ command: button.dataset.command });
  });
});
