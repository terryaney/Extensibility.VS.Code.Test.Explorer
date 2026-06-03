# Console Output in Run vs Debug Mode

How `Console.WriteLine` (and `Debug`/`Trace`) output reaches the **Test Results** pane,
why it currently appears only when **debugging**, and the options for surfacing it during a
normal **run**.

## TL;DR

| Goal | Mechanism | Code change needed | Attribution |
| --- | --- | --- | --- |
| Per-test output in run mode | `[assembly: Xunit.CaptureConsole]` | None — TRX plumbing already exists | Attached to the specific test |
| As-it-comes dump in run mode (incl. fixtures) | Run the xUnit v3 `.exe` directly (mirror the debug path) | Moderate refactor | Unattributed, execution order |

The two approaches are **complementary**, not either/or.

---

## Why output shows in debug but not run today

The run and debug paths capture output through completely different mechanisms.

### Debug — direct `.exe`, raw stdout

For xUnit v3 projects the debug handler spawns the test **`.exe` directly** and pipes its raw
stdout/stderr into the pane, line by line:

- [`debugHandler.ts:740-741`](../extension/src/testing/debugHandler.ts#L740-L741)
  — `run.appendOutput(userLines.join('\r\n') + '\r\n')` (no `testItem` argument).

`Console.WriteLine` is simply that process's stdout, so it flows through verbatim. Framework
result lines (`[PASS]`/`[FAIL]`) and the execution summary are filtered out; everything else —
including test, constructor, and **fixture** output — passes through.

Because `appendOutput` is called **without** a `testItem`, the text is **not associated with any
test**. It just lands in the pane in execution order.

### Run — `dotnet test` + TRX

The run handler uses `dotnet test --logger trx` and **deliberately suppresses** the raw process
stdout from the pane — it is buffered to the output channel and only dumped to the Test Results
pane if the build fails:

- [`dotnetTestRunner.ts:59-93`](../extension/src/dotnet/dotnetTestRunner.ts#L59-L93)

Per-test results instead come from parsing the TRX file. The **only** way text reaches a test
item in run mode is via the TRX's per-test `<Output><StdOut>` element.

> **Key fact:** that `<Output><StdOut>` element contains only what xUnit captured *per test* —
> i.e. output written via `ITestOutputHelper`. Raw `Console.WriteLine` is **not** captured into it
> by default. That single gap is why console output is missing during a run.

---

## What `CaptureConsole` supports out of the box

[xUnit v3 introduced](https://xunit.net/docs/getting-started/v3/whats-new#capturing-console-debug-and-trace-output)
two assembly-level attributes:

```csharp
[assembly: Xunit.CaptureConsole]   // captures Console.Out / Console.Error
[assembly: Xunit.CaptureTrace]     // captures Debug / Trace output (Debug only in Debug builds)
```

- **Disabled by default** for backward compatibility — you must opt in.
- `CaptureConsole` exposes `CaptureOutput` and `CaptureError` properties (both on by default).
- Captured output is redirected **"as though you had written it via `ITestOutputHelper`."**

That last point is what makes it useful here. The capture lands in the per-test output, which
xUnit writes into the TRX `<Output><StdOut>` element — and your extension **already** reads and
displays that:

- Parser extracts it: [`trxParser.ts:114-119`](../extension/src/results/trxParser.ts#L114-L119)
- Mapper appends it to the pane, **attributed to the test item**:
  [`resultMapper.ts:127`](../extension/src/results/resultMapper.ts#L127),
  [`resultMapper.ts:136`](../extension/src/results/resultMapper.ts#L136)

### Enabling it

Add one line to the test project (e.g. an `AssemblyInfo.cs` or any source file):

```csharp
[assembly: Xunit.CaptureConsole]
// optionally, for Debug/Trace output in Debug builds:
[assembly: Xunit.CaptureTrace]
```

Run a test and the output appears under it in the pane. **No extension rebuild required.**

### Where `CaptureConsole` works — and where it doesn't

`CaptureConsole` routes output to the **currently-executing test** via an async-local writer.

| Source | Captured? | Why |
| --- | --- | --- |
| `Console.WriteLine` inside a test method | ✅ Yes | Runs in that test's context |
| `Console.WriteLine` inside the test **class constructor** | ✅ Yes | A new instance is created per test, in that test's context |
| `IClassFixture` / `ICollectionFixture` constructors | ❌ No | Constructed once, outside any single test's context |
| Assembly fixtures | ❌ No | Same — no ambient "current test" |
| Background threads with no ambient test | ❌ No | Async-local context doesn't flow there |

So if your **fixtures** do `Console.WriteLine`, that output still won't appear in run mode with
`CaptureConsole` alone — even though it *does* appear in debug, because debug forwards raw process
stdout indiscriminately.

---

## Surfacing fixture / as-it-comes output in run mode

To get the same unattributed, "dump as it comes" behavior that debug already has — including
fixture and background output — the run path must read the process's **raw stdout**, which means
running the test **`.exe` directly** rather than via `dotnet test`.

### Why not just forward `dotnet test` stdout?

The obvious minimal change — forwarding `onStdout`/`onStderr` in
[`dotnetTestRunner.ts:64-72`](../extension/src/dotnet/dotnetTestRunner.ts#L64-L72) to
`run.appendOutput` — does **not** work as desired:

- `Console.WriteLine` from tests generally **does not surface** on `dotnet test`'s stdout — the
  VSTest host captures it.
- You would instead dump build/restore/MSBuild noise into the pane (the very reason it is
  suppressed today) and *still* not reliably see fixture output.

The reason output works in debug is **not** `dotnet test` — it's the **direct `.exe` spawn**.

### Recommended approach: reuse the debug path's direct-exe streaming

Everything required already exists in the debug handler. `waitForXunitV3Ready` /
`runXunitV3DirectSession` already:

- spawn the v3 `.exe` and stream **filtered** stdout to the pane (framework `[PASS]`/`[FAIL]`
  lines and summaries suppressed, user `Console.WriteLine` passed through),
- write a TRX via `-trx` for accurate per-test results,
- parse it through the existing `applyTestResults`.

The **only** debug-specific bits are `-waitForDebugger`, the debugger attach, and waiting for the
session to end. Strip those and you have a run-mode direct execution that behaves identically to
debug for console output.

Concrete steps:

1. **Extract a shared helper** — e.g. `runXunitV3Direct(exePath, tests, { waitForDebugger }, …)` —
   from the existing `waitForXunitV3Ready` spawn logic. Debug passes `waitForDebugger: true` and
   attaches; run passes `false` and streams to completion.
2. **In the run handler**, for xUnit v3 projects, do what debug already does: `dotnet build`
   first, locate the `.exe` ([`debugHandler.ts:104-109`](../extension/src/testing/debugHandler.ts#L104-L109)),
   then spawn it directly with `-trx` + the filter args instead of going through `runDotnetTest`.
3. **Non-v3 projects keep `dotnet test`.** There is no standalone `.exe`, so raw forwarding isn't
   possible there — the same v3-only limitation debug already has.

### Trade-offs to accept

- **Run mode would build first, then run** (two steps) instead of `dotnet test`'s combined
  build-and-run. This already matches the debug pattern.
- **v3-only feature.** v2 / VSTest-only projects won't get streamed console output in run,
  mirroring debug.
- Output **interleaves in execution order** across all selected tests — as it comes, unattributed.

---

## Recommendation

The two features are complementary:

- Keep **`[assembly: CaptureConsole]`** for clean, **per-test-attributed** output via the TRX
  (test methods + constructors, zero code change).
- Add the **direct-`.exe` run path** for the unattributed, as-it-comes dump that also catches
  **fixture / background** output.

With both, run mode reaches parity with debug — and then some.

---

## Reference: relevant source locations

| Concern | File |
| --- | --- |
| Debug: direct-exe spawn + filtered stdout streaming | [`debugHandler.ts` `waitForXunitV3Ready`](../extension/src/testing/debugHandler.ts#L627-L780) |
| Debug: unattributed `appendOutput` | [`debugHandler.ts:740-741`](../extension/src/testing/debugHandler.ts#L740-L741) |
| Debug: xUnit v3 detection (`.exe` presence) | [`debugHandler.ts:104-109`](../extension/src/testing/debugHandler.ts#L104-L109) |
| Run: `dotnet test` + suppressed raw stdout | [`dotnetTestRunner.ts:59-93`](../extension/src/dotnet/dotnetTestRunner.ts#L59-L93) |
| TRX per-test `<Output><StdOut>` extraction | [`trxParser.ts:114-119`](../extension/src/results/trxParser.ts#L114-L119) |
| Per-test output written to pane (attributed) | [`resultMapper.ts:127`](../extension/src/results/resultMapper.ts#L127), [`resultMapper.ts:136`](../extension/src/results/resultMapper.ts#L136) |
