import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { findProjectRoot, runActiveProfiles, runDependencyTreeVerbose, runEffectivePom } from './maven';
import { PomLocation, findDependencyDeclaration, getProjectCoordinates, resolveVersionOrigin } from './pom';

export type DepNode = {
  id: string;
  groupId: string;
  artifactId: string;
  version: string;
  classifier?: string;
  packaging?: string;
  scope?: string;
  managedFromVersion?: string;
  omittedReason?: string;
  conflictWithVersion?: string;
  children: string[];
  parents: string[];
};

export type DependencyIndexData = {
  projectRoot: string;
  pomPath: string;
  moduleRoot: string;
  profiles: string[];
  pomHash: string;
  effectivePomPath?: string;
  generatedAt: string;
  nodes: Record<string, DepNode>;
  roots: string[];
};

export class DependencyIndex {
  private emitter = new vscode.EventEmitter<DependencyIndexData>();
  public readonly onDidUpdate = this.emitter.event;
  private current: DependencyIndexData | null = null;
  private pathTargetCache = new Map<string, { file: string; location?: PomLocation; readonly: boolean; sourceHint?: string } | null>();

  constructor(private readonly context: vscode.ExtensionContext) { }

  getCurrent(): DependencyIndexData | null {
    return this.current;
  }

