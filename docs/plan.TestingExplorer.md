# TestExplorer Extension Plan (C# / xUnit)

## Goal
Implement VS Code **Testing Explorer** support (test tree, run, debug, editor gutter/inline actions, results UI) similar to the C# Dev Kit testing experience, **without** requiring the Dev Kit extension.

### Requirements
- Location: `c:\btr\camelot\extensibility\TestExplorer`
- Framework: **xUnit v3** (v2 nice-to-have)
- UX: replicate features described at https://code.visualstudio.com/docs/csharp/testing
- Execution: use `dotnet test` (VSTest runner) under the hood
- Debugging: integrate with VS Code debugging (depend on the C# extension for debugger)
- Scope: workspace/solution-level discovery

## Approach Summary
Use VS Code's built-in **Testing API** to surface tests, run/debug actions, and results. For good editor UX (run/debug icons next to tests), discovery must provide accurate `uri` + `range` for declarations.

To do that reliably, ship a small **.NET worker** (Roslyn/MSBuildWorkspace) for discovery and orchestration. Execution uses `dotnet test` with `--filter` and TRX logging.

## Repo Layout (proposed)
- `extension/` (TypeScript VS Code extension)
  - `package.json` / `tsconfig.json`
  - `src/extension.ts` (activation)
  - `src/testing/` (TestController, profiles, run/debug)
  - `src/worker/` (spawn and IPC to worker)
  - `src/results/` (TRX parsing -> VS Code TestRun updates)
- `worker/` (.NET console app)
  - `TestExplorer.Worker/`
    - `Program.cs` (stdio NDJSON server)
    - `Discovery/` (MSBuildWorkspace + Roslyn symbol scan)
    - `Protocol/` (request/response models)

## VS Code APIs to Use
- `vscode.tests.createTestController`
- `TestItem` with `uri` and `range` set for class/method declarations
- `controller.createRunProfile(...)` for:
  - Run (default)
  - Debug
  - (optional phase 2) Run with Coverage
- `TestRun` methods: `enqueued`, `started`, `passed`, `failed`, `skipped`, `appendOutput`, `end`
- Debug integration: `vscode.debug.startDebugging(...)` + `DebugSessionOptions.testRun`

## Discovery (Worker)
1. Find solution/projects:
   - Prefer `.sln` if present; else enumerate `**/*.csproj`.
2. Load with `MSBuildWorkspace`.
3. Identify xUnit tests:
   - Scan method symbols for attributes named `Fact` / `Theory`.
   - Compute a stable ID: `<projectPath>|<fullyQualifiedSymbolName>` (optionally add TFM if needed).
   - Record declaration location: file path + (startLine,startCol,endLine,endCol).
4. Return a hierarchical structure:
   - Project -> Namespace -> Class -> Method

## Running Tests (Extension)
- Group requested tests by owning project.
- For each project invoke:
  - `dotnet test <project.csproj> --filter <expr> --logger "trx;LogFilePrefix=<prefix>" --results-directory <temp>`
  - For run-all, omit `--filter`.
- Build filter expressions using VSTest-supported properties:
  - `FullyQualifiedName=...` (exact)
  - `FullyQualifiedName~...` (contains)
- Parse TRX to map results back to test IDs.

References:
- Filter syntax (xUnit supported): https://learn.microsoft.com/dotnet/core/testing/selective-unit-tests?pivots=xunit
- dotnet test (VSTest runner options): https://learn.microsoft.com/dotnet/core/tools/dotnet-test-vstest

## Debugging Tests (Extension)
- Start a debug session that runs `dotnet test` with the same project + filter.
- Depend on the installed C# extension's debugger type (commonly `coreclr`).
- Link session to `TestRun` using `DebugSessionOptions.testRun`.

## Phase 2

### 1. Run with Coverage ✅ COMPLETE

**What it is:** When running tests with coverage, the code is instrumented during test execution to track which lines/branches were actually hit. After the run, VS Code overlays colored highlights in source files — green for covered lines, red for uncovered — and shows a coverage percentage per file. This helps identify untested code paths.

**Implementation summary:**

- `engines.vscode` and `@types/vscode` bumped to `^1.88.0` — required for `TestRunProfileKind.Coverage`, `FileCoverage`, `StatementCoverage`, `BranchCoverage`, `TestCoverageCount`
- New run profile registered: `controller.createRunProfile('Run with Coverage', vscode.TestRunProfileKind.Coverage, coverageHandler, false)`
- `profile.loadDetailedCoverage` implemented for line-level gutter overlays — returns `StatementCoverage[]` and `BranchCoverage[]` per file
- Registering the Coverage profile is what causes VS Code to automatically show the **"Run with Coverage"** button in the Testing pane toolbar

**Files created/modified:**
- `extension/src/testing/coverageHandler.ts` *(new)* — coverage run handler; invokes `dotnet test` with coverlet MSBuild args, parses Cobertura XML, calls `run.addCoverage()`, updates cache
- `extension/src/results/coberturaParser.ts` *(new)* — two-pass Cobertura XML parser (see Multi-class decision below)
- `extension/src/testing/coverageCache.ts` *(new)* — MD5 hash cache for staleness detection and coverage restore
- `extension/src/testing/controller.ts` — registered Coverage profile, `loadDetailedCoverage`, and Restore Last Coverage command
- `extension/src/dotnet/dotnetTestRunner.ts` — added `msBuildProperties?: Record<string, string>` with shell-safe quoting
- `extension/package.json` — engine bump, `test-explorer.restoreLastCoverage` command + toolbar entry

---

**Decision: Shell-quoting MSBuild property values**

`spawnProcess` uses `shell: true`. MSBuild property values containing spaces (e.g. temp directory paths) must be passed as `/p:Key="value"` — without quotes the shell splits the argument at the space and the build fails silently. Values are now always wrapped in double quotes.

---

**Decision: Two-pass Cobertura parser for multi-class files**

A C# file with multiple classes produces one `<class>` element per class in the Cobertura XML, each with its own `<lines>` block. The same line number can appear in multiple classes. A naïve first-seen-wins approach gives wrong hit counts when ClassA says line 42 hit=0 and ClassB says hit=5.

**Fix:** two-pass parse. First pass accumulates `Map<fileUri, Map<lineNumber, RawLineData>>`, taking `Math.max(hits)` across all classes for each line. Second pass builds `StatementCoverage[]` and counts from the merged data.

---

**Decision: WeakMap for per-run detail storage**

`loadDetailedCoverage` must return the correct details for the specific `TestRun` that owns the coverage (concurrent or sequential runs must not clobber each other). A `WeakMap<TestRun, Map<uri, FileCoverageDetail[]>>` is used so each run owns its detail map and entries are GC'd automatically when the run is released.

---

**Decision: MD5 content hash for staleness detection (file watchers rejected)**

File watchers were considered but rejected as unreliable on Windows. Instead, when coverage is captured, an MD5 hash of each file's contents is stored in `CoverageCache`. When `loadDetailedCoverage` fires for a file, the current hash is compared to the stored hash. If they differ a warning notification is shown; the coverage is still displayed.

---

**Decision: Staleness check fires only at detail-view time, not on save**

Checking on every save would produce noise the user didn't ask for and requires tracking display/clear state. The correct intercept point is `loadDetailedCoverage`, which fires per-file when the user opens coverage gutters for that file. No `onDidSaveTextDocument` listener. No state tracking for "is coverage currently displayed."

---

**Decision: Restore Last Coverage command**

After coverage is cleared, VS Code's built-in **"View Test Coverage"** button in the Test Results pane can re-show coverage from the existing run (VS Code caches `loadDetailedCoverage` results per run). However, if the test run has been dismissed from the results panel, that button is gone.

The `test-explorer.restoreLastCoverage` command (toolbar icon in the Testing pane) creates a *new* `TestRun` from the cached `CoverageCache` data. Because it's a new run, `loadDetailedCoverage` fires fresh for each file — which means the staleness (hash) check actually runs. This is the only path where the staleness warning fires; VS Code's own toggle reuses cached results and never re-invokes our callback.

The toolbar button is only visible when `test-explorer.hasCachedCoverage` context key is true (set after a successful coverage run).

---

**VS Code built-in coverage toggle buttons**

Registering a Coverage profile and calling `run.addCoverage()` causes VS Code to automatically render **"View Test Coverage"** and **"Close Test Coverage"** buttons in the Test Results pane. These are VS Code's own UI elements and cannot be suppressed or customized. They toggle gutter overlay visibility using VS Code's internally cached `loadDetailedCoverage` results — our staleness check does not fire when these buttons are used.

---

### Coverage Package Decision & xunit.runner.visualstudio

**Background — why the original plan said `coverlet.collector`:**

The original design used `dotnet test --collect:"XPlat Code Coverage"`. That flag is a **VSTest data collector hook** — it instructs the VSTest host to activate a registered collector named `XPlat Code Coverage`, which is provided by the `coverlet.collector` NuGet package. If that package is missing from the test project, VSTest has nothing to activate and produces **no coverage file and no error** (silent failure). That is what the risk note was about.

**Decision: remove `coverlet.collector`, use `coverlet.msbuild` instead.**

`coverlet.msbuild` operates at the MSBuild layer, wrapping the entire `dotnet test` invocation. It is independent of the VSTest vs MTP runner underneath, making it more robust. This is already the approach used by all external tooling (tasks.json, TFS build utility, local output generation — see below). Standardizing on it eliminates the `coverlet.collector` silent-failure problem entirely.

**Decision: keep `xunit.runner.visualstudio` for now.**

`xunit.runner.visualstudio` is what keeps xunit.v3 projects running through VSTest mode. This extension is built on VSTest output (TRX parsing, `--filter` using VSTest filter syntax, `--logger trx`). Removing it would switch projects to Microsoft.Testing.Platform (MTP) mode, which uses a different execution protocol, different filter syntax, and different output format — requiring significant rework of the extension's run and result-parsing pipeline. Keep it until MTP support is a deliberate goal.

**Per-project NuGet references (xunit.v3 test project):**

```xml
<PackageReference Include="Microsoft.NET.Test.Sdk" Version="18.0.1"/>
<PackageReference Include="xunit.v3" Version="3.2.0" />
<!-- coverlet.collector REMOVED - was VSTest data collector, not needed with coverlet.msbuild -->
<PackageReference Include="coverlet.msbuild" Version="6.0.4" PrivateAssets="all"
    IncludeAssets="runtime; build; native; contentfiles; analyzers; buildtransitive" />
<PackageReference Include="xunit.runner.visualstudio" Version="3.1.5" PrivateAssets="all"
    IncludeAssets="runtime; build; native; contentfiles; analyzers; buildtransitive"/>
```

**How this affects each scenario:**

**1. Project References**
Remove `coverlet.collector`. Keep `coverlet.msbuild` and `xunit.runner.visualstudio`. No other changes.

**2. Extension "Run with Coverage" — dotnet test args (coverageHandler.ts)**

Replace `--collect:"XPlat Code Coverage"` with MSBuild properties:

```
dotnet test <project.csproj>
  --logger trx;LogFileName=TestResults.trx
  --results-directory <tempDir>
  /p:CollectCoverage=true
  /p:CoverletOutputFormat=cobertura
  /p:CoverletOutput=<tempDir>/coverage.cobertura.xml
```

The Cobertura file will be at the path specified by `/p:CoverletOutput`. The coberturaParser should read from that explicit path rather than scanning for `*.cobertura.xml`.

**3. Tasks.json (local test + report task)**

The `test - execute` args already use `/p:CollectCoverage=true` — no changes needed there.

The `test - open` step previously called `coverage-gutters.previewCoverageReport` (the Coverage Gutters VS Code extension command). Since Coverage Gutters is being removed, replace it with a shell command that opens the ReportGenerator HTML output directly:

```jsonc
{
    "label": "test - open",
    "hide": true,
    "command": "cmd",
    "type": "shell",
    "args": ["/c", "start", "<path-to-TestResults>/CoverageReport/index.html"],
    "problemMatcher": []
}
```

**4. TFS Build Utility (runs on TFS Build Server)**

No changes. Already uses `/p:CollectCoverage=true /p:CoverletOutputFormat=cobertura`. Removing `coverlet.collector` from project references has no effect on MSBuild-driven coverage.

**5. Local Test/Generate Report Output Files**

No changes. Same reasoning as #4 — already MSBuild-driven.

**6. TFS Publish Steps**

No changes. The TFS "Publish Code Coverage" step consumes a Cobertura XML file at a configured path. The file format and location do not change. The TFS "Publish Test Results" step consumes TRX files — also unchanged.

---

### 2. Multi-target project support

**Status:** Partial — TFM suffix on project nodes is done. The following is not yet handled:

- `dotnet test` on a multi-target project (with `<TargetFrameworks>` plural) produces one TRX file per TFM. The current `findTrxFile` returns only the first match, which can silently drop results for other TFMs.
- Investigation needed: detect multi-TFM projects, either run per-TFM with `--framework <tfm>` or merge TRX results across TFMs
- For the test tree, multi-TFM projects may need separate project nodes per TFM (DevKit behavior) or a single merged node

**Files to change:** `extension/src/dotnet/dotnetTestRunner.ts`, `extension/src/results/trxParser.ts`, potentially `worker/TestExplorer.Worker/Program.cs`

---

### 3. Discovery performance and caching

**Status:** Not implemented. Current behavior: full rediscovery (including `dotnet test -t` VSTest listing for theories) runs on every file save with a 1.5s debounce. For large solutions this will be slow.

- Cache discovery results per project, keyed by project file + source file timestamps
- Invalidate cache only when a `.csproj` or `.cs` file in the project changes
- For theory listing specifically (`dotnet test -t`): this requires a prior build; cache aggressively and only re-run when test source files change
- Consider separating "structural" discovery (Roslyn, fast) from "case enumeration" (VSTest listing, slow) with separate invalidation strategies

**Files to change:** `extension/src/testing/controller.ts`, `worker/TestExplorer.Worker/Discovery/XunitDiscovery.cs`, `worker/TestExplorer.Worker/Program.cs`

---

### 4. NUnit and MSTest framework support

**Status:** Not implemented. Current extension only discovers xUnit (`[Fact]`/`[Theory]`). DevKit supports all three major frameworks.

- Worker discovery needs to detect NUnit (`[Test]`, `[TestCase]`, `[TestCaseSource]`) and MSTest (`[TestMethod]`, `[DataRow]`, `[DataTestMethod]`) attributes
- Theory-equivalent: NUnit `[TestCase]` maps to inline data rows (similar to xUnit `[InlineData]`); MSTest `[DataRow]` same
- Filter syntax differs per framework — `buildVSTestFilter` needs framework-aware output
- Framework detection per project: check NuGet package references (`xunit`, `NUnit`, `MSTest.TestFramework`) to determine which attribute set to scan for

**Files to change:** `worker/TestExplorer.Worker/Discovery/XunitDiscovery.cs` (rename/generalize), `extension/src/testing/filterBuilder.ts`, `worker/TestExplorer.Worker/Protocol/DiscoveryDtos.cs`

## How to Resume Work (copy/paste into a new chat if needed)
"Build a VS Code extension in c:\\btr\\camelot\\extensibility\\TestExplorer following PLAN.md. Implement Testing API provider + .NET worker discovery (Roslyn) + dotnet test run/debug with TRX parsing. Focus xUnit v3; v2 nice-to-have."

## Development Workflow

### Extension Development Host (correct approach — no VSIX needed)
The correct way to develop and debug a VS Code extension is to use the **Extension Development Host** — a second VS Code window that runs your extension from source. No building a VSIX, no closing VS Code, no install commands.

Setup:
1. Open `c:\BTR\Camelot\Extensibility\VS.Code.Test.Explorer\extension\` as the workspace in VS Code.
2. Ensure a `.vscode/launch.json` exists with an `"extensionDevelopmentPath"` entry (standard VS Code extension scaffold generates this).
3. Press **F5** (or Run → Start Debugging). VS Code opens a second window — the Extension Development Host — with your extension loaded from source.
4. In the second window, open your test project workspace.
5. Set breakpoints in the extension TypeScript source in the first window.
6. Trigger extension behavior in the second window — breakpoints hit in the first.

To iterate: make a TypeScript change, press **Ctrl+Shift+F5** to restart the Extension Development Host. No VSIX, no close/reopen.

This needs to be set up if not already present.
