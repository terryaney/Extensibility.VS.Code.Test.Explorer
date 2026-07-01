# Handoff: KAT C# Test Explorer — Theory Case Sync & TRX Fix

**Date:** 2026-07-01  
**Branch:** main  
**Repo:** `c:\BTR\Camelot\Extensibility\VS.Code.Test.Explorer`

---

## Context

This is a VS Code extension that runs xUnit tests against .NET projects. It uses a .NET worker process for test discovery and a TRX-based result pipeline for reporting. The primary pain point driving this session was **theory (parameterised) test cases not staying in sync** between what is in the VS Code test tree and what actually ran.

---

## What Was Done / Fixed

### 1. TRX parser: quote-escaping bug (`trxParser.ts`)

`fast-xml-parser` escapes `"` as `\"` when the XML attribute is single-quoted. xUnit v3 TRX files use single-quoted `testName` attributes, so display names containing `"` (e.g., theory case parameters) came through escaped and never matched metadata. Fix: unescape `\\"` → `"` after parse.

**File:** `extension/src/results/trxParser.ts` — line ~91

### 2. `applyTestResults` signature refactored (`resultMapper.ts`)

The function used to accept an optional `expectedItems` list and internally mark unmatched items as `skipped`. This was removed in favour of a richer return type:

```ts
interface ApplyTestResultsResult {
    summary: TestRunSummary;
    unmatchedResults: TrxTestResult[];  // TRX results with no tree node
    hadRemovals: boolean;               // tree had case nodes with no TRX result
}
```

`markMissingExpectedResultsAsSkipped` and `collectRunnableItems` were deleted. All callers (`runHandler`, `coverageHandler`, `debugHandler`) updated to destructure the new return.

**Fragile note:** The `hadRemovals` heuristic compares `orderedCasesByFqn[fqn].length` (tree case count) against `resultsByFqn[fqn].length` (TRX result count). This is per-FQN, so it catches removal correctly only when the FQN matches. If discovery was never run (tree is empty), `orderedCasesByFqn` will be empty and `hadRemovals` will always be false — that case is handled by `unmatchedResults` instead.

### 3. `syncTree` added to `runHandler.ts`

After applying results, if `unmatchedResults.length > 0` OR `hadRemovals`, `runHandler` calls a new `syncTree()` helper that:
1. Re-runs worker discovery for the project.
2. Calls the injected `mergeProject` callback (wired to `mergeProjectResults` in `controller.ts`).
3. If there were unmatched results (additions), calls `applyTestResults` again with just those results so they land on the newly merged nodes.

**Intertwined / fragile area:** `syncTree` runs discovery mid-run while `run` is still open. If the VS Code test run is cancelled between the first `applyTestResults` call and the re-apply, unmatched results are silently dropped. No cancellation token is threaded through `syncTree`.

### 4. `mergeProject` callback injected into `runHandler`

`createRunHandler` gained a fourth parameter `mergeProject: (project: TestProjectDto) => void` so it can call `mergeProjectResults` without importing `controller.ts` (avoiding a circular dep). `createTestController` in `controller.ts` wires it:

```ts
const runHandler = createRunHandler(
    controller, workerClient, outputChannel,
    (project) => mergeProjectResults(controller, project)
);
```

### 5. `getKnownProjectPaths` exported from `controller.ts`

New helper that walks `controller.items` and returns `.csproj` paths (root item IDs), filtering out `diagnostic:` sentinel items. Used by `extension.ts` to pass projects to `buildProjects`.

### 6. `buildProjects` added to `dotnetTestRunner.ts`

New exported function that runs `dotnet build` on each .csproj before discovery (invoked from the "Build, Refresh Tests" command). Build failures show a warning but do not abort discovery. The "Refresh Tests" command title was renamed to "Build, Refresh Tests" in `package.json`.

### 7. Enqueue simplification (`coverageHandler.ts`, `runHandler.ts`)

`markProjectTests(run, item, 'enqueued')` and `enqueueSelectedLeafRunnableItems` were deleted; all callsites replaced with `run.enqueued(item)`. VS Code propagates enqueued state to children automatically — the manual tree-walking was redundant.

---

## What Was Tried and Rolled Back

### `markMissingExpectedResultsAsSkipped` approach

The original intent was: pass the expected test items into `applyTestResults` so items that had no TRX result could be marked `skipped`. This was brittle because:
- It required a caller-visible concept of "expected items" that drifted from the actual tree.
- For theory cases, the expected-item list and the TRX results were both positional, leading to mis-matches when theory parameters changed mid-run.
- The "skipped" marking happened inside the mapper, making it impossible for callers to distinguish "legitimately skipped" from "tree is stale."

Rolled back entirely in favour of the `unmatchedResults` / `hadRemovals` approach above, which lets the caller decide whether to sync-and-retry or simply surface the discrepancy.

---

## Current Unstaged / Uncommitted State

All changes above are **unstaged working-tree changes** (no new commit yet). Key files:

| File | Status |
|---|---|
| `extension/package.json` | Modified (command title) |
| `extension/src/dotnet/dotnetTestRunner.ts` | Modified (buildProjects added) |
| `extension/src/extension.ts` | Modified (buildProjects wired to refresh command) |
| `extension/src/results/resultMapper.ts` | Modified (new return type, removed skip logic) |
| `extension/src/results/trxParser.ts` | Modified (quote unescape) |
| `extension/src/testing/controller.ts` | Modified (getKnownProjectPaths, mergeProject callback) |
| `extension/src/testing/coverageHandler.ts` | Modified (enqueue simplification) |
| `extension/src/testing/debugHandler.ts` | Modified (applyTestResults caller updated) |
| `extension/src/testing/runHandler.ts` | Modified (syncTree, mergeProject param, enqueue simplification) |