  async loadCache(pomPath?: string): Promise<void> {
    const cachePath = this.getCachePath(pomPath || this.current?.pomPath || '');
    try {
      const raw = await fs.readFile(cachePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<DependencyIndexData>;
      if (parsed.projectRoot && parsed.pomPath) {
        this.current = {
          projectRoot: parsed.projectRoot,
          pomPath: parsed.pomPath,
          moduleRoot: parsed.moduleRoot || parsed.projectRoot,
          profiles: parsed.profiles || [],
          pomHash: parsed.pomHash || '',
          effectivePomPath: parsed.effectivePomPath,
          generatedAt: parsed.generatedAt || new Date(0).toISOString(),
          nodes: parsed.nodes || {},
          roots: parsed.roots || []
        };
      }
    } catch {
      // ignore cache miss
    }
  }

  async reimport(pomPath: string): Promise<DependencyIndexData> {
    const root = await findProjectRoot();
    if (!root) {
      throw new Error('No pom.xml found in this workspace.');
    }
    await this.clearCache(pomPath);
    const moduleRoot = path.dirname(pomPath);
    const profiles = await runActiveProfiles(pomPath);
    const verbose = await runDependencyTreeVerbose(pomPath);
    const effectivePomPath = await this.generateEffectivePom(pomPath);
    const pomHash = await hashFile(pomPath);
    const index = parseVerboseTree(verbose, root);
    index.pomPath = pomPath;
    index.moduleRoot = moduleRoot;
    index.profiles = profiles;
    index.pomHash = pomHash;
    index.effectivePomPath = effectivePomPath;
    await this.saveCache(index);
    this.current = index;
    this.pathTargetCache.clear();
    invalidateWorkspacePomIndexCache();
    this.emitter.fire(index);
    return index;
  }

  async ensureFresh(pomPath: string): Promise<DependencyIndexData> {
    await this.loadCache(pomPath);
    const currentHash = await hashFile(pomPath);
    if (!this.current || this.current.pomPath !== pomPath || this.current.pomHash !== currentHash) {
      return this.reimportWithProgress(pomPath);
    }
    return this.current;
  }

  async reimportWithProgress(pomPath: string): Promise<DependencyIndexData> {
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Maven Helper: Reimporting dependencies',
        cancellable: false
      },
      async () => this.reimport(pomPath)
    );
  }

  async openSource(dep: DepNode): Promise<void> {
    const currentPom = this.current?.pomPath;
    if (!currentPom) {
      vscode.window.showWarningMessage('No active pom.xml selected.');
      return;
    }

    const candidatePoms = await this.getWorkspaceChainPomCandidates(dep);
    for (const candidatePom of candidatePoms) {
      const declaration = await findDependencyDeclaration(candidatePom, dep.groupId, dep.artifactId);
      if (declaration) {
        await openLocationInEditor(declaration);
        return;
      }
    }

    vscode.window.showWarningMessage('Dependency declaration not found in current classpath chain pom.xml files.');
  }

  async openLocation(dep: DepNode): Promise<void> {
    const pomPath = this.current?.pomPath;
    if (!pomPath) {
      vscode.window.showWarningMessage('No active pom.xml selected.');
      return;
    }

    const candidatePoms = await this.getWorkspaceChainPomCandidates(dep);
    let locations: PomLocation[] = [];
    for (const candidatePom of candidatePoms) {
      locations = await resolveVersionOrigin(candidatePom, dep, {
        profiles: this.current?.profiles ?? []
      });
      if (locations.length > 0) {
        break;
      }
    }

    if (locations.length === 0) {
      vscode.window.showWarningMessage('No version origin found for this dependency.');
      return;
    }

    await openLocationInEditor(locations[0]);

    if (locations.length > 1) {
      const details = locations.map(formatLocation).join('\n');
      void vscode.window.showInformationMessage(`Other possible version origins:\n${details}`);
    }
  }

  async openPomLocation(location: PomLocation): Promise<void> {
    await openLocationInEditor(location);
  }

  async openDependencyLocate(id: string): Promise<void> {
    const target = await this.resolveDependencyLocateTarget(id, true);
    if (!target) {
      const dep = this.current?.nodes[id];
      const ga = dep ? `${dep.groupId}:${dep.artifactId}` : id;
      vscode.window.showWarningMessage(`No version origin location found for ${ga}.`);
      return;
    }
    if (target.location) {
      await openLocationInEditor(target.location);
    } else {
      await openPomFile(target.file, target.readonly);
    }
    if (target.readonly) {
      void vscode.window.showInformationMessage(target.sourceHint || 'Opened external pom.xml (read-only).');
    }
  }

  async resolveManagedInfo(
    id: string
  ): Promise<{
    managedFrom: string;
    managedTo?: string;
    location?: PomLocation;
    bomImportLocation?: PomLocation;
    managementChain: PomLocation[];
    kind?: string;
  } | null> {
    const currentPom = this.current?.pomPath;
    if (!currentPom || !this.current) {
      return null;
    }

    const dep = this.current.nodes[id];
    if (!dep) {
      return null;
    }

    const managedFrom = this.collectManagedFromVersion(dep);

    const depForOrigin: DepNode = {
      ...dep,
      managedFromVersion: dep.managedFromVersion || managedFrom
    };
    const locations = await resolveVersionOrigin(currentPom, depForOrigin, {
      profiles: this.current.profiles || []
    });
    const managedLocation = locations.find((l) =>
      l.kind === 'dependencyManagement' || l.kind === 'bom' || l.kind === 'property'
    );
    const bomImportLocation = locations.find((l) => l.kind === 'bomImport');
    const managementChain = locations.filter(
      (l) => l.kind === 'dependencyManagement' || l.kind === 'bomImport' || l.kind === 'bom' || l.kind === 'property'
    );
    if (!managedFrom && !managedLocation && !bomImportLocation && managementChain.length === 0) {
      return null;
    }

    return {
      managedFrom,
      managedTo: dep.version,
      location: managedLocation,
      bomImportLocation,
      managementChain,
      kind: managedLocation?.kind
    };
  }

  async openPathNode(id: string, prevId?: string): Promise<void> {
    const target = await this.resolvePathNodeTargetCached(id, prevId, true);
    if (!target) {
      const parsed = parseCoord(id);
      vscode.window.showWarningMessage(`No workspace or Nexus pom.xml found for ${parsed.groupId}:${parsed.artifactId}.`);
      return;
    }
    if (target.location) {
      await openLocationInEditor(target.location);
      return;
    }
    await openPomFile(target.file, target.readonly);
    if (target.readonly) {
      void vscode.window.showInformationMessage(target.sourceHint || 'Opened external pom.xml (read-only).');
    }
  }

  async previewPathNodeTarget(id: string, prevId?: string): Promise<string> {
    const target = await this.resolvePathNodeTargetCached(id, prevId, false);
    if (!target) {
      const urls = getNexusRepositoryUrls();
      if (urls.length > 0) {
        return 'Nexus pom.xml (fetch on click)';
      }
      return 'target not found';
    }
    const fileName = path.basename(target.file);
    const line = target.location?.line ? `:${target.location.line}` : '';
    const mode = target.readonly ? ' [read-only]' : '';
    return `${fileName}${line}${mode}`;
  }

  private getCachePath(pomPath: string): string {
    const cacheDir = getCacheDir(pomPath);
    return path.join(cacheDir, 'tree_index');
  }

  private async saveCache(index: DependencyIndexData): Promise<void> {
    const cacheDir = getCacheDir(index.pomPath);
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(this.getCachePath(index.pomPath), JSON.stringify(index, null, 2), 'utf8');
  }

  private async generateEffectivePom(pomPath: string): Promise<string | undefined> {
    const output = path.join(getCacheDir(pomPath), 'effective-pom.xml');
    try {
      await fs.mkdir(getCacheDir(pomPath), { recursive: true });
      await runEffectivePom(pomPath, output);
      return output;
    } catch {
      return undefined;
    }
  }

  private async clearCache(pomPath: string): Promise<void> {
    const cacheDir = getCacheDir(pomPath);
    try {
      await fs.rm(cacheDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }

  private async getWorkspaceChainPomCandidates(dep: DepNode): Promise<string[]> {
    const currentPom = this.current?.pomPath;
    if (!currentPom || !this.current) {
      return [];
    }

    const candidates: string[] = [];
    pushUnique(candidates, currentPom);

    const ancestry = collectAncestorIds(this.current.nodes, dep.id);
    for (const ancestorId of ancestry) {
      const workspacePom = await findWorkspacePomForId(ancestorId);
      if (workspacePom) {
        pushUnique(candidates, workspacePom);
      }
    }
    return candidates;
  }

  private async resolvePathNodeTarget(
    id: string,
    prevId: string | undefined,
    includeRemote: boolean
  ): Promise<{ file: string; location?: PomLocation; readonly: boolean; sourceHint?: string } | null> {
    if (!id) {
      return null;
    }

    if (prevId) {
      const parentTarget = await resolvePomTargetById(prevId, this.current?.pomPath, includeRemote);
      if (parentTarget) {
        const current = parseCoord(id);
        if (current.groupId && current.artifactId) {
          const declaration = await findDependencyDeclaration(parentTarget.file, current.groupId, current.artifactId);
          if (declaration) {
            return {
              file: parentTarget.file,
              location: declaration,
              readonly: parentTarget.readonly,
              sourceHint: parentTarget.sourceHint
            };
          }
        }
        return parentTarget;
      }
    }

    const selfTarget = await resolvePomTargetById(id, this.current?.pomPath, includeRemote);
    if (selfTarget) {
      return selfTarget;
    }

    const currentPom = this.current?.pomPath;
    if (currentPom) {
      const self = parseCoord(id);
      if (self.groupId && self.artifactId) {
        const declaration = await findDependencyDeclaration(currentPom, self.groupId, self.artifactId);
        if (declaration) {
          return { file: currentPom, location: declaration, readonly: false };
        }
      }
    }

    return null;
  }

  private async resolvePathNodeTargetCached(
    id: string,
    prevId: string | undefined,
    includeRemote: boolean
  ): Promise<{ file: string; location?: PomLocation; readonly: boolean; sourceHint?: string } | null> {
    const key = `${includeRemote ? 'R' : 'L'}|${prevId || 'ROOT'}=>${id}`;
    if (this.pathTargetCache.has(key)) {
      return this.pathTargetCache.get(key) || null;
    }
    const target = await this.resolvePathNodeTarget(id, prevId, includeRemote);
    this.pathTargetCache.set(key, target);
    return target;
  }

  private async resolveDependencyLocateTarget(
    id: string,
    includeRemote: boolean
  ): Promise<{ file: string; location?: PomLocation; readonly: boolean; sourceHint?: string } | null> {
    const currentPom = this.current?.pomPath;
    const dep = this.current?.nodes[id];
    if (!currentPom || !dep) {
      return null;
    }

    const managedFrom = this.collectManagedFromVersion(dep);
    const depForOrigin: DepNode = {
      ...dep,
      managedFromVersion: dep.managedFromVersion || managedFrom
    };
    const locations = await resolveVersionOrigin(currentPom, depForOrigin, {
      profiles: this.current?.profiles || []
    });
    const preferred =
      locations.find((l) => l.kind === 'dependencyManagement' || l.kind === 'bom' || l.kind === 'property') ||
      locations[0];
    if (preferred) {
      return {
        file: preferred.file,
        location: preferred,
        readonly: !isUnderWorkspace(preferred.file),
        sourceHint: isUnderWorkspace(preferred.file) ? undefined : 'Opened external pom.xml (read-only).'
      };
    }

    const shortestPath = this.findShortestPathToRoot(id);
    if (shortestPath.length >= 2) {
      const prevId = shortestPath[1];
      return this.resolvePathNodeTarget(id, prevId, includeRemote);
    }

    return this.resolvePathNodeTarget(id, undefined, includeRemote);
  }

  private findShortestPathToRoot(id: string): string[] {
    if (!this.current?.nodes[id]) {
      return [];
    }
    const queue: Array<{ id: string; path: string[] }> = [{ id, path: [id] }];
    const visited = new Set<string>([id]);

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        break;
      }
      const node = this.current.nodes[current.id];
      if (!node || !node.parents || node.parents.length === 0) {
        return current.path;
      }
      for (const parent of node.parents) {
        if (visited.has(parent)) {
          continue;
        }
        visited.add(parent);
        queue.push({ id: parent, path: [...current.path, parent] });
      }
    }

    return [];
  }

  private collectManagedFromVersion(dep: DepNode): string {
    const direct = dep.managedFromVersion || extractManagedFromOmitted(dep.omittedReason);
    if (direct) {
      return direct;
    }
    if (!this.current) {
      return '';
    }
    const siblings = Object.values(this.current.nodes).filter(
      (n) =>
        n.groupId === dep.groupId &&
        n.artifactId === dep.artifactId &&
        (n.classifier || '') === (dep.classifier || '')
    );
    for (const sibling of siblings) {
      const value = sibling.managedFromVersion || extractManagedFromOmitted(sibling.omittedReason);
      if (value) {
        return value;
      }
    }
    return '';
  }
}

