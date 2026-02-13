import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { XMLParser } from 'fast-xml-parser';
import { DepNode } from './dependencyIndex';

export type PomLocation = {
  file: string;
  line: number;
  column: number;
  kind: 'dependencyManagement' | 'dependency' | 'property' | 'effectivePom' | 'bom' | 'bomImport';
};

type PomData = {
  file: string;
  xml: string;
  parentPath?: string;
  groupId?: string;
  artifactId?: string;
  version?: string;
  properties: Record<string, string>;
  dependencyManagement: Array<DepEntry>;
  dependencies: Array<DepEntry>;
  profiles: ProfileData[];
};

type DepEntry = {
  groupId: string;
  artifactId: string;
  version?: string;
  type?: string;
  scope?: string;
  classifier?: string;
};

type BomImportEntry = DepEntry & {
  sourcePom: PomData;
};

type ProfileData = {
  id?: string;
  properties: Record<string, string>;
  dependencyManagement: Array<DepEntry>;
  dependencies: Array<DepEntry>;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: true,
  trimValues: true
});

export async function resolveVersionOrigin(
  pomPath: string,
  dep: DepNode,
  options?: { effectivePomPath?: string; profiles?: string[] }
): Promise<PomLocation[]> {
  const chain = await buildPomChain(pomPath);
  const profiles = options?.profiles ?? [];
  const propertyResolver = buildPropertyResolver(chain, profiles);
  const locations: PomLocation[] = [];

  if (dep.managedFromVersion) {
    for (const pom of chain) {
      const match = findDepInPom(pom, dep, profiles, 'dependencyManagement');
      if (match && match.version) {
        const resolvedVersion = propertyResolver(pom, match.version);
        const versionLine = findVersionLine(pom.xml, match.groupId, match.artifactId, 'dependencyManagement');
        locations.push({
          file: pom.file,
          line: versionLine.line,
          column: versionLine.column,
          kind: 'dependencyManagement'
        });

        const propName = getPropertyRef(match.version);
        if (propName) {
          const propLocation = findPropertyLocation(chain, profiles, propName);
          if (propLocation) {
            locations.push(propLocation);
          }
        }
        if (resolvedVersion && resolvedVersion !== match.version) {
          const resolvedProp = getPropertyRef(match.version);
          if (resolvedProp) {
            const resolvedLocation = findPropertyLocation(chain, profiles, resolvedProp);
            if (resolvedLocation && !locations.includes(resolvedLocation)) {
              locations.push(resolvedLocation);
            }
          }
        }
        return locations;
      }

      const bomLocations = await resolveFromBoms([pom], dep, profiles, propertyResolver);
      if (bomLocations.length > 0) {
        return bomLocations;
      }
    }
  }

  for (const pom of chain) {
    const match = findDepInPom(pom, dep, profiles, 'dependency');
    if (match && match.version) {
      const resolvedVersion = propertyResolver(pom, match.version);
      const versionLine = findVersionLine(pom.xml, match.groupId, match.artifactId, 'dependency');
      locations.push({
        file: pom.file,
        line: versionLine.line,
        column: versionLine.column,
        kind: 'dependency'
      });

      const propName = getPropertyRef(match.version);
      if (propName) {
        const propLocation = findPropertyLocation(chain, profiles, propName);
        if (propLocation) {
          locations.push(propLocation);
        }
      }
      if (resolvedVersion && resolvedVersion !== match.version) {
        const resolvedProp = getPropertyRef(match.version);
        if (resolvedProp) {
          const resolvedLocation = findPropertyLocation(chain, profiles, resolvedProp);
          if (resolvedLocation && !locations.includes(resolvedLocation)) {
            locations.push(resolvedLocation);
          }
        }
      }
      return locations;
    }
  }

  for (const pom of chain) {
    const match = findDepInPom(pom, dep, profiles, 'dependencyManagement');
    if (match && match.version) {
      const resolvedVersion = propertyResolver(pom, match.version);
      const versionLine = findVersionLine(pom.xml, match.groupId, match.artifactId, 'dependencyManagement');
      locations.push({
        file: pom.file,
        line: versionLine.line,
        column: versionLine.column,
        kind: 'dependencyManagement'
      });

      const propName = getPropertyRef(match.version);
      if (propName) {
        const propLocation = findPropertyLocation(chain, profiles, propName);
        if (propLocation) {
          locations.push(propLocation);
        }
      }
      if (resolvedVersion && resolvedVersion !== match.version) {
        const resolvedProp = getPropertyRef(match.version);
        if (resolvedProp) {
          const resolvedLocation = findPropertyLocation(chain, profiles, resolvedProp);
          if (resolvedLocation && !locations.includes(resolvedLocation)) {
            locations.push(resolvedLocation);
          }
        }
      }
      return locations;
    }

    const bomLocations = await resolveFromBoms([pom], dep, profiles, propertyResolver);
    if (bomLocations.length > 0) {
      return bomLocations;
    }
  }

  if (options?.effectivePomPath) {
    const effectiveLocation = await resolveFromEffectivePom(options.effectivePomPath, dep);
    if (effectiveLocation) {
      locations.push(effectiveLocation);
    }
  }

  return locations;
}

