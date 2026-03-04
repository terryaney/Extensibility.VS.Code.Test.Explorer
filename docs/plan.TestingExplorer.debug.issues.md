# Debug Issues Log — KAT C# Test Explorer

Tracks all investigation and fix attempts for the debugging subsystem (`debugHandler.ts`).

**Issue 2: Debug — breakpoints and spurious exception stops**
**Status**: Largely resolved. See below for full history.

- xUnit v3 breakpoints: **working** (direct `.exe -waitForDebugger` runner, attach by processName)
- xUnit v2 breakpoints: **working** (VSTest + `VSTEST_DEBUG_NOBP=1`, attach by PID)
- `MissingMethodException` spurious stop: **resolved** via DAP tracker injecting `MissingMethodException → never` into `setExceptionBreakpoints` (Attempt 13). DAP protocol does not support assembly-scoped filtering — type-level suppression is the best available.

---

## Architecture (Current State)

### xUnit v3 — Direct EXE Runner
- Detect v3: `dotnet msbuild -getProperty:TargetPath -p:Configuration=Debug` returns `.dll`; swap to `.exe` and check existence.
- Spawn: `<project>.exe -waitForDebugger [-method <fqn>]`
- Wait for: stdout line containing `"Waiting for debugger to be attached"`
- Attach: `coreclr` attach by `processName` (exe basename without extension)
- No `stopped` event, no `Debugger.Break()`, no auto-continue needed. Process polls `Debugger.IsAttached`, continues naturally. Pending breakpoints bind on module load.

### xUnit v2 — VSTest Fallback
- Spawn: `dotnet test <project> VSTEST_HOST_DEBUG=1 VSTEST_DEBUG_NOBP=1`
- Wait for: stdout line matching `"Process Id: \d+"`, extract PID
- Attach: `coreclr` attach by `processId`
- `VSTEST_DEBUG_NOBP=1` suppresses `Debugger.Break()` stop so the initial stop doesn't fire.

### Shared Attach Config
```typescript
{
    type: 'coreclr',
    request: 'attach',
    justMyCode: true,
    requireExactSource: false,
    suppressJITOptimizations: true
}
```

### Superseded attempt summaries (kept for reference):

**Attempt 7**: Root cause — `VSTEST_DEBUG_NOBP=1` suppresses `Debugger.Break()` → no `stopped` event → auto-continue dead. Fixed by removing NOBP for initial attach.
**Attempt 8**: `requireExactSource:true` (VS Code default) rejecting breakpoints. Fixed with `requireExactSource: false`, `suppressJITOptimizations: true`.
**Attempt 9**: xUnit v3 direct `.exe` runner (bypass VSTest/testhost entirely). Fixes v3 breakpoints.
**Attempt 10**: Restore `VSTEST_DEBUG_NOBP=1` for v2/VSTest path. Fixes v2 Debugger.Break unwanted stop.
**Attempt 11–12**: `justMyCode: true` and `exceptionOptions` in attach config — both ineffective for suppressing MissingMethodException against global "break on all exceptions."
**Attempt 13**: DAP tracker intercepts `setExceptionBreakpoints`, injects `MissingMethodException → never`. Confirmed working.

---

## MissingMethodException on v2 — RESOLVED (Attempt 13)

**Symptom**: When user has "break on all exceptions" globally enabled, a spurious stop fires:
```
Exception has occurred: CLR/System.MissingMethodException
'Constructor on type 'Xunit.Sdk.InlineDataDiscoverer' not found.'
  at Xunit.Sdk.ExtensibilityPointFactory.CreateInstance(...)
```

**Root cause**: xUnit v2/v3 SDK version mismatch in the VSTest adapter initializer. The exception is thrown and caught entirely inside the xUnit adapter — it is harmless. But the user's global "break on all exceptions" causes vsdbg to stop at throw site regardless.

**Dev Kit comparison**: Dev Kit doesn't hit this because its v2 debug path uses a custom out-of-process test server (`waitForDebuggerAttachComplete` handshake) — closed source, can't inspect the attach config it uses.

---

## Fix Attempts for MissingMethodException (resolved at Attempt 13)

### Attempt 11 — `justMyCode: true`
- **What**: Changed `justMyCode: false` → `true` hoping vsdbg classifies xUnit adapter as non-user code and skips exception stops within it.
- **Result**: No change. `justMyCode` doesn't suppress "All Exceptions" breakpoints — those override it. vsdbg stops at throw site even in non-user code when "All Exceptions" is active.

### Attempt 12 — `exceptionOptions` in attach config
- **What**: Added to attach config:
  ```typescript
  exceptionOptions: [
      {
          path: [{ names: ['CLR'] }, { names: ['System.MissingMethodException'] }],
          breakMode: 'never'
      }
  ]
  ```
- **Result**: No change. VS Code sends `setExceptionBreakpoints` after attach based on the user's global exception settings, which overwrites whatever was set in the attach config. The `exceptionOptions` field in the config is not respected.