function parseVerboseTree(output: string, projectRoot: string): DependencyIndexData {
  const nodes: Record<string, DepNode> = {};
  const roots: string[] = [];
  const stack: string[] = [];

  const lines = output.split(/\r?\n/);
  for (const raw of lines) {
    let line = raw.replace(/^\[INFO\]\s*/, '').trimEnd();
    if (!line || !line.includes(':')) {
      continue;
    }

    const parsed = parseTreeLine(line);
    if (!parsed) {
      continue;
    }

    const { depth, coord, managedFromVersion, omittedReason, conflictWithVersion } = parsed;
    const id = cleanCoord(coord);
    if (!id.includes(':')) {
      continue;
    }

    const node = nodes[id] ?? createNode(id);
    if (managedFromVersion) {
      node.managedFromVersion = managedFromVersion;
    }
    if (omittedReason) {
      node.omittedReason = omittedReason;
    }
    if (conflictWithVersion) {
      node.conflictWithVersion = conflictWithVersion;
    }
    nodes[id] = node;

    if (depth === 0) {
      roots.push(id);
      stack.length = 0;
      stack.push(id);
      continue;
    }

    while (stack.length > depth) {
      stack.pop();
    }
    const parent = stack[depth - 1];
    if (parent) {
      if (!nodes[parent]) {
        nodes[parent] = createNode(parent);
      }
      pushUnique(nodes[parent].children, id);
      pushUnique(nodes[id].parents, parent);
    }
    stack[depth] = id;
  }

  const uniqueRoots = [...new Set(roots.length ? roots : Object.keys(nodes))].filter(
    (id) => nodes[id]?.parents.length === 0
  );

  return {
    projectRoot,
    pomPath: '',
    moduleRoot: projectRoot,
    profiles: [],
    pomHash: '',
    generatedAt: new Date().toISOString(),
    nodes,
    roots: uniqueRoots
  };
}

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) {
    list.push(value);
  }
}

