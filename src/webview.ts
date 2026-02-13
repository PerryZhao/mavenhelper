import * as vscode from 'vscode';
import * as path from 'path';
import { DependencyIndex, DependencyIndexData } from './dependencyIndex';

export class MavenHelperPanel {
  public static currentPanel: MavenHelperPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static async createOrShow(extensionUri: vscode.Uri, index: DependencyIndex, pomPath: string): Promise<void> {
    const column = vscode.ViewColumn.Beside;

    if (MavenHelperPanel.currentPanel) {
      MavenHelperPanel.currentPanel.panel.reveal(column);
      MavenHelperPanel.currentPanel.setPomPath(pomPath);
      await MavenHelperPanel.currentPanel.refresh(index);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'mavenHelper',
      'Maven Helper',
      column,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, 'media')
        ]
      }
    );

    MavenHelperPanel.currentPanel = new MavenHelperPanel(panel, extensionUri, index, pomPath);
  }

  private pomPath: string;
  private watcher: vscode.FileSystemWatcher | null = null;

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, index: DependencyIndex, pomPath: string) {
    this.panel = panel;
    this.pomPath = pomPath;
    this.panel.webview.html = this.getHtml(this.panel.webview, extensionUri);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    index.onDidUpdate((data) => this.postIndex(data), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        if (message.type === 'reimport') {
          try {
            await index.reimportWithProgress(this.pomPath);
          } catch (err: any) {
            void vscode.window.showErrorMessage(err?.message || 'Failed to reimport dependencies.');
          }
          return;
        }

        if (message.type === 'requestData') {
          this.postIndex(index.getCurrent());
          return;
        }

        if (message.type === 'openPathNode') {
          await index.openPathNode(message.id, message.prevId || undefined);
          return;
        }

        if (message.type === 'resolveManagedInfo') {
          const managedInfo = await index.resolveManagedInfo(message.id);
          this.panel.webview.postMessage({
            type: 'managedInfo',
            id: message.id,
            managedInfo
          });
          return;
        }

        if (message.type === 'openDependencyLocate') {
          await index.openDependencyLocate(message.id);
          return;
        }

        if (message.type === 'openManagedLocation') {
          if (message.location) {
            await index.openPomLocation(message.location);
          }
          return;
        }
      },
      null,
      this.disposables
    );

    void this.refresh(index);
  }

  private postIndex(data: DependencyIndexData | null): void {
    this.panel.webview.postMessage({ type: 'index', data });
  }

  private getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'style.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.js'));
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link href="${styleUri}" rel="stylesheet">
  <title>Maven Helper</title>
</head>
<body>
  <div id="app">
    <header class="header">
      <div class="title">Maven Helper</div>
      <div class="actions">
        <button id="reimport" class="btn">Reimport</button>
      </div>
    </header>

    <section class="filters">
      <div class="field">
        <label>GroupId</label>
        <input id="filter-group" type="text" placeholder="org.apache.*">
      </div>
      <div class="field">
        <label>ArtifactId</label>
        <input id="filter-artifact" type="text" placeholder="commons-io">
      </div>
      <div class="field">
        <label>Version</label>
        <input id="filter-version" type="text" placeholder="1.2.3">
      </div>
      <div class="field">
        <label>Classifier</label>
        <input id="filter-classifier" type="text" placeholder="sources">
      </div>
      <div class="meta" id="meta"></div>
    </section>

    <section id="content" class="content"></section>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  public dispose(): void {
    MavenHelperPanel.currentPanel = undefined;
    this.watcher?.dispose();
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }

  private setPomPath(pomPath: string): void {
    if (this.pomPath === pomPath) {
      return;
    }
    this.pomPath = pomPath;
    this.watcher?.dispose();
    this.watcher = null;
  }

  private async refresh(index: DependencyIndex): Promise<void> {
    this.panel.title = `Maven Helper: ${path.basename(this.pomPath)}`;
    await index.ensureFresh(this.pomPath);
    this.postIndex(index.getCurrent());
    this.ensureWatcher(index);
  }

  private ensureWatcher(index: DependencyIndex): void {
    if (this.watcher) {
      return;
    }
    const pattern = new vscode.RelativePattern(path.dirname(this.pomPath), path.basename(this.pomPath));
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.watcher.onDidChange(() => {
      void index.reimportWithProgress(this.pomPath);
    });
    this.watcher.onDidCreate(() => {
      void index.reimportWithProgress(this.pomPath);
    });
    this.watcher.onDidDelete(() => {
      void vscode.window.showWarningMessage('pom.xml was deleted. Maven Helper view is stale.');
    });
    this.disposables.push(this.watcher);
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