export async function findDependencyDeclaration(
  pomPath: string,
  groupId: string,
  artifactId: string
): Promise<PomLocation | null> {
  try {
    const xml = await fs.readFile(pomPath, 'utf8');
    const depLine = findDependencyLine(xml, groupId, artifactId, 'dependency');
    if (depLine) {
      return { file: pomPath, line: depLine.line, column: depLine.column, kind: 'dependency' };
    }
    const dmLine = findDependencyLine(xml, groupId, artifactId, 'dependencyManagement');
    if (dmLine) {
      return { file: pomPath, line: dmLine.line, column: dmLine.column, kind: 'dependencyManagement' };
    }
    return null;
  } catch {
    return null;
  }
}

export async function getProjectCoordinates(pomPath: string): Promise<{ groupId?: string; artifactId?: string; version?: string }> {
  try {
    const xml = await fs.readFile(pomPath, 'utf8');
    const data = parser.parse(xml);
    const project = data.project || {};
    const groupId = resolveInlineProperty(project.groupId || project.parent?.groupId, project);
    const artifactId = resolveInlineProperty(project.artifactId, project);
    const version = resolveInlineProperty(project.version || project.parent?.version, project);
    return { groupId, artifactId, version };
  } catch {
    return {};
  }
}

function resolveInlineProperty(value: string | undefined, project: any): string | undefined {
  if (!value || typeof value !== 'string') return value;
  const props = project.properties || {};
  return value.replace(/\$\{([^}]+)\}/g, (match: string, propName: string) => {
    if (propName === 'project.version' || propName === 'pom.version') return project.version || project.parent?.version || match;
    if (propName === 'project.groupId' || propName === 'pom.groupId') return project.groupId || project.parent?.groupId || match;
    if (propName === 'project.artifactId' || propName === 'pom.artifactId') return project.artifactId || match;
    if (props[propName]) return props[propName];
    return match;
  });
}

async function buildPomChain(startPom: string): Promise<PomData[]> {
  const chain: PomData[] = [];
  let current = startPom;

  while (current) {
    const pom = await readPom(current);
    chain.push(pom);
    if (!pom.parentPath) {
      break;
    }
    if (!(await exists(pom.parentPath))) {
      break;
    }
    current = pom.parentPath;
  }

  return chain;
}

async function readPom(file: string): Promise<PomData> {
  const xml = await fs.readFile(file, 'utf8');
  const data = parser.parse(xml);
  const project = data.project || {};

  const groupId = project.groupId || project.parent?.groupId;
  const artifactId = project.artifactId;
  const version = project.version || project.parent?.version;

  const properties = normalizeProperties(project.properties || {});
  const dependencyManagement = normalizeDependencies(project.dependencyManagement?.dependencies?.dependency || []);
  const dependencies = normalizeDependencies(project.dependencies?.dependency || []);
  const profiles = normalizeProfiles(project.profiles?.profile || []);

  const parentPath = resolveParentPath(project.parent, file);

  return {
    file,
    xml,
    parentPath,
    groupId,
    artifactId,
    version,
    properties,
    dependencyManagement,
    dependencies,
    profiles
  };
}

function resolveParentPath(parent: any, currentFile: string): string | undefined {
  if (!parent) {
    return undefined;
  }
  const relativePath = parent.relativePath || '../pom.xml';
  const candidate = path.resolve(path.dirname(currentFile), relativePath);
  return candidate;
}

function normalizeProperties(props: Record<string, any>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === 'string' || typeof value === 'number') {
      result[key] = String(value);
    }
  }
  return result;
}

function normalizeDependencies(dep: any): Array<DepEntry> {
  const arr = Array.isArray(dep) ? dep : dep ? [dep] : [];
  return arr
    .map((d: any) => ({
      groupId: d.groupId || '',
      artifactId: d.artifactId || '',
      version: d.version !== undefined && d.version !== null ? String(d.version) : undefined,
      type: d.type !== undefined && d.type !== null ? String(d.type) : undefined,
      scope: d.scope !== undefined && d.scope !== null ? String(d.scope) : undefined,
      classifier: d.classifier !== undefined && d.classifier !== null ? String(d.classifier) : undefined
    }))
    .filter((d: any) => d.groupId && d.artifactId);
}