function parseTreeLine(
  line: string
): { depth: number; coord: string; managedFromVersion?: string; omittedReason?: string; conflictWithVersion?: string } | null {
  if (line.startsWith('+- ') || line.startsWith('\\- ')) {
    return parseTreePayload(line.slice(3), 1);
  }

  const match = line.match(/^([|\s]*)(?:\+\- |\\\- )(.+)$/);
  if (match) {
    const prefix = match[1];
    const depth = Math.floor(prefix.length / 3) + 1;
    return parseTreePayload(match[2], depth);
  }

  if (!line.startsWith('(') && line.includes(':')) {
    return parseTreePayload(line, 0);
  }

  return null;
}

function parseTreePayload(
  text: string,
  depth: number
): { depth: number; coord: string; managedFromVersion?: string; omittedReason?: string; conflictWithVersion?: string } | null {
  const managedMatch = text.match(/managed from ([^ );]+)/);
  const conflictMatch = text.match(/omitted for conflict with ([^ )]+)/);
  const omittedMatch = text.match(/omitted for ([^)]+)\)/);
  const coord = text.replace(/\s+\(.*\)$/, '').trim();
  return {
    depth,
    coord,
    managedFromVersion: managedMatch ? managedMatch[1] : undefined,
    omittedReason: omittedMatch ? omittedMatch[1] : undefined,
    conflictWithVersion: conflictMatch ? conflictMatch[1] : undefined
  };
}