### Attempt 13 — DAP tracker intercepts `setExceptionBreakpoints` ✅ CONFIRMED WORKING
- **What**: Register a `DebugAdapterTrackerFactory` scoped to the session name before calling `startDebugging`. In `onWillReceiveMessage`, intercept `setExceptionBreakpoints` commands and inject `System.MissingMethodException → never` into `exceptionOptions` before they reach vsdbg.
  ```typescript
  onWillReceiveMessage(message: any) {
      if (message.command !== 'setExceptionBreakpoints') { return; }
      const opts = message.arguments?.exceptionOptions ?? [];
      opts.push({
          path: [{ names: ['CLR'] }, { names: ['System.MissingMethodException'] }],
          breakMode: 'never'
      });
      message.arguments.exceptionOptions = opts;
  }
  ```
- **Result**: Confirmed working. Spurious stop eliminated. User breakpoints still hit. Output channel logs `DAP → setExceptionBreakpoints (patched MissingMethodException → never)` to confirm the intercept fired.
- **Note**: DAP protocol does not support assembly/module-scoped exception filtering — only type-name hierarchy. The suppression covers all `System.MissingMethodException` throws, not just those from the xUnit adapter. This is acceptable given how rare a legitimate `MissingMethodException` in user code would be.

---

## Prior Debug Breakpoint Attempts (resolved — breakpoints now work)

### Attempt 1 — `--no-build` basic attach
- Ran against stale Release build (no debug symbols). Breakpoints silently skipped.

### Attempt 2 — `--configuration Debug` without pre-build
- `dotnet test` triggered full solution build, consuming the testhost 30-second attach timeout. Result: "Could not find testhost process to attach to."

### Attempt 3 — Pre-build + `justMyCode: true`
- Explicit `dotnet build --configuration Debug` before `dotnet test --no-build`. Test ran to completion without hitting breakpoint. Fixed 1500ms auto-continue fired before VS Code bound breakpoints to loaded assembly.

### Attempt 4 — Fixed-delay auto-continue (1500ms)
- DAP tracker watching for `stopped` event, then `setTimeout(1500)` before `continue`. `stopped` fires before test assembly loads — 1500ms wasn't enough for symbol binding.

### Attempt 5 — Module-load trigger
- Watched for `module` events; waited for test assembly DLL name, then continued after 200ms. Module events for already-loaded DLLs fire during DAP init phase BEFORE the `stopped` event, so the assembly was seen and dismissed. 10s fallback fired after tests had already timed out.

### Attempt 6 — `VSTEST_DEBUG_NOBP=1` + `configurationDone` signal
- Added `VSTEST_DEBUG_NOBP=1` (suppresses `Debugger.Break()`). `configurationDone` never arrived or fallback fired late. No stop, no bind. Self-defeating — NOBP prevents the `stopped` event that the whole mechanism depended on.

### Attempt 7 — Root cause: `VSTEST_DEBUG_NOBP=1` kills `stopped` event
- Identified that `NOBP=1` suppresses `Debugger.Break()` → no `stopped` event → `stoppedThreadId` never set → auto-continue permanently dead.
- Fixed: removed `NOBP=1`. Also fixed session name uniqueness (added PID) and cancellation fallback.

### Attempt 8 — `requireExactSource: false` + `suppressJITOptimizations: true`
- DAP logs showed `requireExactSource: true` (VS Code default) causing vsdbg to reject breakpoints after `configurationDone` with "No symbols have been loaded for this document" even when the DLL loaded with symbols.
- Fixed: explicit `requireExactSource: false`, `suppressJITOptimizations: true` in attach config.

### Attempt 9 — xUnit v3 direct EXE runner (resolved v3)
- Identified that xUnit v3 produces a self-contained `.exe` apphost. Running via VSTest routes through `testhost.exe` where the `Debugger.Break()` behavior differs and breakpoints never bind.
- Fix: Detect v3 by checking for `.exe` alongside the MSBuild TargetPath `.dll`. Run `.exe -waitForDebugger [-method <fqn>]` directly. Attach by `processName`. No DAP tracker or auto-continue needed.
- Sub-bug: `getProperty:TargetPath` returns `.dll` not `.exe`. Fixed by replacing extension.
- Sub-bug: xUnit v3 `-waitForDebugger` prints `"Waiting for debugger to be attached..."` not a PID. Fixed by attaching by `processName` (exe basename without extension) after detecting the ready string.

### Attempt 10 — Restore `VSTEST_DEBUG_NOBP=1` for v2 path (resolved v2)
- With v3 on its own path, `NOBP=1` is safe for the v2/VSTest fallback. Restoring it suppressed the `Debugger.Break()` stop in `DebuggerBreakpoint.cs`.
- v2 breakpoints confirmed working.
- Remaining issue: `MissingMethodException` in xUnit adapter (see above).

---

## Sources Consulted
- VSTest environment variables: https://github.com/microsoft/vstest/blob/main/docs/environment-variables.md
- VSTest diagnose docs: https://github.com/microsoft/vstest/blob/main/docs/diagnose.md
- VSTest `DebuggerBreakpoint.cs`: https://github.com/microsoft/vstest/blob/main/src/Microsoft.TestPlatform.Execution.Shared/DebuggerBreakpoint.cs
- DAP specification (configurationDone, module events): https://github.com/microsoft/debug-adapter-protocol/blob/main/specification.md
- VS Code Testing API docs: https://code.visualstudio.com/api/extension-guides/testing