---

## Open TypeScript Errors (pre-existing, non-blocking)

### `vscode.debug.sessions` — undocumented API (`debugHandler.ts:285`, `debugHandler.ts:581`)

```
TS2339: Property 'sessions' does not exist on type 'typeof debug'.
TS7006: Parameter 's' implicitly has an 'any' type.
```

Both occurrences use the same pattern to find-and-stop a named debug session on cancellation:

```ts
const sessionToStop = vscode.debug.sessions.find(s => s.name === SESSION_NAME);
if (sessionToStop) { vscode.debug.stopDebugging(sessionToStop); }
```

**Why it still runs:** The extension is bundled via esbuild (not raw `tsc`), so type errors don't block compilation. `vscode.debug.sessions` also exists on the runtime VS Code object — it is a proposed/undocumented API not present in `@types/vscode`, so the code works at runtime but fails the type check.

**Easy fix** — cast to silence the error, no logic change:
```ts
const sessionToStop = (vscode.debug as any).sessions?.find((s: vscode.DebugSession) => s.name === SESSION_NAME);
```

**Best fix** — use only stable public API; capture the session when it starts:
```ts
let debugSession: vscode.DebugSession | undefined;
const startDisposable = vscode.debug.onDidStartDebugSession(s => {
    if (s.name === SESSION_NAME) debugSession = s;
});

token.onCancellationRequested(() => {
    vscode.debug.stopDebugging(debugSession);
    startDisposable.dispose();
    disposable.dispose();
    resolve();
});
```

`onDidStartDebugSession` is already used nearby for session-end detection, so this follows the existing pattern and removes the undocumented dependency.

---

## Known Fragile / Intertwined Areas

1. **`syncTree` runs discovery mid-open-run** — no cancellation token; dropped results if user cancels between apply passes.
2. **`hadRemovals` heuristic** — depends on `orderedCasesByFqn` being populated (requires prior discovery). Cold-start won't trigger removal path.
3. **`getKnownProjectPaths` uses item ID as .csproj path** — implicit convention between `controller.ts` and `extension.ts`; if root item IDs ever change shape, this silently returns wrong paths.
4. **`mergeProject` callback closure** — captures `controller` at activation time; if the controller is replaced (e.g., extension reactivation), the closure will hold a stale reference.
5. **TRX quote unescape** — only unescapes `\\"` → `"`. Other XML escape forms (`&amp;`, `&quot;`, etc.) are handled by `fast-xml-parser` itself, but if the parser's escaping behavior changes across versions, this fix may need revisiting.

---

## Suggested Next Steps

- If user confirms, commit the working-tree changes with a descriptive message covering the TRX fix, syncTree, and enqueue cleanup.
- Thread a `CancellationToken` through `syncTree` and abort the re-apply if cancelled.
- Add an integration test: run a theory test, mutate the parameters, re-run — verify `syncTree` fires and the new cases appear.
- Ask user whether `buildProjects` should also be called on initial (auto) discovery, not just manual refresh.

---

## Suggested Skills

- `/code-review` — review the `runHandler.ts` `syncTree` implementation for correctness (especially the mid-run re-discovery race and summary merging).
- `/simplify` — the `runHandler.ts` "all tests" and "filtered tests" branches share nearly identical TRX parse/apply/sync blocks; worth extracting a shared helper.
- `/verify` — run the extension against a real xUnit v3 project with theory tests to confirm the TRX unescape fix and syncTree both fire correctly.

## Current Known Issues with Code

1. Before, selecting node in test tree and run/debug, that node and all children nodes' icon changed to 'running'.  Now, only the current node does.  Something is wrong in current unstaged changes.

2. Opened a project that had 4 theory tests, added 2 more and saved project.  Ran Test.  Seemed to run all 6, display them in tree and results pane (good) but there is one more 'skipped' item in the pane listing.  It has the 6 'member data' theories listed (good) but then one more of 'just the method' and shows skipped.  The node shouldn't be there and it shouldn't be skipped.

3. I want to implment the Open TypeScript Errors mentioned above.

4. I want to discuss what is the proper workflow - and what we can support - for test and/or theory changes.
- When are they detected and added to tree?
- Do I *need* to do a build?  What is 'fastest' discovery path?
- Currently have a 'Build, Refresh Tests' command.  Should we have a 'Refresh Tests' command that does not build as well?  Should we just remove the current 'build' from the refresh and document that user needs to build?  Maybe instead add a prompt when clicking that asking if they want to build first?
- Output an additional line in the test result details at the end stating what a user has to do to get 'everything in sync'?
- What happens if I don't run a test, but add new test case and immediately send to CI/CD which simply does 'build' and the 'test' (via cli obviously) - will new/removed tests function properly?
- I'm just having a hard time getting new tests to run/showup, removed tests to 'not run' (and not report skipped) and removed from tree - seems like I'm going thru too many hoops 'as a user in a integration test project' to get things to behave.  This is the ultimate goal of entire issue right now and I just want to get it working, stable, and predictable for the user.