function getCacheDir(pomPath: string): string {
  const moduleRoot = pomPath ? path.dirname(pomPath) : '';
  const relative = moduleRoot.replace(/^\/+/, '');
  return path.join(os.homedir(), '.mavenhelpervs', relative);
}

async function hashFile(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath);
  let hash = 0;
  for (const byte of data) {
    hash = (hash * 31 + byte) >>> 0;
  }
  return hash.toString(16);
}

function createNode(id: string): DepNode {
  const parsed = parseCoord(id);
  return {
    id,
    groupId: parsed.groupId,
    artifactId: parsed.artifactId,
    version: parsed.version,
    classifier: parsed.classifier,
    packaging: parsed.packaging,
    scope: parsed.scope,
    children: [],
    parents: []
  };
}

function cleanCoord(raw: string): string {
  const cleaned = raw
    .replace(/^\s*[|\\]+/g, '')
    .replace(/^\s*(\+\- |\\\- )/, '')
    .replace(/^\(/, '')
    .replace(/\)$/, '')
    .replace(/:(compile|provided|runtime|test|system|import)\s+-\s+.*$/i, ':$1')
    .replace(/\s+\(.*\)$/, '')
    .trim();
  return cleaned;
}

function parseCoord(coord: string): {
  groupId: string;
  artifactId: string;
  packaging?: string;
  classifier?: string;
  version: string;
  scope?: string;
} {
  const parts = coord.split(':');
  if (parts.length < 3) {
    return {
      groupId: coord,
      artifactId: coord,
      version: 'unknown'
    };
  }

  let scope: string | undefined;
  if (parts.length >= 5) {
    scope = parts.pop();
  }

  const version = parts.pop() || 'unknown';
  let packaging: string | undefined;
  if (parts.length >= 3) {
    packaging = parts.pop();
  }

  let classifier: string | undefined;
  if (parts.length > 2) {
    classifier = parts.pop();
  }

  const artifactId = parts.pop() || 'unknown';
  const groupId = parts.join(':') || 'unknown';

  return { groupId, artifactId, packaging, classifier, version, scope };
}

function extractManagedFromOmitted(reason?: string): string {
  if (!reason) {
    return '';
  }
  const match = reason.match(/managed from ([^;,\s)]+)/i);
  return match ? match[1] : '';
}