function normalizeProfiles(profile: any): ProfileData[] {
  const arr = Array.isArray(profile) ? profile : profile ? [profile] : [];
  return arr.map((p: any) => ({
    id: p.id,
    properties: normalizeProperties(p.properties || {}),
    dependencyManagement: normalizeDependencies(p.dependencyManagement?.dependencies?.dependency || []),
    dependencies: normalizeDependencies(p.dependencies?.dependency || [])
  }));
}

function getPropertyRef(version: unknown): string | null {
  if (version === undefined || version === null) {
    return null;
  }
  const text = String(version).trim();
  const match = text.match(/^\$\{(.+?)\}$/);
  return match ? match[1] : null;
}

function findPropertyLocation(chain: PomData[], profiles: string[], prop: string): PomLocation | null {
  for (const pom of chain) {
    if (prop in pom.properties) {
      const line = findPropertyLine(pom.xml, prop);
      return {
        file: pom.file,
        line: line.line,
        column: line.column,
        kind: 'property'
      };
    }
    for (const profile of filterProfiles(pom, profiles)) {
      if (prop in profile.properties) {
        const line = findPropertyLine(pom.xml, prop);
        return {
          file: pom.file,
          line: line.line,
          column: line.column,
          kind: 'property'
        };
      }
    }
  }
  return null;
}

function findPropertyLine(xml: string, prop: string): { line: number; column: number } {
  const regex = new RegExp(`<${escapeRegex(prop)}>([\\s\\S]*?)<\\/${escapeRegex(prop)}>`);
  const match = regex.exec(xml);
  if (!match || match.index === undefined) {
    return { line: 1, column: 1 };
  }
  return offsetToLineCol(xml, match.index + 1);
}

function findVersionLine(
  xml: string,
  groupId: string,
  artifactId: string,
  section: 'dependencyManagement' | 'dependency'
): { line: number; column: number } {
  const block = findDependencyBlock(xml, groupId, artifactId, section);
  if (block) {
    const versionIndex = block.text.indexOf('<version>');
    if (versionIndex >= 0) {
      return offsetToLineCol(xml, block.start + versionIndex + 1);
    }
    return offsetToLineCol(xml, block.start + 1);
  }
  return { line: 1, column: 1 };
}

function findDependencyLine(
  xml: string,
  groupId: string,
  artifactId: string,
  section: 'dependencyManagement' | 'dependency'
): { line: number; column: number } | null {
  const block = findDependencyBlock(xml, groupId, artifactId, section);
  if (block) {
    return offsetToLineCol(xml, block.start + 1);
  }
  return null;
}

function findDependencyBlock(
  xml: string,
  groupId: string,
  artifactId: string,
  section: 'dependencyManagement' | 'dependency'
): { start: number; text: string } | null {
  const dmRanges = findTagRanges(xml, 'dependencyManagement');
  const depRegex = /<dependency>([\s\S]*?)<\/dependency>/g;
  let depMatch: RegExpExecArray | null;
  while ((depMatch = depRegex.exec(xml)) !== null) {
    if (depMatch.index === undefined) {
      continue;
    }
    const blockStart = depMatch.index;
    const inDependencyManagement = isOffsetInRanges(blockStart, dmRanges);
    if (section === 'dependencyManagement' && !inDependencyManagement) {
      continue;
    }
    if (section === 'dependency' && inDependencyManagement) {
      continue;
    }
    const text = depMatch[0];
    if (!text.includes(`<groupId>${groupId}</groupId>`) || !text.includes(`<artifactId>${artifactId}</artifactId>`)) {
      continue;
    }
    return { start: blockStart, text };
  }
  return null;
}

