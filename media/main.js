(function () {
  const vscode = acquireVsCodeApi();

  const state = {
    index: null,
    selectedId: null,
    pathsExpanded: true,
    collapsedPathKeys: new Set(),
    leftPaneWidth: 38,
    draggingSplitter: false,
    showRelatedConflictsOnly: true,
    showGroupId: true,
    showClassifier: true,
    conflictsExpanded: true,
    managedInfoById: {},
    managedPending: new Set()
  };

  const content = document.getElementById('content');
  const meta = document.getElementById('meta');
  const reimportBtn = document.getElementById('reimport');
  const filterGroup = document.getElementById('filter-group');
  const filterArtifact = document.getElementById('filter-artifact');
  const filterVersion = document.getElementById('filter-version');
  const filterClassifier = document.getElementById('filter-classifier');

  reimportBtn.addEventListener('click', () => reimport());

  [filterGroup, filterArtifact, filterVersion, filterClassifier].forEach((input) => {
    input.addEventListener('input', render);
  });

  content.addEventListener('click', (event) => {
    const target = event.target;
    if (!target) return;

    const selectDep = target.closest('[data-action="select-dep"]');
    if (selectDep) {
      const id = selectDep.getAttribute('data-id');
      if (id) {
        selectDependency(id);
      }
      return;
    }

    const openNode = target.closest('[data-action="open-path-node"]');
    if (openNode) {
      const id = openNode.getAttribute('data-id');
      const prevId = openNode.getAttribute('data-prev-id');
      if (id) {
        vscode.postMessage({ type: 'openPathNode', id, prevId: prevId || null });
      }
      return;
    }

    const togglePaths = target.closest('[data-action="toggle-paths"]');
    if (togglePaths) {
      state.pathsExpanded = !state.pathsExpanded;
      render();
      return;
    }

    const togglePathTree = target.closest('[data-action="toggle-path-tree"]');
    if (togglePathTree) {
      const key = togglePathTree.getAttribute('data-key');
      if (!key) return;
      if (state.collapsedPathKeys.has(key)) {
        state.collapsedPathKeys.delete(key);
      } else {
        state.collapsedPathKeys.add(key);
      }
      render();
    }

    const toggleConflictFilter = target.closest('[data-action="toggle-conflict-filter"]');
    if (toggleConflictFilter) {
      state.showRelatedConflictsOnly = !state.showRelatedConflictsOnly;
      render();
      return;
    }

    const toggleConflicts = target.closest('[data-action="toggle-conflicts"]');
    if (toggleConflicts) {
      state.conflictsExpanded = !state.conflictsExpanded;
      render();
      return;
    }

    const toggleGroupId = target.closest('[data-action="toggle-show-groupid"]');
    if (toggleGroupId) {
      state.showGroupId = !state.showGroupId;
      render();
      return;
    }

    const toggleClassifier = target.closest('[data-action="toggle-show-classifier"]');
    if (toggleClassifier) {
      state.showClassifier = !state.showClassifier;
      render();
      return;
    }

    const openManagedLocation = target.closest('[data-action="open-managed-location"]');
    if (openManagedLocation) {
      const depId = openManagedLocation.getAttribute('data-dep-id');
      if (!depId) {
        return;
      }
      const managedInfo = state.managedInfoById[depId];
      if (managedInfo && managedInfo.location) {
        vscode.postMessage({ type: 'openManagedLocation', location: managedInfo.location });
      }
      return;
    }

    const openBomImportLocation = target.closest('[data-action="open-bom-import-location"]');
    if (openBomImportLocation) {
      const depId = openBomImportLocation.getAttribute('data-dep-id');
      if (!depId) {
        return;
      }
      const managedInfo = state.managedInfoById[depId];
      if (managedInfo && managedInfo.bomImportLocation) {
        vscode.postMessage({ type: 'openManagedLocation', location: managedInfo.bomImportLocation });
      }
      return;
    }

    const openDependencyLocate = target.closest('[data-action="open-dependency-locate"]');
    if (openDependencyLocate) {
      const depId = openDependencyLocate.getAttribute('data-dep-id');
      if (depId) {
        vscode.postMessage({ type: 'openDependencyLocate', id: depId });
      }
      return;
    }

    const openManagementChainLocation = target.closest('[data-action="open-management-chain-location"]');
    if (openManagementChainLocation) {
      const depId = openManagementChainLocation.getAttribute('data-dep-id');
      const indexStr = openManagementChainLocation.getAttribute('data-chain-index');
      if (!depId || indexStr == null) {
        return;
      }
      const managedInfo = state.managedInfoById[depId];
      const chain = managedInfo && Array.isArray(managedInfo.managementChain) ? managedInfo.managementChain : [];
      const idx = Number(indexStr);
      if (Number.isFinite(idx) && idx >= 0 && idx < chain.length) {
        vscode.postMessage({ type: 'openManagedLocation', location: chain[idx] });
      }
      return;
    }
  });

  window.addEventListener('mousemove', (event) => {
    if (!state.draggingSplitter) return;
    const shell = content.querySelector('.split-shell');
    if (!shell) return;
    const rect = shell.getBoundingClientRect();
    const percentage = ((event.clientX - rect.left) / rect.width) * 100;
    state.leftPaneWidth = Math.min(65, Math.max(22, percentage));
    shell.style.setProperty('--left-pane-width', `${state.leftPaneWidth}%`);
  });

  window.addEventListener('mouseup', () => {
    state.draggingSplitter = false;
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'index') {
      state.index = message.data;
      render();
      return;
    }
    if (message.type === 'managedInfo') {
      state.managedInfoById[message.id] = message.managedInfo || null;
      state.managedPending.delete(message.id);
      render();
    }
  });

  vscode.postMessage({ type: 'requestData' });

  function render() {
    content.innerHTML = '';
    if (!state.index) {
      content.innerHTML = '<div class="empty">No dependency index yet. Click Reimport to build one.</div>';
      meta.textContent = '';
      return;
    }

    const filters = {
      groupId: filterGroup.value.trim().toLowerCase(),
      artifactId: filterArtifact.value.trim().toLowerCase(),
      version: filterVersion.value.trim().toLowerCase(),
      classifier: filterClassifier.value.trim().toLowerCase()
    };

    const effective = buildEffectiveDependencies(state.index);
    const filtered = effective
      .filter((n) => matchesFilters(n, filters))
      .sort((a, b) => (a.groupId + a.artifactId).localeCompare(b.groupId + b.artifactId));

    if (!state.selectedId || !getDepById(state.selectedId)) {
      state.selectedId = filtered.length > 0 ? filtered[0].id : null;
    }

    const selected = state.selectedId ? filtered.find((d) => d.id === state.selectedId) || null : null;

    meta.textContent = `Project: ${state.index.projectRoot} | Module: ${state.index.moduleRoot} | Active Profiles: ${state.index.profiles.join(', ') || '-'} | Dependencies: ${filtered.length} | Updated: ${new Date(state.index.generatedAt).toLocaleString()}`;

    if (filtered.length === 0) {
      content.innerHTML = '<div class="empty">No dependencies match the filters.</div>';
      return;
    }

    const shell = document.createElement('div');
    shell.className = 'split-shell';
    shell.style.setProperty('--left-pane-width', `${state.leftPaneWidth}%`);

    shell.appendChild(renderLeftPane(filtered));
    shell.appendChild(renderSplitter());
    shell.appendChild(renderRightPane(selected));

    content.appendChild(shell);
  }

  function renderLeftPane(list) {
    const pane = document.createElement('div');
    pane.className = 'pane pane-left';

    const title = document.createElement('div');
    title.className = 'pane-title';
    title.textContent = 'Dependencies';
    pane.appendChild(title);

    const options = document.createElement('div');
    options.className = 'dep-options';
    options.innerHTML = [
      `<label class="dep-option"><input type="checkbox" data-action="toggle-show-groupid" ${state.showGroupId ? 'checked' : ''}>Show groupId</label>`,
      `<label class="dep-option"><input type="checkbox" data-action="toggle-show-classifier" ${state.showClassifier ? 'checked' : ''}>Show classifier</label>`
    ].join('');
    pane.appendChild(options);

    const items = document.createElement('div');
    items.className = 'dep-list';

    list.forEach((dep) => {
      const button = document.createElement('button');
      button.className = 'dep-item';
      if (dep.id === state.selectedId) {
        button.classList.add('active');
      }
      button.setAttribute('data-action', 'select-dep');
      button.setAttribute('data-id', dep.id);
      const text = formatDependencyLabel(dep, state.showGroupId, state.showClassifier);
      button.title = text;

      const label = document.createElement('span');
      label.className = 'dep-item-label';
      label.textContent = text;
      button.appendChild(label);

      if (dep.conflictCount && dep.conflictCount > 0) {
        const badge = document.createElement('span');
        badge.className = 'dep-conflict-badge';
        badge.textContent = `+${dep.conflictCount} conflict`;
        button.appendChild(badge);
      }
      items.appendChild(button);
    });

    pane.appendChild(items);
    return pane;
  }

  function renderSplitter() {
    const splitter = document.createElement('div');
    splitter.className = 'splitter';
    splitter.title = 'Drag to resize';
    splitter.addEventListener('mousedown', () => {
      state.draggingSplitter = true;
    });
    return splitter;
  }

  function renderRightPane(dep) {
    const pane = document.createElement('div');
    pane.className = 'pane pane-right';

    if (!dep) {
      pane.innerHTML = '<div class="empty">Select a dependency to see details.</div>';
      return pane;
    }

    const detailsCard = document.createElement('div');
    const paths = buildPaths(dep.id, 20);
    const shortestHops = paths.length > 0 ? Math.max(0, paths[0].length - 1) : 0;
    const hasManagedInfo = Object.prototype.hasOwnProperty.call(state.managedInfoById, dep.id);
    const managedInfo = hasManagedInfo ? state.managedInfoById[dep.id] : null;
    if (!hasManagedInfo && !state.managedPending.has(dep.id)) {
      state.managedPending.add(dep.id);
      vscode.postMessage({ type: 'resolveManagedInfo', id: dep.id });
    }
    detailsCard.className = 'details-card';
    const detailsRows = [
      `<div class="details-title">${escapeHtml(formatDependencyLabel(dep, true, true))}</div>`
    ];
    detailsRows.push(`<div>Version origin: <button class="managed-link" data-action="open-dependency-locate" data-dep-id="${escapeHtml(dep.id)}">locate</button></div>`);
    const fallbackManagedFrom = dep.displayManagedFrom && dep.displayManagedFrom !== '-' ? dep.displayManagedFrom : '';
    const effectiveManagedFrom = managedInfo && managedInfo.managedFrom ? managedInfo.managedFrom : fallbackManagedFrom;
    if (effectiveManagedFrom) {
      const managedTo = managedInfo && managedInfo.managedTo ? managedInfo.managedTo : dep.version;
      const managedLabel = managedTo && managedTo !== effectiveManagedFrom
        ? `${escapeHtml(effectiveManagedFrom)} -> ${escapeHtml(managedTo)}`
        : escapeHtml(effectiveManagedFrom);
      const locate = managedInfo && managedInfo.location
        ? ` <button class="managed-link" data-action="open-managed-location" data-dep-id="${escapeHtml(dep.id)}">locate</button>`
        : '';
      const importLocate = managedInfo && managedInfo.bomImportLocation
        ? ` <button class="managed-link" data-action="open-bom-import-location" data-dep-id="${escapeHtml(dep.id)}">import locate</button>`
        : '';
      detailsRows.push(`<div>Managed from: ${managedLabel}${locate}${importLocate}</div>`);
    }
    if (managedInfo && Array.isArray(managedInfo.managementChain) && managedInfo.managementChain.length > 0) {
      detailsRows.push(renderManagementChain(dep.id, managedInfo.managementChain));
    }
    detailsRows.push(
      `<div>Scope: ${escapeHtml(dep.scope || '-')} | Classifier: ${escapeHtml(dep.classifier || '-')}</div>`,
      `<div>Omitted: ${escapeHtml(dep.displayOmitted || '-')} | Conflict with: ${escapeHtml(dep.displayConflictWith || '-')}</div>`,
      `<div>Parents: ${dep.parents ? dep.parents.length : 0} | Children: ${dep.children ? dep.children.length : 0} | Shortest path hops: ${shortestHops}</div>`
    );
    detailsCard.innerHTML = detailsRows.join('');
    pane.appendChild(detailsCard);

    const chainCard = document.createElement('div');
    chainCard.className = 'chain-card';

    const header = document.createElement('button');
    header.className = 'btn tiny ghost details-toggle';
    header.setAttribute('data-action', 'toggle-paths');
    header.textContent = `Origin paths (root -> selected) ${state.pathsExpanded ? '▾' : '▸'}`;
    chainCard.appendChild(header);

    if (state.pathsExpanded) {
      const trees = document.createElement('div');
      trees.className = 'path-trees';
      if (paths.length === 0) {
        trees.innerHTML = '<div class="details-path">-</div>';
      } else {
        paths.forEach((pathIds, idx) => trees.appendChild(renderPathTree(pathIds, idx, `origin-${dep.id}`)));
      }
      chainCard.appendChild(trees);
    }

    pane.appendChild(chainCard);
    const conflictCard = renderConflictPathsCard(dep);
    if (conflictCard) {
      pane.appendChild(conflictCard);
    }
    return pane;
  }

  function renderConflictPathsCard(dep) {
    const variants = (dep.groupNodes || []).filter((n) => n.id !== dep.id);
    if (variants.length === 0) {
      return null;
    }

    const card = document.createElement('div');
    card.className = 'chain-card';
    const title = document.createElement('div');
    title.className = 'pane-title';
    title.textContent = 'Conflict Paths';
    card.appendChild(title);

    const collapseToggle = document.createElement('button');
    collapseToggle.className = 'btn tiny ghost details-toggle';
    collapseToggle.setAttribute('data-action', 'toggle-conflicts');
    collapseToggle.textContent = `Conflict paths ${state.conflictsExpanded ? '▾' : '▸'}`;
    card.appendChild(collapseToggle);

    if (!state.conflictsExpanded) {
      return card;
    }

    const filterToggle = document.createElement('button');
    filterToggle.className = 'btn tiny ghost details-toggle';
    filterToggle.setAttribute('data-action', 'toggle-conflict-filter');
    filterToggle.textContent = state.showRelatedConflictsOnly
      ? 'Showing related conflicts only'
      : 'Showing all conflict paths';
    card.appendChild(filterToggle);

    const baseShortestPaths = buildPaths(dep.id, 1);
    const shortestBasePath = baseShortestPaths.length > 0 ? baseShortestPaths[0] : [];

    variants.forEach((variant, idx) => {
      const subtitle = document.createElement('div');
      subtitle.className = 'conflict-variant-title';
      subtitle.textContent = `${variant.groupId}:${variant.artifactId}:${variant.version}${variant.omittedReason ? ` (${variant.omittedReason})` : ''}`;
      card.appendChild(subtitle);

      let paths = buildPaths(variant.id, 10);
      if (state.showRelatedConflictsOnly) {
        paths = paths.filter((p) => isRelatedToShortestPath(p, shortestBasePath));
      }
      if (paths.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'details-path';
        empty.textContent = state.showRelatedConflictsOnly ? 'No related conflict paths.' : '-';
        card.appendChild(empty);
        return;
      }
      paths.forEach((pathIds, pathIdx) => {
        card.appendChild(renderPathTree(pathIds, pathIdx, `conflict-${dep.id}-${idx}`));
      });
    });

    return card;
  }

  function renderPathTree(pathIds, idx, keyPrefix) {
    const key = `${keyPrefix}-path-${idx}-${pathIds.length}`;
    const collapsed = state.collapsedPathKeys.has(key);

    const wrap = document.createElement('div');
    wrap.className = 'path-tree';

    const header = document.createElement('button');
    header.className = 'path-tree-header';
    header.setAttribute('data-action', 'toggle-path-tree');
    header.setAttribute('data-key', key);
    header.textContent = `Path ${idx + 1} (${pathIds.length - 1} hops) ${collapsed ? '▸' : '▾'}`;
    wrap.appendChild(header);

    if (!collapsed) {
      const body = document.createElement('div');
      body.className = 'path-tree-body';
      pathIds.forEach((id, i) => {
        const row = document.createElement('div');
        row.className = 'path-tree-row';
        row.style.paddingLeft = `${i * 18}px`;

        const prevId = i > 0 ? pathIds[i - 1] : '';
        const nodeBtn = document.createElement('button');
        nodeBtn.className = 'path-node';
        nodeBtn.setAttribute('data-action', 'open-path-node');
        nodeBtn.setAttribute('data-id', id);
        nodeBtn.setAttribute('data-prev-id', prevId);
        nodeBtn.textContent = shortLabel(id);
        row.appendChild(nodeBtn);
        body.appendChild(row);
      });
      wrap.appendChild(body);
    }

    return wrap;
  }

  function reimport() {
    vscode.postMessage({ type: 'reimport' });
  }

  function selectDependency(id) {
    state.selectedId = id;
    const hasManagedInfo = Object.prototype.hasOwnProperty.call(state.managedInfoById, id);
    if (!hasManagedInfo && !state.managedPending.has(id)) {
      state.managedPending.add(id);
      vscode.postMessage({ type: 'resolveManagedInfo', id });
    }
    render();
  }

  function buildPaths(id, maxPaths) {
    if (!state.index) return [];

    const paths = [];
    const queue = [[id, [id]]];

    while (queue.length > 0 && paths.length < maxPaths) {
      const [current, path] = queue.shift();
      const node = state.index.nodes[current];
      if (!node || !node.parents || node.parents.length === 0) {
        paths.push(path.slice().reverse());
        continue;
      }
      node.parents.forEach((p) => {
        if (!path.includes(p)) {
          queue.push([p, [...path, p]]);
        }
      });
    }

    paths.sort((a, b) => a.length - b.length);
    return paths;
  }

  function buildEffectiveDependencies(index) {
    const depths = computeShortestDepth(index);
    const nodes = Object.values(index.nodes || {});
    const grouped = {};
    const versionsByKey = {};

    nodes.forEach((node) => {
      const key = `${node.groupId}:${node.artifactId}:${node.classifier || ''}`;
      if (!versionsByKey[key]) {
        versionsByKey[key] = new Set();
      }
      if (node.version) {
        versionsByKey[key].add(node.version);
      }
      const currentDepth = depths[node.id] ?? Number.MAX_SAFE_INTEGER;
      const existing = grouped[key];
      if (!existing) {
        grouped[key] = node;
        return;
      }

      const existingDepth = depths[existing.id] ?? Number.MAX_SAFE_INTEGER;
      if (currentDepth < existingDepth) {
        grouped[key] = node;
        return;
      }
      if (currentDepth > existingDepth) {
        return;
      }

      // Same shortest depth: prefer non-omitted/effective node.
      const existingOmitted = isOmittedNode(existing);
      const currentOmitted = isOmittedNode(node);
      if (existingOmitted && !currentOmitted) {
        grouped[key] = node;
      }
    });

    return Object.entries(grouped).map(([key, node]) => {
      const versions = versionsByKey[key] || new Set();
      const conflictCount = Math.max(0, versions.size - 1);
      const groupNodes = nodes.filter((n) => `${n.groupId}:${n.artifactId}:${n.classifier || ''}` === key);
      const selectedNode = node;
      const managed = firstNonEmpty([
        selectedNode.managedFromVersion,
        extractManagedFromOmitted(selectedNode.omittedReason),
        ...groupNodes.map((n) => n.managedFromVersion),
        ...groupNodes.map((n) => extractManagedFromOmitted(n.omittedReason))
      ]);
      const omitted = firstNonEmpty([selectedNode.omittedReason, ...groupNodes.map((n) => n.omittedReason)]);
      const conflictValues = [
        selectedNode.conflictWithVersion,
        extractConflictFromOmitted(selectedNode.omittedReason),
        ...groupNodes.map((n) => n.conflictWithVersion),
        ...groupNodes.map((n) => extractConflictFromOmitted(n.omittedReason))
      ];
      const conflictWith = joinUnique(conflictValues, [selectedNode.version]);
      return {
        ...node,
        conflictCount,
        groupNodes,
        displayManagedFrom: managed || '',
        displayOmitted: omitted || '-',
        displayConflictWith: conflictWith || '-'
      };
    });
  }

  function computeShortestDepth(index) {
    const depths = {};
    const roots = index.roots || [];
    const queue = [];

    roots.forEach((rootId) => {
      depths[rootId] = 0;
      queue.push(rootId);
    });

    while (queue.length > 0) {
      const current = queue.shift();
      const node = index.nodes[current];
      if (!node || !node.children) continue;
      const base = depths[current] || 0;
      node.children.forEach((child) => {
        const nextDepth = base + 1;
        if (depths[child] === undefined || nextDepth < depths[child]) {
          depths[child] = nextDepth;
          queue.push(child);
        }
      });
    }

    return depths;
  }

  function isOmittedNode(node) {
    return !!(node.omittedReason && node.omittedReason.trim().length > 0);
  }

  function firstNonEmpty(values) {
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      if (value && String(value).trim().length > 0) {
        return String(value).trim();
      }
    }
    return '';
  }

  function joinUnique(values, excludeValues) {
    const set = new Set();
    const exclude = new Set((excludeValues || []).filter((v) => !!v).map((v) => String(v).trim()));
    values.forEach((value) => {
      if (value && String(value).trim().length > 0) {
        const normalized = String(value).trim();
        if (!exclude.has(normalized)) {
          set.add(normalized);
        }
      }
    });
    return Array.from(set).join(', ');
  }

  function extractManagedFromOmitted(omittedReason) {
    if (!omittedReason) return '';
    const match = String(omittedReason).match(/managed from ([^;,\s)]+)/i);
    return match ? match[1] : '';
  }

  function extractConflictFromOmitted(omittedReason) {
    if (!omittedReason) return '';
    const match = String(omittedReason).match(/conflict with ([^;,\s)]+)/i);
    return match ? match[1] : '';
  }

  function formatDependencyLabel(dep, showGroupId, showClassifier) {
    const ga = showGroupId ? `${dep.groupId}:${dep.artifactId}` : dep.artifactId;
    const classifier = showClassifier && dep.classifier ? `:${dep.classifier}` : '';
    return `${ga}:${dep.version}${classifier}`;
  }

  function isRelatedToShortestPath(pathIds, shortestPath) {
    if (!shortestPath || shortestPath.length === 0) {
      return true;
    }
    const shortestAncestors = new Set(shortestPath.slice(0, Math.max(0, shortestPath.length - 1)));
    for (let i = 0; i < pathIds.length - 1; i++) {
      if (shortestAncestors.has(pathIds[i])) {
        return true;
      }
    }
    return false;
  }

  function shortLabel(id) {
    const dep = getDepById(id);
    if (dep) {
      return `${dep.groupId}:${dep.artifactId}:${dep.version}${dep.classifier ? ':' + dep.classifier : ''}`;
    }
    return id;
  }

  function renderManagementChain(depId, chain) {
    const items = chain.map((location, index) => {
      const kind = formatLocationKind(location.kind);
      const file = shortFileName(location.file || '-');
      const line = location.line ? `:${location.line}` : '';
      return `<button class="managed-chain-link" data-action="open-management-chain-location" data-dep-id="${escapeHtml(depId)}" data-chain-index="${index}">${escapeHtml(`${index + 1}. ${kind} -> ${file}${line}`)}</button>`;
    }).join('');
    return `<div class="managed-chain"><div class="managed-chain-title">Management chain:</div><div class="managed-chain-list">${items}</div></div>`;
  }

  function formatLocationKind(kind) {
    if (kind === 'bomImport') return 'bom import';
    if (kind === 'bom') return 'bom define';
    if (kind === 'dependencyManagement') return 'dependencyManagement';
    if (kind === 'property') return 'property';
    if (kind === 'dependency') return 'dependency';
    return kind || 'location';
  }

  function shortFileName(filePath) {
    if (!filePath) return '-';
    const normalized = String(filePath).replace(/\\/g, '/');
    const parts = normalized.split('/');
    if (parts.length >= 2) {
      return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
    }
    return normalized;
  }

  function matchesFilters(dep, filters) {
    if (filters.groupId && !dep.groupId.toLowerCase().includes(filters.groupId)) return false;
    if (filters.artifactId && !dep.artifactId.toLowerCase().includes(filters.artifactId)) return false;
    if (filters.version && !dep.version.toLowerCase().includes(filters.version)) return false;
    if (filters.classifier && !(dep.classifier || '').toLowerCase().includes(filters.classifier)) return false;
    return true;
  }

  function getDepById(id) {
    return state.index && state.index.nodes ? state.index.nodes[id] : null;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
})();
