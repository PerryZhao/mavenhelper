# Maven Helper (VS Code)

A Maven dependency UI inspired by the JetBrains MavenHelper plugin.

## Features
- Reimport dependencies (rebuilds local dependency index via `mvn dependency:tree`).
- Search/filter by `groupId`, `artifactId`, `version`, `classifier`.
- Flat list and dependency tree views.
- Jump to Source (opens local `*-sources.jar` or jar in `~/.m2/repository`).
- Location Properties (best-effort: opens the pom or property location that controls the effective version).
- BOM import resolution (searches imported BOMs in local repo for versions).
- Profile-aware resolution (uses Maven active profiles for indexing and lookup).
- Effective-pom fallback (generates effective POM for more accurate version lookup).
- Contextual UI per `pom.xml` (open from editor title, auto-refresh on pom change).
- Dependency tree verbose parsing (managed versions + strict source tracking hints).
- Selected dependency path highlighting with origin chain panel.

## Commands
- `Maven Helper: Open UI`
- `Maven Helper: Open UI (Current pom.xml)`
- `Maven Helper: Reimport Dependencies`

## Notes
- Requires Maven installed and available on `PATH`.
- Version origin is best-effort based on local pom parsing (dependencyManagement, properties, BOMs, profiles, parents, and effective POM fallback).
