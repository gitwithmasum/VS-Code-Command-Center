const vscode = require('vscode');
const fs = require('fs');

function getWorkspaceRoot() {
  return vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || '';
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function createWorkspaceTerminal(name) {
  const cwd = getWorkspaceRoot();
  return vscode.window.createTerminal({
    name,
    ...(cwd ? { cwd } : {})
  });
}

module.exports = {
  getWorkspaceRoot,
  readJsonIfExists,
  createWorkspaceTerminal
};
