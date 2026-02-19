# KAT C# Test Explorer

C# test discovery and execution using VS Code Testing API. Discovers xUnit tests via Roslyn/MSBuildWorkspace, runs and debugs via `dotnet test` (VSTest runner).

## Features

- Discover xUnit v3 tests in C# projects (solution or workspace)
- Run tests from the Testing Explorer tree, editor gutter, or command palette
- Real-time test execution output with pass/fail results
- Integration with VS Code's native Testing UI (Test Results pane, gutter decorations)
- Debug test support (in progress — see Known Issues)

## Requirements

- .NET 8 SDK or later
- VS Code 1.85.0 or later
- [C# extension](https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.csharp) for VS Code

## Development Workflow

### The right way: Extension Development Host

Do NOT build a VSIX for iterative development. Use the Extension Development Host instead:

1. Open the `extension/` folder as the workspace in VS Code.
2. Ensure `.vscode/launch.json` exists with a Run Extension launch configuration (standard scaffold).
3. Press **F5** — a second VS Code window opens with the extension loaded from source.
4. Open your test project in the second window.
5. Set breakpoints in the TypeScript source in the first window — they will hit when the extension runs in the second window.
6. To iterate after a change: **Ctrl+Shift+F5** restarts the Extension Development Host. No VSIX build, no close/reopen cycle.

### Building a VSIX (for distribution/final install only)

```powershell
cd extension

# Install dependencies (first time only)
npm install

# Build .NET worker + bundle TypeScript + package
npm run package
```

Produces `csharp-test-explorer-0.1.0.vsix`.

### Installing the VSIX

**Important**: VS Code locks the extension folder while running. You must close ALL VS Code windows before installing.

```powershell
# Close all VS Code windows first, then:
code --install-extension "c:\BTR\Camelot\Extensibility\VS.Code.Test.Explorer\extension\kat-csharp-test-explorer-0.1.0.vsix" --force
```

### Examining extension output

Open the Output panel (`Ctrl+Shift+U`) and select **KAT C# Test Explorer** from the dropdown. All discovery, run, and debug activity is logged there — this is the primary diagnostic tool.

## Architecture

### Extension (TypeScript, esbuild-bundled)
- VS Code extension host process
- Test controller (`src/testing/controller.ts`) — builds test tree, handles discovery
- Run handler (`src/testing/runHandler.ts`) — executes `dotnet test`, parses TRX
- Debug handler (`src/testing/debugHandler.ts`) — spawns testhost with `VSTEST_HOST_DEBUG=1`, attaches coreclr debugger
- Worker client (`src/worker/workerClient.ts`) — NDJSON IPC to .NET worker

### Worker (.NET 8 console app)
- Loads C# projects via `MSBuildWorkspace`
- Discovers `[Fact]`/`[Theory]` methods using Roslyn symbol APIs
- Returns test hierarchy over stdout as NDJSON
- Returns 0-indexed line/column numbers for `Range` construction

## Known Issues

### Run profile icons static during execution
When running tests, tree/gutter/Test Results icons remain static during the run and only flip to pass/fail at completion. The debug profile correctly shows spinning icons. Root cause: `run.started()` is not being called on parent (class/namespace) nodes.

### Debug breakpoints not hitting
Debug attach works (testhost PID is found, coreclr attaches, `VSTEST_DEBUG_NOBP=1` suppresses the VSTest internal `Debugger.Break()`), but user breakpoints are not being hit. The exact cause is unknown — the DAP message sequence during coreclr attach needs to be captured to diagnose. See `PLAN.md` for full history of attempted fixes.

To help diagnose this, enable verbose DAP logging by examining the **KAT C# Test Explorer** output channel during a debug run for messages prefixed with `DAP →` and `DAP ←`.

## License

MIT