function findTagRanges(xml: string, tagName: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const regex = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'g');
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml)) !== null) {
    if (match.index === undefined) {
      continue;
    }
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

function isOffsetInRanges(offset: number, ranges: Array<{ start: number; end: number }>): boolean {
  for (const range of ranges) {
    if (offset >= range.start && offset <= range.end) {
      return true;
    }
  }
  return false;
}

function filterProfiles(pom: PomData, profiles: string[]): ProfileData[] {
  if (profiles.length === 0) {
    return [];
  }
  return pom.profiles.filter((p) => p.id && profiles.includes(p.id));
}

function findDepInPom(pom: PomData, dep: DepNode, profiles: string[], section: 'dependencyManagement' | 'dependency'): DepEntry | undefined {
  const list = section === 'dependencyManagement' ? pom.dependencyManagement : pom.dependencies;
  const match = list.find((d) => d.groupId === dep.groupId && d.artifactId === dep.artifactId);
  if (match) {
    return match;
  }
  for (const profile of filterProfiles(pom, profiles)) {
    const pList = section === 'dependencyManagement' ? profile.dependencyManagement : profile.dependencies;
    const pMatch = pList.find((d) => d.groupId === dep.groupId && d.artifactId === dep.artifactId);
    if (pMatch) {
      return pMatch;
    }
  }
  return undefined;
}

async function resolveFromBoms(
  chain: PomData[],
  dep: DepNode,
  profiles: string[],
  propertyResolver: (pom: PomData, value: string) => string
): Promise<PomLocation[]> {
  const bomDeps = collectBomImports(chain, profiles);
  return resolveFromBomImportsRecursive(chain, dep, profiles, propertyResolver, bomDeps, new Set<string>());
}

async function resolveFromBomImportsRecursive(
  chain: PomData[],
  dep: DepNode,
  profiles: string[],
  propertyResolver: (pom: PomData, value: string) => string,
  bomDeps: BomImportEntry[],
  visitedBomPaths: Set<string>
): Promise<PomLocation[]> {
  for (const bom of bomDeps) {
    const bomPath = await resolveBomPath(chain, profiles, bom, propertyResolver);
    if (!bomPath || visitedBomPaths.has(bomPath)) {
      continue;
    }
    visitedBomPaths.add(bomPath);

    const bomPom = await readPom(bomPath);
    const nestedChain = [bomPom, ...chain];
    const nestedResolver = buildPropertyResolver(nestedChain, profiles);

    const match = findDepInPom(bomPom, dep, profiles, 'dependencyManagement');
    if (match && match.version) {
      const resolvedVersion = nestedResolver(bomPom, match.version);
      const versionLine = findVersionLine(bomPom.xml, match.groupId, match.artifactId, 'dependencyManagement');
      const locations: PomLocation[] = [];
      const bomImportLocation = findBomImportLocation(bom.sourcePom, bom);
      if (bomImportLocation) {
        locations.push(bomImportLocation);
      }
      locations.push({
        file: bomPom.file,
        line: versionLine.line,
        column: versionLine.column,
        kind: 'bom'
      });
      const propName = getPropertyRef(match.version);
      if (propName) {
        const propLocation = findPropertyLocation(nestedChain, profiles, propName);
        if (propLocation) {
          locations.push(propLocation);
        }
      }
      if (resolvedVersion && resolvedVersion !== match.version) {
        const resolvedProp = getPropertyRef(match.version);
        if (resolvedProp) {
          const resolvedLocation = findPropertyLocation(nestedChain, profiles, resolvedProp);
          if (resolvedLocation) {
            locations.push(resolvedLocation);
          }
        }
      }
      return dedupeLocations(locations);
    }

    const nestedImports = collectBomImports([bomPom], profiles);
    if (nestedImports.length > 0) {
      const nestedLocations = await resolveFromBomImportsRecursive(
        nestedChain,
        dep,
        profiles,
        nestedResolver,
        nestedImports,
        visitedBomPaths
      );
      if (nestedLocations.length > 0) {
        const bomImportLocation = findBomImportLocation(bom.sourcePom, bom);
        if (!bomImportLocation) {
          return nestedLocations;
        }
        return dedupeLocations([bomImportLocation, ...nestedLocations]);
      }
    }
  }
  return [];
}

function collectBomImports(chain: PomData[], profiles: string[]): BomImportEntry[] {
  const boms: BomImportEntry[] = [];
  for (const pom of chain) {
    for (const dep of pom.dependencyManagement) {
      if (dep.type === 'pom' && dep.scope === 'import') {
        boms.push({ ...dep, sourcePom: pom });
      }
    }
    for (const profile of filterProfiles(pom, profiles)) {
      for (const dep of profile.dependencyManagement) {
        if (dep.type === 'pom' && dep.scope === 'import') {
          boms.push({ ...dep, sourcePom: pom });
        }
      }
    }
  }
  return boms;
}

function findBomImportLocation(sourcePom: PomData, bom: DepEntry): PomLocation | null {
  const line = findDependencyLine(sourcePom.xml, bom.groupId, bom.artifactId, 'dependencyManagement');
  if (!line) {
    return null;
  }
  return {
    file: sourcePom.file,
    line: line.line,
    column: line.column,
    kind: 'bomImport'
  };
}

function dedupeLocations(locations: PomLocation[]): PomLocation[] {
  const seen = new Set<string>();
  const out: PomLocation[] = [];
  for (const location of locations) {
    const key = `${location.kind}|${location.file}|${location.line}|${location.column}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(location);
  }
  return out;
}

async function resolveBomPath(
  chain: PomData[],
  profiles: string[],
  dep: DepEntry,
  propertyResolver: (pom: PomData, value: string) => string
): Promise<string | null> {
  if (!dep.version) return null;
  const version = resolvePropertyValue(chain, profiles, dep.version) || dep.version;
  const groupPath = dep.groupId.replace(/\./g, path.sep);
  const repos = await getLocalRepoPaths();
  for (const repo of repos) {
    const baseDir = path.join(repo, groupPath, dep.artifactId, version);
    const bomPath = path.join(baseDir, `${dep.artifactId}-${version}.pom`);
    if (await exists(bomPath)) {
      return bomPath;
    }
  }
  return null;
}

async function resolveFromEffectivePom(effectivePomPath: string, dep: DepNode): Promise<PomLocation | null> {
  try {
    const xml = await fs.readFile(effectivePomPath, 'utf8');
    const data = parser.parse(xml);
    const project = data.project || {};
    const dependencyManagement = normalizeDependencies(project.dependencyManagement?.dependencies?.dependency || []);
    const dependencies = normalizeDependencies(project.dependencies?.dependency || []);

    const dmMatch = dependencyManagement.find((d) => d.groupId === dep.groupId && d.artifactId === dep.artifactId);
    const depMatch = dependencies.find((d) => d.groupId === dep.groupId && d.artifactId === dep.artifactId);
    const match = dmMatch || depMatch;
    if (!match) {
      return null;
    }
    const section = dmMatch ? 'dependencyManagement' : 'dependency';
    const line = findVersionLine(xml, match.groupId, match.artifactId, section);
    return { file: effectivePomPath, line: line.line, column: line.column, kind: 'effectivePom' };
  } catch {
    return null;
  }
}

function offsetToLineCol(text: string, offset: number): { line: number; column: number } {
  const pre = text.slice(0, offset);
  const lines = pre.split(/\r?\n/);
  const line = lines.length;
  const column = lines[lines.length - 1].length + 1;
  return { line, column };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function getLocalRepoPaths(): Promise<string[]> {
  const userM2 = path.join(os.homedir(), '.m2');
  const envRepo = process.env.MAVEN_USER_HOME ? path.join(process.env.MAVEN_USER_HOME, 'repository') : '';
  const defaults = [
    path.join(userM2, 'repository'),
    path.join(userM2, 'repositorykj'),
    envRepo
  ].filter((p) => p.length > 0);

  const fromSettings: string[] = [];
  const settingsCandidates = [path.join(userM2, 'settings.xml'), path.join(userM2, 'settings-kj.xml')];
  for (const settingsFile of settingsCandidates) {
    if (!(await exists(settingsFile))) {
      continue;
    }
    try {
      const text = await fs.readFile(settingsFile, 'utf8');
      const match = text.match(/<localRepository>([^<]+)<\/localRepository>/);
      if (match && match[1]) {
        fromSettings.push(match[1].trim());
      }
    } catch {
      // ignore malformed settings
    }
  }

  return [...new Set([...fromSettings, ...defaults].map((p) => p.trim()).filter((p) => p.length > 0))];
}

function resolvePropertyValue(chain: PomData[], profiles: string[], value: string): string | null {
  const propName = getPropertyRef(value);
  if (!propName) {
    return null;
  }
  for (const pom of chain) {
    if (propName in pom.properties) {
      return pom.properties[propName];
    }
    for (const profile of filterProfiles(pom, profiles)) {
      if (propName in profile.properties) {
        return profile.properties[propName];
      }
    }
  }
  return null;
}

function buildPropertyResolver(
  chain: PomData[],
  profiles: string[]
): (pom: PomData, value: string) => string {
  return (pom, value) => {
    if (!value || typeof value !== 'string') {
      return value;
    }
    return value.replace(/\$\{([^}]+)\}/g, (match, propName) => {
      if (propName === 'project.version' || propName === 'pom.version') {
        return pom.version || match;
      }
      if (propName === 'project.groupId' || propName === 'pom.groupId') {
        return pom.groupId || match;
      }
      if (propName === 'project.artifactId' || propName === 'pom.artifactId') {
        return pom.artifactId || match;
      }
      for (const p of chain) {
        if (propName in p.properties) {
          return p.properties[propName];
        }
        for (const profile of filterProfiles(p, profiles)) {
          if (propName in profile.properties) {
            return profile.properties[propName];
          }
        }
      }
      return match;
    });
  };
}
