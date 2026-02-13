import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { execFile } from 'child_process';
import * as os from 'os';

export async function findProjectRoot(): Promise<string | null> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return null;
  }

  for (const folder of folders) {
    const pom = path.join(folder.uri.fsPath, 'pom.xml');
    if (await exists(pom)) {
      return folder.uri.fsPath;
    }
  }

  const found = await vscode.workspace.findFiles('**/pom.xml', '**/{target,node_modules,.git}/**', 1);
  if (found.length === 0) {
    return null;
  }
  return path.dirname(found[0].fsPath);
}

export async function runDependencyTreeVerbose(pomPath: string): Promise<string> {
  const cwd = path.dirname(pomPath);
  const outputFile = path.join(os.tmpdir(), `maven-helper-tree-${Date.now()}.txt`);
  const args = [
    '-DskipTests',
    `-f`,
    pomPath,
    '-Dverbose',
    '-DoutputType=text',
    `-DoutputFile=${outputFile}`,
    'dependency:tree'
  ];
  const result = await execFileAsync('mvn', args, { cwd, maxBuffer: 1024 * 1024 * 20 });
  const fileContent = await readIfExists(outputFile);
  const output = (fileContent || result.stdout || '').trim();
  if (!output) {
    const err = result.stderr?.trim();
    throw new Error(err ? `Maven dependency:tree returned no output. ${err}` : 'Maven dependency:tree returned no output.');
  }
  return output;
}

export async function runEffectivePom(pomPath: string, outputFile: string): Promise<void> {
  const cwd = path.dirname(pomPath);
  const args = ['-q', '-DskipTests', `-f`, pomPath, `-Doutput=${outputFile}`, 'help:effective-pom'];
  await execFileAsync('mvn', args, { cwd, maxBuffer: 1024 * 1024 * 20 });
}

export async function runActiveProfiles(pomPath: string): Promise<string[]> {
  const cwd = path.dirname(pomPath);
  const args = ['-q', '-DskipTests', `-f`, pomPath, '-DforceStdout', 'help:active-profiles'];
  const result = await execFileAsync('mvn', args, { cwd, maxBuffer: 1024 * 1024 * 20 });
  return parseActiveProfiles(result.stdout);
}

function execFileAsync(
  cmd: string,
  args: string[],
  options: { cwd: string; maxBuffer: number }
): Promise<{ stdout: string; stderr: string }>
{
  return new Promise((resolve, reject) => {
    execFile(cmd, args, options, (error, stdout, stderr) => {
      if (error) {
        const message = stderr?.toString() || error.message;
        reject(new Error(message || 'Failed to run Maven command.'));
        return;
      }
      resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readIfExists(p: string): Promise<string | null> {
  try {
    const data = await fs.readFile(p, 'utf8');
    return data;
  } catch {
    return null;
  }
}

function parseActiveProfiles(output: string): string[] {
  const lines = output.split(/\r?\n/);
  const profiles: string[] = [];
  for (const line of lines) {
    const match = line.match(/^-\\s*([^\\s(]+)/);
    if (match && match[1]) {
      profiles.push(match[1].trim());
    }
  }
  return profiles;
}
