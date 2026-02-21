# Plan: Evaluate C# DevKit (Replace OmniSharp)

Your current setup: `ms-dotnettools.csharp` in OmniSharp mode (`dotnet.server.useOmnisharp: true`) with `ms-dotnettools.csdevkit` installed but disabled. You're already 80% pre-configured for DevKit with the solution-free settings you have dimmed. Here's what changes.

## Steps

### 1. Uninstall `formulahendry.dotnet-test-explorer`

It doesn't support xunit.v3 and DevKit has its own built-in Test Explorer (via Testing panel). Remove the extension entirely, then clean up all `dotnet-test-explorer.*` settings from `settings.json`:

- Remove `dotnet-test-explorer.enabled`
- Remove `dotnet-test-explorer.testProjectPath`
- Remove `dotnet-test-explorer.testArguments.Off`
- Remove `dotnet-test-explorer.enableTelemetry`
- Remove `dotnet-test-explorer.treeMode`

### 2. Remove `dotnet-test-explorer.testProjectPath` from all 16 workspace files

Every `.code-workspace` file in `C:\BTR\Camelot\Workspaces\` has this setting in its `settings` block. After removing the extension, these become dead settings.

**Affected files:**
- `Camelot.Abstractions.code-workspace`
- `Camelot.Core.code-workspace`
- `Camelot.RCL.KatApp.code-workspace`
- `RBLe.Core.code-workspace`
- `Api\DataLocker Api.code-workspace`
- `Api\Excel Api.code-workspace`
- `Api\Legacy.DataLocker Api.code-workspace`
- `Api\RBLe Api.code-workspace`
- `Api\WebService.Proxy Api.code-workspace`
- `Api\xDS Api.code-workspace`
- `Extensibility\Excel.AddIn.code-workspace`
- `Extensibility\TFS.Build.Release.code-workspace`
- `Services\FTP.code-workspace`
- `Services\SherpaSync.code-workspace`
- `Websites\Admin\AZI.Admin.code-workspace`
- `Websites\ESS\Nexgen.code-workspace`

### 3. Enable `ms-dotnettools.csdevkit`

Right-click it in the Extensions sidebar → Enable. No additional extensions to install; the C# extension (`ms-dotnettools.csharp`) stays and DevKit enhances it. There is no separate OmniSharp extension to disable — it's all controlled by the one setting below.

### 4. Change settings in `settings.json`

| Setting | Current | Action | Reason |
|---------|---------|--------|--------|
| `dotnet.server.useOmnisharp` | `true` | **Remove or set `false`** | This is THE switch. `false`/absent = Roslyn LSP (DevKit mode). `true` = OmniSharp. |
| `omnisharp.autoStart` | `true` | **Remove** | Irrelevant without OmniSharp — dead setting. |
| `razor.plugin.path` | `"C:\\Invalid_To_Enable_OmniSharp_Analyzer"` | **Remove** (both the active value at the bottom and the commented-out copy near the top) | This hack was only needed to suppress Razor's DevKit analyzer while forcing OmniSharp. With DevKit active, the Razor analyzer is the correct one to use. |
| `dotnet.automaticallyCreateSolutionInWorkspace` | `false` | **Keep** | Critical — prevents DevKit from auto-creating `.sln` files. Already correctly set. |
| `dotnet.enableWorkspaceBasedDevelopment` | `true` | **Keep** | Enables solution-free workspace mode. Already set, will become effective. |
| `dotnet.previewSolution-freeWorkspaceMode` | `true` | **Investigate/Remove** | This was a preview-era name. May be redundant with `dotnet.enableWorkspaceBasedDevelopment`. After enabling DevKit, check if this setting still shows as recognized (not dimmed). If dimmed, remove it. |
| `dotnet.preferVisualStudioCodeFileSystemWatcher` | `true` | **Keep** | DevKit file watcher preference. Will become active. |
| `dotnet.help.firstView` | `"gettingStarted"` | **Keep** | DevKit setting, will become active. |
| `dotnet.inlayHints.*` (3 settings) | `true` | **Keep** | Work with both OmniSharp and Roslyn LSP. |
| `dotnet.unitTestDebuggingOptions` | logging config | **Keep** | Works with DevKit testing. |

### 5. launch.json — No required changes

Your `launch.json` uses `"type": "coreclr"`. This still works with DevKit — the C# extension provides this debugger type regardless. However, DevKit introduces `"type": "dotnet"` as the newer equivalent. No urgency to change, but if you create new configs, use `"dotnet"` instead.

### 6. Code analysis squiggles (IDE0300, etc.)

These will continue working. The Roslyn LSP that DevKit uses is actually *better* at surfacing Roslyn analyzers than OmniSharp. Your IDE0300 "Collection initialization can be simplified" info squiggles and Problems panel entries will persist. Both engines read `.editorconfig` and `<AnalysisLevel>` from your csproj files identically. If anything, you may see *more* diagnostics surface that OmniSharp was missing.

### 7. DevKit testing and xunit.v3

DevKit's built-in Test Explorer supports xunit.v3 through `Microsoft.Testing.Platform`. Verify your test projects reference the xunit.v3 packages (not the old `xunit` 2.x runner). The tests should appear in the VS Code Testing panel (beaker icon) automatically.

## Verification

- After making changes, reload VS Code (`Developer: Reload Window`)
- Open a `.cs` file → check the status bar bottom-right shows the Roslyn language server (not OmniSharp)
- Open the Testing panel (beaker icon) → verify your xunit tests are discovered
- Open `SsoTests.cs` → confirm IDE0300 squiggle still appears on line 9 and shows in Problems panel
- Run/debug using existing launch configs → confirm `coreclr` debugger still works
- Confirm no `.sln` file was auto-created in any workspace folder

## Decisions

- Keep `coreclr` in launch.json for now (no functional difference, avoids touching all workspace launch configs)
- Full remove of dotnet-test-explorer rather than just disable (clean break, no value in keeping it)
- Remove `razor.plugin.path` hack entirely (it was an OmniSharp-specific workaround)