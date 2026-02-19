# MVP Validation Checklist: KAT C# Test Explorer (Dev Kit UX Parity)

This checklist defines the manual validation steps required to verify the extension achieves UX parity with the C# Dev Kit Test Explorer for the MVP.

## 1. Visual UX Checks
**Goal:** Ensure the Test Explorer tree and UI elements match standard VS Code Testing conventions.

- [ ] **Tree Hierarchy**
    - [ ] Hierarchy is: `Project` -> `Namespace` (flat or nested) -> `Class` -> `Method`.
    - [ ] `Facts` and `Theories` are displayed correctly.
    - [ ] Theory data rows (if supported) appear as children of the Theory method.
- [ ] **Icons & State**
    - [ ] Tests start with "Unset" (hollow circle) state.
    - [ ] "Running" spinner appears on parent and child nodes during execution.
    - [ ] "Passed" (green tick), "Failed" (red cross), "Skipped" (yellow arrow) icons update correctly.
- [ ] **Labels & Layout**
    - [ ] Test names are human-readable (not fully qualified, unless resolving conflict).
    - [ ] Execution duration is displayed next to tests after run.
    - [ ] Long names truncate gracefully.
- [ ] **Action Buttons**
    - [ ] "Run Tests" (play icon) visible on hover for all nodes.
    - [ ] "Debug Tests" (bug icon) visible on hover for all nodes.
    - [ ] Global "Run All" and "Debug All" buttons in Test Explorer view title work.

## 2. Functional Checks
**Goal:** Verify core testing operations work reliably.

- [ ] **Discovery**
    - [ ] Tests are discovered immediately upon opening a folder with a valid `.sln` or `.csproj`.
    - [ ] "Refresh Tests" button triggers a re-discovery.
    - [ ] Adding a new test file/method and building updates the tree (or manual refresh updates it).
- [ ] **Execution (Run)**
    - [ ] **Run All:** Running root node executes all tests in workspace.
    - [ ] **Run Project:** Running a project node executes only that project's tests.
    - [ ] **Run Class:** Running a class node executes all methods in that class.
    - [ ] **Run Single:** Running a single method executes only that method.
    - [ ] **Run Selection:** Multi-selecting tests and clicking run executes the selection.
- [ ] **Execution (Debug)**
    - [ ] **Debug Single:** Clicking debug on a test hits a breakpoint inside that test.
    - [ ] **Debug Class/Project:** Debugging a group hits breakpoints in any of the contained tests.
    - [ ] Variables and Call Stack are inspectable during debug session.
- [ ] **Stop/Cancel**
    - [ ] Clicking "Stop" button in Test Explorer or Debug Toolbar terminates the run/debug session cleanly.
    - [ ] Test states revert to previous or "unset" (depending on implementation policy) or stay as partial results.

## 3. Editor Integration Checks
**Goal:** Ensure "Test at Cursor" and inline code lens/gutter experiences work.

- [ ] **Gutter Decorations**
    - [ ] Green/Red/Grey diamonds appear in the requested file line numbers (usually method signature).
    - [ ] Clicking the gutter icon opens the context menu (Run/Debug).
    - [ ] Status updates (spinners -> pass/fail) reflect in real-time in the editor gutter.
- [ ] **Code Lenses (Optional for MVP, strictly Gutter is preferred in new VS Code API)**
    - [ ] *If implemented:* "Run | Debug" text appears above `[Fact]` and `[Theory]` methods.
- [ ] **Inline Results**
    - [ ] Failed tests show a "Peek Error" view or inline message in the editor.
    - [ ] Stack trace links in the Test Results output are clickable and navigate to the crashing line.

## 4. Result Reporting & Output
**Goal:** Verify the developer gets actionable feedback.

- [ ] **Test Output Terminal**
    - [ ] Standard output (`Console.WriteLine`) from tests is captured and shown in the Test Results view (or Output channel).
- [ ] **Failure Messages**
    - [ ] Assertion failures show "Expected X, Actual Y".
    - [ ] Stack traces are preserved and displayed.
- [ ] **Diff View**
    - [ ] For equality assertion failures, VS Code's native "Diff View" (Expected vs Actual) is triggered.

## 5. Edge Cases
**Goal:** Stress test the extension with non-standard scenarios.

- [ ] **Complex Hierarchies**
    - [ ] Nested namespaces (`A.B.C`) render correctly (either flat `A.B.C` or nested `A`->`B`->`C`).
    - [ ] Tests in the Global Namespace (no namespace) handle gracefully.
- [ ] **Build Failures**
    - [ ] Attempting to run tests when the project fails to build reports a clear error, does not hang.
- [ ] **Zero Tests**
    - [ ] Opening a project with no tests results in an empty tree or "No tests found" message, no errors.
- [ ] **xUnit Theories**
    - [ ] Theories with inline data run correctly.
    - [ ] Theories with external data (MemberData/ClassData) are discovered and run.
- [ ] **Environment**
    - [ ] Works with `dotnet` on PATH.
    - [ ] Gracefully handles missing .NET SDK.

## 6. Technical Validation
**Goal:** Verify the extension's internal architecture, protocols, and resource management.

### Build Verification
- [ ] **TypeScript Compilation**
    - [ ] Run `npm run compile` in `extension/` directory - completes with no errors.
    - [ ] Verify `out/` folder contains all compiled JS files.
- [ ] **Worker .NET Build**
    - [ ] Run `dotnet build -c Release` in `worker/TestExplorer.Worker/` - completes successfully.
    - [ ] Verify `bin/Release/net8.0/` contains `TestExplorer.Worker.dll`.