async function findWorkspacePomForId(id: string): Promise<string | null> {
  const parsed = parseCoord(id);
  const index = await ensureWorkspacePomIndex();
  const key = `${parsed.groupId}:${parsed.artifactId}`;
  const candidates = index.get(key) || [];
  if (candidates.length === 0) {
    return null;
  }
  if (parsed.version && parsed.version !== 'unknown') {
    const exact = candidates.find((c) => c.version && c.version === parsed.version);
    if (exact) {
      return exact.pomPath;
    }
  }
  return candidates[0].pomPath;
}

function collectAncestorIds(nodes: Record<string, DepNode>, id: string): string[] {
  const ordered: string[] = [];
  const visited = new Set<string>();
  const queue: string[] = [];
  const node = nodes[id];
  if (node) {
    queue.push(...node.parents);
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) {
      continue;
    }
    visited.add(current);
    ordered.push(current);
    const parentNode = nodes[current];
    if (parentNode) {
      queue.push(...parentNode.parents);
    }
  }
  return ordered;
}

async function downloadPomFromNexus(
  coord: { groupId: string; artifactId: string; version: string },
  currentPomPath?: string
): Promise<string | null> {
  if (!coord.groupId || !coord.artifactId || !coord.version || coord.version === 'unknown') {
    return null;
  }

  const urls = getNexusRepositoryUrls();
  if (urls.length === 0) {
    return null;
  }

  const groupPath = coord.groupId.replace(/\./g, '/');
  const relative = `${groupPath}/${coord.artifactId}/${coord.version}/${coord.artifactId}-${coord.version}.pom`;
  const cacheDir = path.join(getCacheDir(currentPomPath || ''), 'remote-poms');
  await fs.mkdir(cacheDir, { recursive: true });
  const target = path.join(cacheDir, `${coord.groupId}-${coord.artifactId}-${coord.version}.pom`.replace(/[^a-zA-Z0-9._-]/g, '_'));

  for (const baseUrl of urls) {
    const url = `${baseUrl.replace(/\/+$/, '')}/${relative}`;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        continue;
      }
      const text = await response.text();
      if (!text || !text.includes('<project')) {
        continue;
      }
      await fs.writeFile(target, text, 'utf8');
      await fs.chmod(target, 0o444);
      return target;
    } catch {
      // ignore and try next url
    }
  }

  return null;
}

function getNexusRepositoryUrls(): string[] {
  const configured = vscode.workspace.getConfiguration('mavenHelper').get<string[]>('nexusRepositoryUrls') || [];
  const defaults = [
    'https://maven.aliyun.com/nexus/content/groups/public'
  ];
  const combined = [...configured, ...defaults].filter((u) => typeof u === 'string' && u.trim().length > 0);
  return [...new Set(combined)];
}

async function findPomInLocalRepositories(coord: { groupId: string; artifactId: string; version: string }): Promise<string | null> {
  if (!coord.groupId || !coord.artifactId || !coord.version || coord.version === 'unknown') {
    return null;
  }

  const groupPath = coord.groupId.replace(/\./g, path.sep);
  const relative = path.join(groupPath, coord.artifactId, coord.version, `${coord.artifactId}-${coord.version}.pom`);
  const repos = await getLocalRepositoryPaths();

  for (const repo of repos) {
    const full = path.join(repo, relative);
    if (await exists(full)) {
      return full;
    }
  }
  return null;
}

async function resolvePomTargetById(
  id: string,
  currentPomPath: string | undefined,
  includeRemote: boolean
): Promise<{ file: string; readonly: boolean; sourceHint?: string } | null> {
  const workspacePom = await findWorkspacePomForId(id);
  if (workspacePom) {
    return { file: workspacePom, readonly: false };
  }

  const parsed = parseCoord(id);
  const localPom = await findPomInLocalRepositories(parsed);
  if (localPom) {
    return { file: localPom, readonly: true, sourceHint: 'Opened local Maven repository pom.xml (read-only).' };
  }

  if (includeRemote) {
    const remotePom = await downloadPomFromNexus(parsed, currentPomPath);
    if (remotePom) {
      return { file: remotePom, readonly: true, sourceHint: 'Opened Nexus pom.xml snapshot (read-only file).' };
    }
  }

  return null;
}

