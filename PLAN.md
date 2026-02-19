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

## Phase 2: Coverage (optional)
- Add a profile that runs:
  - `dotnet test --collect:"XPlat Code Coverage"`
- Convert coverage artifacts into VS Code Coverage API objects via `run.addCoverage(...)`.

## Edge Cases
- Missing adapters/packages: show actionable diagnostics when 0 tests are found.
- Multi-target projects: TRX per TFM; avoid overwriting; keep IDs stable.
- Filter escaping: generics/commas may require encoding (`%2C`).
- Theory/data-row granularity: phase 1 aggregate at method; phase 2 optionally synthesize children.
- Performance: cache discovery; incremental refresh; support cancellation.

## How to Resume Work (copy/paste into a new chat if needed)
"Build a VS Code extension in c:\\btr\\camelot\\extensibility\\TestExplorer following PLAN.md. Implement Testing API provider + .NET worker discovery (Roslyn) + dotnet test run/debug with TRX parsing. Focus xUnit v3; v2 nice-to-have."

## Known Remaining Issues

### Issue 1: Run profile icon state during execution
When selecting "Run" on a tree node, icons in the tree, gutter, and Test Results pane remain static during execution and only update to pass/fail after the run completes. The Debug profile correctly shows spinning icons during execution.

**Root cause**: The run handler calls `run.enqueued()` on parent/intermediate nodes (class, namespace, project) but only `run.started()` on leaf method nodes at the moment they're included in the run. VS Code requires `run.started()` to be called on every item that should show an active/spinning state — including parent nodes.

**Fix needed**: In `runHandler.ts`, when iterating tests to run, call `run.started()` (not `run.enqueued()`) on all items including parent nodes immediately before spawning `dotnet test`.

---

### Issue 2: Debug tests not hitting user breakpoints
**Status**: Unresolved after multiple implementation attempts.

#### Implementations attempted (all failed):

**Attempt 1 — `--no-build` with basic attach**
- Approach: `dotnet test --no-build` + `VSTEST_HOST_DEBUG=1`, parse PID, `coreclr` attach.
- Failure: ran against stale Release build (no debug symbols). Breakpoints silently skipped.

**Attempt 2 — `--configuration Debug` without pre-build**
- Approach: Added `--configuration Debug`, removed `--no-build`.
- Failure: `dotnet test` triggers full solution build during the run. This consumed the testhost's 30-second debugger-attach timeout. Result: "Could not find testhost process to attach to" error.

**Attempt 3 — Pre-build step + `justMyCode: true`**
- Approach: Explicit `dotnet build --configuration Debug` before `dotnet test --no-build`. `justMyCode: true` in attach config.
- Failure: Test ran to completion without hitting breakpoint. Auto-continue (fixed 1500ms timer) fired before VS Code had bound breakpoints to the loaded assembly.

**Attempt 4 — Fixed-delay auto-continue (1500ms)**
- Approach: DAP tracker watching for `stopped` event, then `setTimeout(1500)` before sending `continue`.
- Failure: The `stopped` event fires before the test assembly is even loaded into the process. 1500ms wasn't long enough for symbol binding.

**Attempt 5 — Module-load trigger**
- Approach: DAP tracker watching for `module` events. Wait for the test assembly DLL name to appear, then continue after 200ms.
- Failure: In coreclr, `module` events for already-loaded DLLs fire during the DAP initialization phase, BEFORE the `stopped` event. So the assembly was seen and dismissed (because `stoppedThreadId` wasn't set yet), and no further module event ever arrived. 10s fallback fired, but by then the test had already timed out.

**Attempt 6 — `VSTEST_DEBUG_NOBP=1` + `configurationDone` signal**
- Approach: Added `VSTEST_DEBUG_NOBP=1` env var (suppresses VSTest's `Debugger.Break()` call). DAP tracker waits for both `stopped` event AND `configurationDone` message (DAP-spec-guaranteed signal that VS Code has dispatched all `setBreakpoints` requests to the adapter).
- Result: No stop in VSTest internals (progress). Test ran without hitting breakpoint. Unclear whether `configurationDone` was actually received or fallback fired.

#### Sources consulted:
- VSTest environment variables: https://github.com/microsoft/vstest/blob/main/docs/environment-variables.md
- VSTest diagnose docs: https://github.com/microsoft/vstest/blob/main/docs/diagnose.md
- VSTest `DebuggerBreakpoint.cs` source: https://github.com/microsoft/vstest/blob/main/src/Microsoft.TestPlatform.Execution.Shared/DebuggerBreakpoint.cs
- DAP specification (configurationDone, module events): https://github.com/microsoft/debug-adapter-protocol/blob/main/specification.md
- VS Code Testing API docs: https://code.visualstudio.com/api/extension-guides/testing
- `formulahendry/dotnet-test-explorer` (open source .NET test explorer): https://github.com/formulahendry/dotnet-test-explorer

#### Diagnostic output needed to move forward:
The following `outputChannel.appendLine()` calls should be added to `debugHandler.ts` to capture what's actually happening in the DAP message flow:

1. **In `onWillReceiveMessage`**: Log ALL message commands, not just `configurationDone`:
  ```typescript
  outputChannel.appendLine(`DAP ← editor: ${message.type} ${message.command ?? ''}`);
  ```

2. **In `onDidSendMessage`**: Log ALL events from the adapter:
  ```typescript
  outputChannel.appendLine(`DAP → editor: ${message.type} ${message.event ?? message.command ?? ''} ${JSON.stringify(message.body ?? {}).substring(0, 120)}`);
  ```

3. This will produce a full DAP message log in the "KAT C# Test Explorer" output channel, showing the exact sequence of events during attach and whether `configurationDone` is sent, and when `stopped`/`module` events arrive relative to each other.

---

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
