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

**Attempt 7 — Root cause identified: `VSTEST_DEBUG_NOBP=1` kills the `stopped` event**
- Root cause: `VSTEST_HOST_DEBUG=1` makes the testhost spin-wait on `Debugger.IsAttached`. Once the debugger attaches, the testhost calls `Debugger.Break()` — UNLESS `VSTEST_DEBUG_NOBP=1` is set. With `NOBP=1`, the testhost skips `Debugger.Break()` and runs tests immediately. No `stopped` event is ever fired. The entire auto-continue logic is gated on `stoppedThreadId !== undefined` (set from the `stopped` event), so it is permanently dead code. The 8-second fallback fires, but by then tests have completed. The `configurationDone+stopped` mechanism introduced in Attempt 6 was structurally correct but was implemented simultaneously with `NOBP=1`, making it self-defeating.
- Fix: Remove `VSTEST_DEBUG_NOBP: '1'` from the spawn env. Without it, `Debugger.Break()` fires → `stopped` event arrives → `stoppedThreadId` is set → `doAutoContinue` fires once `configurationDone` is also received → `continue` sent → user breakpoints (registered as pending by vsdbg during DAP init) bind when the test assembly JIT-compiles → breakpoints hit.
- Secondary fix: Session name now includes PID to uniquify it; cancellation fallback no longer calls `stopDebugging()` with no args (which would kill all debug sessions).

**Attempt 10 — VSTest v2 path: suppress Debugger.Break stop with VSTEST_DEBUG_NOBP**
- v2 unit tests confirmed working (breakpoints hit) but users hit two unwanted intermediate stops.
- Stop 1 (Debugger.Break in DebuggerBreakpoint.cs): Restored `VSTEST_DEBUG_NOBP=1` to the VSTest env. Now that v3 uses the direct `.exe` path, NOBP is safe for the v2/VSTest fallback — the process runs freely after attach, pending breakpoints bind on module load.
- Stop 2 (MissingMethodException on `Xunit.Sdk.InlineDataDiscoverer`): This fires because the user has "break on all exceptions" globally enabled in VS Code. It's an xUnit v2/v3 SDK version mismatch in the test runner, not a bug in the extension. Cannot suppress it per-session without interfering with global exception filter settings. User can press F5 past it or disable "break on all exceptions" when not needed.


- Bug in Attempt 9 (fix 2): xUnit v3 `-waitForDebugger` prints `"Waiting for debugger to be attached..."` but does NOT print its own PID. Trying to regex-match a PID that never appears caused the 30s timeout. The user's working task uses `"processName": "Camelot.Api.DataStore.Tests.Integration"` not a PID. Fixed: watch for the "Waiting for debugger" string to confirm the process is ready, then attach by `processName` (exe basename without extension) instead of `processId`.
- Bug in Attempt 9: `dotnet msbuild -getProperty:TargetPath` always returns the managed `.dll` path even for executable projects (xUnit v3). The apphost `.exe` is generated alongside it. Detection now swaps `.dll` → `.exe` and checks for existence of that file instead. xUnit v3 ships as a self-contained `.exe`; the user's working setup runs `Camelot.Api.DataStore.Tests.Integration.exe -waitForDebugger -method <fqn>` directly. When launched this way, the exe polls `Debugger.IsAttached` and simply continues when the debugger attaches — no `stopped` event, no `Debugger.Break()`, no auto-continue logic required. vsdbg attaches, registers pending breakpoints, module loads resolve them, tests run, breakpoints hit.
- All prior attempts used `dotnet test ... VSTEST_HOST_DEBUG=1` which routes through testhost.exe — that is the VSTest adapter path, not xUnit v3's native runner. xUnit v3 with the VSTest adapter (`xunit.runner.visualstudio`) still spawns testhost.exe, but the `Debugger.Break()` behavior differs from v2, and the modules load and tests execute before breakpoints can bind.
- Fix: Use `dotnet msbuild -getProperty:TargetPath -p:Configuration=Debug` to resolve the output assembly path. If it ends in `.exe` and exists, run it directly with `-waitForDebugger [-method <fqn>]`. If it's a `.dll` (v2/non-v3), fall back to `dotnet test VSTEST_HOST_DEBUG=1`. The entire DAP tracker / auto-continue / stopped-event mechanism is removed for the v3 path.

#### Diagnostic output needed to move forward (superseded by Attempt 7):
- Finding 1: Despite removing `VSTEST_DEBUG_NOBP: '1'` explicitly in the env object, `...process.env` spread could re-introduce it if it exists in the shell's inherited environment. Fixed by explicitly deleting the key after spreading: `const e = { ...process.env, VSTEST_HOST_DEBUG: '1' }; delete e['VSTEST_DEBUG_NOBP']; return e;`
- Finding 2 (critical, newly identified): The DAP log showed `"requireExactSource":true` being injected into the attach args by VS Code's default coreclr config. After `configurationDone`, all four breakpoints immediately updated to `"No symbols have been loaded for this document"` — and even after `Camelot.Api.DataStore.Tests.Integration.dll` loaded WITH symbols, no breakpoint ever verified. `requireExactSource:true` causes vsdbg to reject breakpoints where the source file checksum doesn't exactly match the PDB. Added `requireExactSource: false` and `suppressJITOptimizations: true` to the attach config.
- Note: xUnit v2 test DID hit breakpoints (with 'break on all exceptions' causing an initial stop that gave time for breakpoint binding). xUnit v3 integration test did not — no `stopped` event seen at all in v3 run even without `VSTEST_DEBUG_NOBP`. May indicate xUnit v3 + VSTest 18 + .NET 10 has a different `VSTEST_HOST_DEBUG` behavior.

#### Diagnostic output needed to move forward (superseded by Attempt 7):
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