async function getLocalRepositoryPaths(): Promise<string[]> {
  const configRepos = vscode.workspace.getConfiguration('mavenHelper').get<string[]>('localRepositoryPaths') || [];
  const userM2 = path.join(os.homedir(), '.m2');
  const envRepo = process.env.MAVEN_USER_HOME ? path.join(process.env.MAVEN_USER_HOME, 'repository') : '';
  const common = [
    path.join(userM2, 'repository'),
    path.join(userM2, 'repositorykj'),
    envRepo
  ].filter((p) => p.length > 0);

  const parsedFromSettings: string[] = [];
  const settingCandidates = [path.join(userM2, 'settings.xml'), path.join(userM2, 'settings-kj.xml')];
  for (const settingsFile of settingCandidates) {
    if (!(await exists(settingsFile))) {
      continue;
    }
    try {
      const text = await fs.readFile(settingsFile, 'utf8');
      const match = text.match(/<localRepository>([^<]+)<\/localRepository>/);
      if (match && match[1]) {
        parsedFromSettings.push(match[1].trim());
      }
    } catch {
      // ignore malformed settings
    }
  }

  const all = [...configRepos, ...parsedFromSettings, ...common]
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return [...new Set(all)];
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function openLocationInEditor(location: PomLocation): Promise<void> {
  const uri = vscode.Uri.file(location.file);
  const editor = await showOrReuseEditor(uri);
  const line = Math.max(0, location.line - 1);
  const pos = new vscode.Position(line, Math.max(0, location.column - 1));
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

async function openPomFile(filePath: string, readonly: boolean): Promise<void> {
  const uri = vscode.Uri.file(filePath);
  await showOrReuseEditor(uri);
  if (readonly) {
    try {
      await vscode.commands.executeCommand('workbench.action.files.setActiveEditorReadonlyInSession');
    } catch {
      // command might be unavailable in older versions
    }
  }
}

async function showOrReuseEditor(uri: vscode.Uri): Promise<vscode.TextEditor> {
  const openEditor = vscode.window.visibleTextEditors.find(
    (e) => e.document.uri.toString() === uri.toString()
  );
  if (openEditor) {
    return vscode.window.showTextDocument(openEditor.document, {
      viewColumn: openEditor.viewColumn,
      preview: false,
      preserveFocus: false
    });
  }

  const doc = await vscode.workspace.openTextDocument(uri);
  return vscode.window.showTextDocument(doc, { preview: false });
}

function formatLocation(location: PomLocation): string {
  return `${path.basename(location.file)}:${location.line} (${location.kind})`;
}

function isUnderWorkspace(filePath: string): boolean {
  const folders = vscode.workspace.workspaceFolders || [];
  return folders.some((f) => {
    const root = path.resolve(f.uri.fsPath);
    const target = path.resolve(filePath);
    return target === root || target.startsWith(`${root}${path.sep}`);
  });
}

type WorkspacePomEntry = { pomPath: string; version?: string };
let workspacePomIndexCache: Map<string, WorkspacePomEntry[]> | null = null;
let workspacePomIndexKey = '';

function invalidateWorkspacePomIndexCache(): void {
  workspacePomIndexCache = null;
  workspacePomIndexKey = '';
}

async function ensureWorkspacePomIndex(): Promise<Map<string, WorkspacePomEntry[]>> {
  const folders = vscode.workspace.workspaceFolders || [];
  const key = folders.map((f) => f.uri.fsPath).sort().join('|');
  if (workspacePomIndexCache && workspacePomIndexKey === key) {
    return workspacePomIndexCache;
  }

  const next = new Map<string, WorkspacePomEntry[]>();
  const poms = await vscode.workspace.findFiles('**/pom.xml', '**/{target,node_modules,.git}/**');
  for (const pom of poms) {
    const coords = await getProjectCoordinates(pom.fsPath);
    if (!coords.groupId || !coords.artifactId) {
      continue;
    }
    const ga = `${coords.groupId}:${coords.artifactId}`;
    const list = next.get(ga) || [];
    list.push({ pomPath: pom.fsPath, version: coords.version });
    next.set(ga, list);
  }

  workspacePomIndexCache = next;
  workspacePomIndexKey = key;
  return next;
}
