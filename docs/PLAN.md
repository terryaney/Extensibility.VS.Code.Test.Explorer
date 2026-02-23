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
Use VS Code’s built-in **Testing API** to surface tests, run/debug actions, and results. For good editor UX (run/debug icons next to tests), discovery must provide accurate `uri` + `range` for declarations.

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
- Depend on the installed C# extension’s debugger type (commonly `coreclr`).
- Link session to `TestRun` using `DebugSessionOptions.testRun`.

## Phase 2

### 1. Run with Coverage

**What it is:** When running tests with coverage, the code is instrumented during test execution to track which lines/branches were actually hit. After the run, VS Code overlays colored highlights in source files — green for covered lines, red for uncovered — and shows a coverage percentage per file. This helps identify untested code paths.

**What's needed:**

- Add a new run profile: `controller.createRunProfile('Run with Coverage', vscode.TestRunProfileKind.Coverage, coverageHandler, false)`
- Run `dotnet test` with MSBuild coverage args — see **Coverage Package Decision** section below for the correct args
- Parse the generated Cobertura XML file from the results directory
- For each file: call `run.addCoverage(new vscode.FileCoverage(uri, statementCoverage))`
- Optionally implement `profile.loadDetailedCoverage` to return `StatementCoverage[]` arrays for line-level gutter overlays
- May require bumping `engines.vscode` in `package.json` from `^1.85.0` to `^1.88.0` (coverage API was added in 1.88)
- The Coverage run profile being registered is what causes VS Code to automatically show the "Run with Coverage" button in the Testing pane toolbar

**Risks:**
- Multi-target projects produce one coverage file per TFM — need a merge or selection strategy
- Coverage file location varies; scan results directory for `*.cobertura.xml` or `coverage.cobertura.xml`

**Files to change:** `extension/src/testing/controller.ts` (new profile), new file `extension/src/testing/coverageHandler.ts`, new file `extension/src/results/coberturaParser.ts`, `extension/package.json` (engine bump)

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