- [ ] **Dependency Check**
    - [ ] Run `npm install` in `extension/` - no missing packages.
    - [ ] Worker `.csproj` restores all NuGet packages without errors.
- [ ] **Package Creation**
    - [ ] Run `vsce package` in `extension/` directory.
    - [ ] Verify `.vsix` file is created successfully.
    - [ ] Extract `.vsix` (it's a zip) and verify worker binaries are bundled.

### Protocol Verification
- [ ] **Worker Startup**
    - [ ] Worker process launches and emits `{ "type": "ready" }` message within 5s of extension activation.
- [ ] **Discovery Request/Response**
    - [ ] Send discovery request to worker, verify valid NDJSON response with discovered tests.
    - [ ] Check response includes expected fields: `symbolId`, `displayName`, `codeFilePath`, `lineNumber`.
- [ ] **NDJSON Error Handling**
    - [ ] Manually inject malformed JSON line into worker output stream (via test harness or mock).
    - [ ] Verify extension logs the error but continues processing subsequent lines.
- [ ] **Worker Cleanup**
    - [ ] Deactivate extension (reload window or disable).
    - [ ] Verify worker process terminates (check Task Manager or `ps` for `TestExplorer.Worker`).
    - [ ] No zombie processes remain after multiple activation/deactivation cycles.

### File System Verification
- [ ] **TRX File Lifecycle**
    - [ ] Run tests and verify `.trx` file is created in temp directory.
    - [ ] After test run completes, verify `.trx` file is deleted or temp folder is cleaned up.
    - [ ] Run 10+ test sessions and verify temp directory doesn't accumulate old `.trx` files.
- [ ] **Worker Binary Bundling**
    - [ ] Install packaged `.vsix` extension in clean VS Code instance.
    - [ ] Verify worker binaries load from extension install directory (not requiring separate dotnet project build).
    - [ ] Check extension log for correct resolved worker path.

### Performance Checks
- [ ] **Discovery Performance**
    - [ ] Open workspace with ~50 test projects (or scale to available test suite).
    - [ ] Measure time from workspace open to test tree fully populated.
    - [ ] Verify completes in < 10s (acceptable for MVP with solution of this size).
- [ ] **Execution Responsiveness**
    - [ ] Click "Run" on a single test.
    - [ ] Measure time from click to first test status update (running spinner).
    - [ ] Verify delay is < 2s.
- [ ] **Memory Usage**
    - [ ] Open extension, run all tests 5 times consecutively.
    - [ ] Check VS Code memory usage in Task Manager after each run.
    - [ ] Verify memory doesn't grow by > 100MB per run (no obvious leaks).
- [ ] **Worker Process Lifecycle**
    - [ ] After running tests, wait 5 minutes idle.
    - [ ] Verify worker process terminates or stays within reasonable memory bounds (< 50MB idle).
    - [ ] Deactivate extension and verify worker terminates completely.

### Error Handling Verification
- [ ] **Worker Crash Detection**
    - [ ] Kill worker process manually during test run (via Task Manager or `kill` command).
    - [ ] Verify extension detects crash and shows error message to user.
    - [ ] Verify extension can recover (retry or manual refresh works).
- [ ] **Invalid TRX Parsing**
    - [ ] Create a malformed `.trx` file (invalid XML or missing required elements).
    - [ ] Trigger parsing by running tests that produce this file (or mock the scenario).
    - [ ] Verify extension logs the error but doesn't crash - test results show "unknown" or graceful fallback.
- [ ] **Missing dotnet CLI**
    - [ ] Temporarily remove `dotnet` from PATH or rename the executable.
    - [ ] Attempt to run tests.
    - [ ] Verify extension shows actionable error: "dotnet CLI not found. Install .NET SDK from..." with link.
- [ ] **Missing C# Extension**
    - [ ] Uninstall C# DevKit or base C# extension.
    - [ ] Click "Debug" on a test.
    - [ ] Verify extension shows warning: "C# extension required for debugging. Install from..."
    - [ ] Verify "Run" still works (debug is optional dependency).

### Cross-platform Checks (Windows-focused MVP)
- [ ] **Worker Path Resolution**
    - [ ] On Windows: Verify worker path uses backslashes or normalized separators.
    - [ ] Verify no hardcoded Unix paths (forward slashes) break worker launch.
- [ ] **Process Spawning**
    - [ ] Verify worker process spawns with correct encoding (UTF-8).
    - [ ] Check dotnet CLI output with non-ASCII characters (if applicable) doesn't cause parsing errors.
- [ ] **File Path Separators**
    - [ ] Test with workspace folder containing spaces: `C:\My Tests\Project\`.
    - [ ] Verify discovery and execution handle paths correctly (no truncation at space).
    - [ ] Check TRX paths and source file paths resolve correctly.

## 7. Acceptance Criteria (Definition of Done)

### Must-Haves (Blockers)
1.  [ ] Accurate Test Discovery for standard xUnit/NUnit/MSTest projects.
2.  [ ] Reliable "Run" and "Debug" for individual tests and classes.
3.  [ ] Pass/Fail status correctly mapped back to UI.
4.  [ ] Navigation to source code works when clicking a test in the explorer.

### Known Limitations (Acceptable for MVP)
-   *Dynamic Discovery:* New tests might require a build or manual refresh to appear (vs live coding).
-   *Output:* Advanced logging might be routed to a generic Output channel rather than per-test specific standard out streams if granular isolation isn't finished.
-   *Coverage:* Code coverage visualization is out of scope for MVP.
