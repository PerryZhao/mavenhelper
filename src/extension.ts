import * as vscode from 'vscode';
import * as path from 'path';
import { DependencyIndex } from './dependencyIndex';
import { MavenHelperPanel } from './webview';

export function activate(context: vscode.ExtensionContext): void {
  const index = new DependencyIndex(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('mavenHelper.open', async () => {
      const pomPath = await getActivePomPath();
      if (!pomPath) {
        void vscode.window.showWarningMessage('Open a pom.xml to use Maven Helper.');
        return;
      }
      await MavenHelperPanel.createOrShow(context.extensionUri, index, pomPath);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mavenHelper.openForPom', async (uri?: vscode.Uri) => {
      const pomPath = await getPomPathFromUriOrActive(uri);
      if (!pomPath) {
        void vscode.window.showWarningMessage('Open a pom.xml to use Maven Helper.');
        return;
      }
      await MavenHelperPanel.createOrShow(context.extensionUri, index, pomPath);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mavenHelper.reimport', async () => {
      const pomPath = await getActivePomPath();
      if (!pomPath) {
        void vscode.window.showWarningMessage('Open a pom.xml to reimport dependencies.');
        return;
      }
      try {
        await index.reimportWithProgress(pomPath);
      } catch (err: any) {
        void vscode.window.showErrorMessage(err?.message || 'Failed to reimport dependencies.');
      }
    })
  );
}

export function deactivate(): void {}

async function getActivePomPath(): Promise<string | null> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return null;
  }
  return isPom(editor.document.uri) ? editor.document.uri.fsPath : null;
}

async function getPomPathFromUriOrActive(uri?: vscode.Uri): Promise<string | null> {
  if (uri && isPom(uri)) {
    return uri.fsPath;
  }
  return getActivePomPath();
}

function isPom(uri: vscode.Uri): boolean {
  return uri.fsPath.endsWith(`${path.sep}pom.xml`);
}
