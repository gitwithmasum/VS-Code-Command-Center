const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

function activate(context) {
  const disposable = vscode.commands.registerCommand('galaxyCommandCenter.open', () => {
    const panel = vscode.window.createWebviewPanel(
      'galaxyCommandCenter',
      'Masum Galaxy // Command Center',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    const webviewDir = path.join(context.extensionPath, 'webview');
    const html = fs.readFileSync(path.join(webviewDir, 'index.html'), 'utf8');
    const stylesUri = panel.webview.asWebviewUri(
      vscode.Uri.file(path.join(webviewDir, 'styles.css'))
    );
    const scriptUri = panel.webview.asWebviewUri(
      vscode.Uri.file(path.join(webviewDir, 'app.js'))
    );

    const workspaceName =
      vscode.workspace.workspaceFolders?.[0]?.name || 'No workspace open';

    panel.webview.html = html
      .replace('{{stylesUri}}', stylesUri.toString())
      .replace('{{scriptUri}}', scriptUri.toString())
      .replace('{{workspaceName}}', workspaceName);

    panel.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'terminal':
          vscode.commands.executeCommand('workbench.action.terminal.toggleTerminal');
          break;
        case 'explorer':
          vscode.commands.executeCommand('workbench.view.explorer');
          break;
        case 'sourceControl':
          vscode.commands.executeCommand('workbench.view.scm');
          break;
        case 'theme':
          vscode.commands.executeCommand('workbench.action.selectTheme');
          break;
        default:
          break;
      }
    });
  });

  context.subscriptions.push(disposable);
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
