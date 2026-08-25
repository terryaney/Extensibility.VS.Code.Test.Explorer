import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { WorkerClient } from '../worker/workerClient';
import { buildVSTestFilter, shouldRunAll } from './filterBuilder';
import { getProjectPath, getTestMetadata, isLeafRunnableItem } from './testItemStore';
import { parseTrxFile } from '../results/trxParser';
import { applyTestResults, appendCaseData, buildTheoryDataBlock, TestRunSummary } from '../results/resultMapper';
import { findTrxFile } from '../dotnet/dotnetTestRunner';

export function createDebugHandler(
    controller: vscode.TestController,
    workerClient: WorkerClient,
    outputChannel: vscode.OutputChannel
): (request: vscode.TestRunRequest, token: vscode.CancellationToken) => Promise<void> {

    return async (request: vscode.TestRunRequest, token: vscode.CancellationToken) => {
        const run = controller.createTestRun(request);
        const resultsDirectory = path.join(os.tmpdir(), `test-debug-${uuidv4()}`);

        try {
            const csharpExt = vscode.extensions.getExtension('ms-dotnettools.csharp');
            if (!csharpExt) {
                vscode.window.showErrorMessage('C# extension (ms-dotnettools.csharp) is required for debugging.');
                return;
            }

            if (!fs.existsSync(resultsDirectory)) {
                fs.mkdirSync(resultsDirectory, { recursive: true });
            }

            const testsToDebug = request.include ?? getAllTests(controller);
            const testsByProject = groupTestsByProject(testsToDebug);

            for (const [projectPath, tests] of Array.from(testsByProject.entries())) {
                if (token.isCancellationRequested) { break; }
                const projectStartMs = Date.now();

                for (const test of tests) {
                    enqueueSelectedLeafRunnableItems(run, test);
                }

                // Build first so it doesn't eat into the debugger-attach window.
                // Also capture the target DLL path from the build output ("ProjectName -> /path/foo.dll")
                // to avoid a redundant MSBuild invocation afterwards.
                run.appendOutput(`\r\nBuilding ${path.basename(projectPath)}...\r\n`);
                outputChannel.appendLine(`Building: dotnet build ${projectPath} --configuration Debug`);
                const projectName = path.basename(projectPath, '.csproj');
                const buildOutputTargetRe = new RegExp(
                    `\\b${projectName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b\\s+->\\s+(.+\\.dll)`,
                    'i'
                );
                let targetPathFromBuild: string | undefined;
                const buildBufferedLines: string[] = [];
                const buildResult = await new Promise<number>((resolve) => {
                    const buildProc = spawn('dotnet', ['build', projectPath, '--configuration', 'Debug'], {
                        cwd: path.dirname(projectPath),
                        shell: true
                    });
                    const cancelListener = token.onCancellationRequested(() => {
                        if (buildProc.pid) {
                            spawn('taskkill', ['/F', '/T', '/PID', String(buildProc.pid)], { shell: true });
                        }
                        resolve(1);
                    });
                    buildProc.stdout.on('data', (d: Buffer) => {
                        const text = d.toString();
                        outputChannel.append(text);
                        buildBufferedLines.push(text);
                        if (!targetPathFromBuild) {
                            const m = buildOutputTargetRe.exec(text);
                            if (m) { targetPathFromBuild = m[1].trim(); }
                        }
                    });
                    buildProc.stderr.on('data', (d: Buffer) => {
                        const text = d.toString();
                        outputChannel.append(text);
                        buildBufferedLines.push(text);
                    });
                    buildProc.on('close', (code) => { cancelListener.dispose(); resolve(code ?? 1); });
                    buildProc.on('error', () => { cancelListener.dispose(); resolve(1); });
                });

                run.appendOutput(`\r\nbuild exited with code ${buildResult}\r\n`);

                if (buildResult !== 0) {
                    run.appendOutput('\r\n');
                    for (const chunk of buildBufferedLines) {
                        run.appendOutput(chunk.replace(/\r?\n/g, '\r\n'));
                    }
                    const buildFailMsg = token.isCancellationRequested
                        ? 'Build cancelled'
                        : 'Build failed before debug run';
                    run.appendOutput(`\r\n❌ ${buildFailMsg}\r\n`);
                    for (const test of tests) {
                        markSelectedLeafRunnableItemsErrored(run, test, buildFailMsg);
                    }
                    continue;
                }

                // Determine whether this is an xUnit v3 project. MSBuild's TargetPath always returns
                // the managed .dll; the apphost .exe is generated alongside it for executable projects.
                // The .exe is required (v3 self-hosts its runner in the apphost) but is NOT sufficient
                // evidence on its own: any test project built with an Exe-producing SDK (notably
                // Microsoft.NET.Sdk.Web) emits an apphost even when the tests are xUnit v2, and that
                // apphost's auto-generated Main exits immediately - so the direct path would spawn it,
                // never see it become ready, and fail the whole run. Also require v3's own assemblies.
                const targetPath = targetPathFromBuild ?? await getProjectTargetPath(projectPath, outputChannel);
                const exePath = targetPath ? targetPath.replace(/\.dll$/i, '.exe') : undefined;
                const isXunitV3 = !!targetPath && !!exePath && fs.existsSync(exePath) && hasXunitV3Assemblies(targetPath, outputChannel);
                const directSelectionSupport = getXunitV3DirectSelectionSupport(tests);
                const useXunitV3Direct = isXunitV3 && directSelectionSupport.supported;
                outputChannel.appendLine(`Target path: ${targetPath ?? '(unknown)'} | exe: ${exePath ?? '(none)'} | xUnit v3: ${isXunitV3} | xUnit v3 direct: ${useXunitV3Direct} | selection routing: ${directSelectionSupport.reason}`);
                if (isXunitV3 && !directSelectionSupport.supported) {
                    outputChannel.appendLine(`Using VSTest fallback for precise debug selection: ${directSelectionSupport.reason}`);
                }

                run.appendOutput(`\r\n=== Debugging tests in ${path.basename(projectPath)} ===\r\n`);
                run.appendOutput(`\r\nStarting test runner... waiting for debugger attachment.\r\n`);

                let pid: number | undefined;
                let processName: string | undefined;

                if (useXunitV3Direct) {
                    // Theory cases are debugged in isolation via -id (resolved from -list discovery);
                    // breakpoints only bind on this direct path. The whole spawn/attach/parse sequence
                    // is run via a helper so it can be retried as a whole-theory debug when the -id
                    // values match nothing at execution (rows not stably addressable at runtime).
                    const caseIdMap = await resolveXunitV3CaseIds(exePath!, tests, outputChannel, token);
                    const trxPath = path.join(resultsDirectory, 'xunit-v3-debug.trx');
                    const result = await runXunitV3DirectSession(controller, exePath!, tests, caseIdMap, trxPath, run, outputChannel, token, projectStartMs);

                    if (!result.started) {
                        for (const test of tests) {
                            markSelectedLeafRunnableItemsErrored(run, test, 'xUnit v3 test runner did not start');
                        }
                    } else if (caseIdMap.size > 0 && result.executed === 0) {
                        // Safety net: the -id selection ran zero tests. Re-run the whole theory
                        // (empty id map → -method fallback) so the breakpoint is still reachable.
                        outputChannel.appendLine('xUnit v3 -id run executed 0 tests; retrying as whole-theory (-method)');
                        run.appendOutput('\r\n⚠️ Could not isolate the selected theory case at runtime; re-running the entire theory under the debugger (all data rows).\r\n');
                        const retry = await runXunitV3DirectSession(controller, exePath!, tests, new Map<string, string>(), trxPath, run, outputChannel, token, projectStartMs);
                        if (!retry.started) {
                            for (const test of tests) {
                                markSelectedLeafRunnableItemsErrored(run, test, 'xUnit v3 whole-theory fallback did not start');
                            }
                        }
                    }
                    continue;
                } else {
                    const logFilePrefix = `debug-run`;
                    const args = [
                        'test', projectPath,
                        '--logger', `trx;LogFilePrefix=${logFilePrefix}`,
                        '--results-directory', resultsDirectory,
                        '--configuration', 'Debug',
                        '--no-build'
                    ];
                    const debuggingAll = tests.length === 1 && shouldRunAll(tests[0]);
                    if (!debuggingAll) {
                        const filter = buildVSTestFilter(tests);
                        args.push('--filter', filter);
                        outputChannel.appendLine(`Debug filter: ${filter}`);
                    }
                    outputChannel.appendLine(`Spawning (VSTest): dotnet ${args.join(' ')}`);
                    pid = await waitForTesthostPid(args, projectPath, run, outputChannel, token);
                }

                if (!pid && !processName) {
                    outputChannel.appendLine('Could not find runner PID - debug attach failed');
                    for (const test of tests) {
                        markSelectedLeafRunnableItemsErrored(run, test, 'Could not find test runner process to attach to');
                    }
                    continue;
                }

                const attachTarget = processName ?? pid!;
                outputChannel.appendLine(`Attaching debugger to: ${attachTarget}`);
                run.appendOutput(`\r\nAttaching debugger to ${processName ? `process '${processName}'` : `PID ${pid}`}...\r\n`);

                const SESSION_NAME = `KAT C# Test Explorer: Attach (${attachTarget})`;

                const attachConfig: vscode.DebugConfiguration = {
                    type: 'coreclr',
                    name: SESSION_NAME,
                    request: 'attach',
                    ...(processName ? { processName } : { processId: pid }),
                    // Prefer user-code-focused debugging for both v2 and v3 paths.
                    justMyCode: true,
                    requireExactSource: false,
                    suppressJITOptimizations: true
                };

                let trackerReg: vscode.Disposable | undefined;
                if (!useXunitV3Direct) {
                    // For v2/VSTest sessions, avoid mutating setExceptionBreakpoints because
                    // adapter behavior can override Break on All Exceptions when exceptionOptions
                    // are injected. Instead, detect the known startup MissingMethodException stop
                    // and immediately continue.
                    trackerReg = vscode.debug.registerDebugAdapterTrackerFactory('coreclr', {
                        createDebugAdapterTracker(session: vscode.DebugSession): vscode.DebugAdapterTracker | undefined {
                            if (session.name !== SESSION_NAME) { return undefined; }
                            return {
                                onDidSendMessage(message: any) {
                                    if (message?.type !== 'event' || message.event !== 'stopped') { return; }
                                    const body = message.body ?? {};
                                    if (body.reason !== 'exception') { return; }

                                    const exceptionText = collectStringLeaves(body).join(' | ');

									// if (!/\bMissingMethodException\b/i.test(exceptionText)) { return; }
                                    // outputChannel.appendLine('DAP <- stopped(exception MissingMethodException) from v2 adapter startup; auto-continuing');

									/*
									GPT 5.3 Warning:
									Ignoring all exceptions thrown from System.Private.CoreLib.dll can hide real defects in my code path, because many 
									first-failure exceptions originate in BCL APIs before being wrapped by framework layers (for example xUnit 
									invokers/aggregators). By the time the error surfaces in user code, critical context about the original throw site 
									and exception type may be lost or transformed. This can delay root-cause analysis and make failures look like 
									test-framework issues instead of application bugs. Blanket suppression should therefore be avoided in favor of 
									narrowly targeted noise filtering.

									I had disagreed:
									I'm going against your advice.  
									
									1. Original ApplicationException thrown in test method.
									2. Next break was in Xunit.TestInvoker stating error was thrown in System.Private.CoreLib.dll
										protected virtual object CallTestMethod(object testClassInstance)
											=> TestMethod.Invoke(testClassInstance, TestMethodArguments);
									3. Next break was in Xunit.Executiontimer (on line await asyncAction()):
										public async Task AggregateAsync(Func<Task> asyncAction)
										{
											var stopwatch = Stopwatch.StartNew();
											try
											{
												await asyncAction();
											}
											finally
											{
												total += stopwatch.Elapsed;
											}
										}
									4. Final break was in Xunit.ExceptionAggregator (on line on await code()):
										public async Task RunAsync(Func<Task> code)
										{
											try
											{
												await code();
											}
											catch (Exception ex)
											{
												exceptions.Add(ex.Unwrap());
											}
										}
									*/
                                    if (!/\bSystem\.Private\.CoreLib\.dll\b/i.test(exceptionText)) { return; }

                                    outputChannel.appendLine('DAP <- stopped(exception from System.Private.CoreLib.dll) from v2 adapter startup; auto-continuing');
                                    void vscode.commands.executeCommand('workbench.action.debug.continue');
                                }
                            };
                        }
                    });
                }

                const started = await vscode.debug.startDebugging(undefined, attachConfig, { testRun: run });

                if (!started) {
                    trackerReg?.dispose();
                    outputChannel.appendLine('Failed to start attach debug session');
                    for (const test of tests) {
                        markSelectedLeafRunnableItemsErrored(run, test, 'Failed to attach debugger to test runner');
                    }
                    continue;
                }

                // Wait for debug session to end
                await waitForDebugSessionToEnd(SESSION_NAME, token);

                trackerReg?.dispose();
                outputChannel.appendLine('Debug session ended.');

                // VSTest path: parse TRX for results. (The xUnit v3 direct path is fully handled
                // by runXunitV3DirectSession above and never reaches here.)
                await new Promise(r => setTimeout(r, 500));
                const logFilePrefix2 = `debug-run`;
                const trxFile = findTrxFile(resultsDirectory, logFilePrefix2);
                if (trxFile) {
                    try {
                        const trxResults = await parseTrxFile(trxFile);
                        outputChannel.appendLine(`Parsed ${trxResults.length} result(s)`);
                        const { summary } = applyTestResults(controller, trxResults, run, outputChannel);
                        appendSummaryBlock(run, summary, Date.now() - projectStartMs);
                    } catch (e) {
                        const msg = e instanceof Error ? e.message : String(e);
                        for (const test of tests) {
                            markSelectedLeafRunnableItemsErrored(run, test, `TRX parse error: ${msg}`);
                        }
                    }
                } else {
                    outputChannel.appendLine('TRX not found after debug run');
                    run.appendOutput('\r\n⚠️ Test results file not found — results could not be determined.\r\n');
                    for (const test of tests) {
                        markSelectedLeafRunnableItemsErrored(run, test, 'Test results file (TRX) not found after debug run');
                    }
                }
            }

        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            outputChannel.appendLine(`Debug handler error: ${msg}`);
        } finally {
            try {
                if (fs.existsSync(resultsDirectory)) {
                    fs.rmSync(resultsDirectory, { recursive: true, force: true });
                }
            } catch { /* ignore */ }
            run.end();
        }
    };
}

function collectStringLeaves(value: unknown, maxDepth = 6): string[] {
    const results: string[] = [];
    const seen = new Set<unknown>();

    const walk = (node: unknown, depth: number) => {
        if (depth > maxDepth) { return; }
        if (node == null) { return; }
        if (typeof node === 'string') {
            const trimmed = node.trim();
            if (trimmed.length > 0) {
                results.push(trimmed);
            }
            return;
        }
        if (typeof node !== 'object') { return; }
        if (seen.has(node)) { return; }
        seen.add(node);

        if (Array.isArray(node)) {
            for (const item of node) {
                walk(item, depth + 1);
            }
            return;
        }

        for (const field of Object.values(node as Record<string, unknown>)) {
            walk(field, depth + 1);
        }
    };

    walk(value, 0);
    return results;
}

/**
 * Returns whether the build output is actually xUnit v3, by looking for v3's own assemblies
 * (xunit.v3.core.dll et al) beside the target. xUnit v2 ships xunit.core/xunit.execution.*
 * instead, so the two are unambiguous here - unlike the presence of an apphost .exe, which
 * only tells us the project's SDK produces an executable.
 *
 * Falls back to scanning the project's .deps.json when the output folder can't be listed.
 */
function hasXunitV3Assemblies(targetPath: string, outputChannel: vscode.OutputChannel): boolean {
    const outputDirectory = path.dirname(targetPath);
    try {
        const hasV3Assembly = fs.readdirSync(outputDirectory)
            .some((entry) => /^xunit\.v3\..*\.dll$/i.test(entry));
        if (hasV3Assembly) { return true; }
    } catch (err) {
        outputChannel.appendLine(`Could not list ${outputDirectory} for xUnit v3 detection: ${err}`);
    }

    const depsPath = targetPath.replace(/\.dll$/i, '.deps.json');
    try {
        if (fs.existsSync(depsPath)) {
            return /"xunit\.v3[./]/i.test(fs.readFileSync(depsPath, 'utf8'));
        }
    } catch (err) {
        outputChannel.appendLine(`Could not read ${depsPath} for xUnit v3 detection: ${err}`);
    }

    return false;
}

/**
 * Resolves the build output path for a project using MSBuild's TargetPath property.
 * Returns the full path to the output assembly (.exe for xUnit v3, .dll otherwise).
 */
function getProjectTargetPath(
    projectPath: string,
    outputChannel: vscode.OutputChannel
): Promise<string | undefined> {
    return new Promise((resolve) => {
        const proc = spawn('dotnet', ['msbuild', projectPath, '-getProperty:TargetPath', '-p:Configuration=Debug'], {
            cwd: path.dirname(projectPath),
            shell: true
        });
        let output = '';
        proc.stdout.on('data', (d: Buffer) => { output += d.toString(); });
        proc.on('close', (code) => {
            if (code === 0) {
                const lines = output.split('\n').map(l => l.trim()).filter(l => l.length > 0);
                resolve(lines[lines.length - 1] || undefined);
            } else {
                outputChannel.appendLine(`getTargetPath failed (exit ${code})`);
                resolve(undefined);
            }
        });
        proc.on('error', (err) => {
            outputChannel.appendLine(`getTargetPath error: ${err.message}`);
            resolve(undefined);
        });
    });
}

/** One entry from `<exe> -list full/json` (xUnit ConsoleProjectLister.Full). */
interface DiscoveredCase {
    DisplayName?: string;
    ID?: string;
    Class?: string;
    Method?: string;
}

/**
 * Resolves the xUnit unique ID for each selected theory case so it can be debugged in isolation
 * via the runner's `-id` option. xUnit computes these IDs at runtime, so they are not available
 * from the Roslyn-based discovery worker; we obtain them just-in-time by invoking the built test
 * executable with `-list full/json` scoped (via `-method`) to each selected theory.
 *
 * Match is by xUnit DisplayName (stored in metadata.displayName, which matches xUnit's runtime
 * display name). Cases with no unique single match are omitted; the caller falls back to `-method`.
 */
async function resolveXunitV3CaseIds(
    exePath: string,
    tests: vscode.TestItem[],
    outputChannel: vscode.OutputChannel,
    token: vscode.CancellationToken
): Promise<Map<string, string>> {
    const result = new Map<string, string>();

    // Group selected theory-case items by parent method FQN so discovery can be scoped per theory.
    const casesByMethod = new Map<string, vscode.TestItem[]>();
    for (const test of tests) {
        const metadata = getTestMetadata(test);
        if (metadata?.kind === 'case' && metadata.fullyQualifiedName) {
            const list = casesByMethod.get(metadata.fullyQualifiedName) ?? [];
            list.push(test);
            casesByMethod.set(metadata.fullyQualifiedName, list);
        }
    }
    if (casesByMethod.size === 0) {
        return result;
    }

    for (const [methodFqn, caseItems] of Array.from(casesByMethod.entries())) {
        if (token.isCancellationRequested) { break; }
        // `-list full/json` lists every discovered test case as JSON (DisplayName + ID = UniqueID);
        // `-method` scopes discovery to this one theory. JSON format implies -noLogo.
        // `-preEnumerateTheories` (valueless flag) forces the in-process runner to expand theory
        // data rows at discovery so each row gets its own DisplayName + stable unique ID; without
        // it the runner returns a single un-enumerated entry for the whole theory.
        const args = ['-list', 'full/json', '-preEnumerateTheories', '-method', methodFqn];
        outputChannel.appendLine(`Resolving theory case IDs: ${path.basename(exePath)} ${args.join(' ')}`);
        const discovered = await runXunitV3Discovery(exePath, args, outputChannel, token);
        if (!discovered) { continue; }
        outputChannel.appendLine(`Discovered ${discovered.length} case(s) for ${methodFqn}`);

        for (const caseItem of caseItems) {
            const displayName = getTestMetadata(caseItem)?.displayName;
            if (!displayName) { continue; }
            const matches = discovered.filter(d => d.DisplayName === displayName);
            if (matches.length === 1 && matches[0].ID) {
                result.set(caseItem.id, matches[0].ID);
            } else {
                // 0 matches, or ambiguous duplicate display names → let the caller fall back to -method.
                outputChannel.appendLine(`No unique ID match for case display name '${displayName}' in ${methodFqn} (matches: ${matches.length})`);
            }
        }
    }

    return result;
}

/**
 * Invokes the xUnit v3 test executable in `-list` mode and parses the JSON test-case array.
 * Returns undefined on spawn error, timeout, cancellation, or unparseable output.
 */
function runXunitV3Discovery(
    exePath: string,
    args: string[],
    outputChannel: vscode.OutputChannel,
    token: vscode.CancellationToken
): Promise<DiscoveredCase[] | undefined> {
    return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let settled = false;
        const finish = (value: DiscoveredCase[] | undefined) => {
            if (settled) { return; }
            settled = true;
            resolve(value);
        };

        const child = spawn(exePath, args, { cwd: path.dirname(exePath), shell: false });
        child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        child.on('error', (err) => {
            outputChannel.appendLine(`xUnit v3 -list discovery error: ${err.message}`);
            finish(undefined);
        });
        child.on('close', () => {
            const parsed = parseDiscoveryJson(stdout);
            if (!parsed) {
                outputChannel.appendLine(`Could not parse -list output${stderr.trim() ? `; stderr: ${stderr.trim()}` : ''}`);
            }
            finish(parsed);
        });
        token.onCancellationRequested(() => { child.kill(); finish(undefined); });
        setTimeout(() => {
            if (!settled) {
                outputChannel.appendLine('Timeout during xUnit v3 -list discovery');
                child.kill();
                finish(undefined);
            }
        }, 30000);
    });
}

/** Extracts and parses the JSON array emitted by `-list full/json`, tolerating stray output. */
function parseDiscoveryJson(output: string): DiscoveredCase[] | undefined {
    const start = output.indexOf('[');
    const end = output.lastIndexOf(']');
    if (start < 0 || end <= start) { return undefined; }
    try {
        const arr = JSON.parse(output.substring(start, end + 1));
        return Array.isArray(arr) ? arr as DiscoveredCase[] : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Runs one xUnit v3 direct debug session: spawn (-waitForDebugger), attach by process name,
 * wait for the session to end, then apply results (preferring the TRX written via -trx, which
 * yields real per-test outcome/duration and theory data; console parsing is the fallback).
 * Returns whether the runner started and how many tests actually executed — the caller uses the
 * executed count to retry as a whole-theory debug when an -id selection ran nothing.
 */
async function runXunitV3DirectSession(
    controller: vscode.TestController,
    exePath: string,
    tests: vscode.TestItem[],
    caseIdMap: Map<string, string>,
    trxPath: string,
    run: vscode.TestRun,
    outputChannel: vscode.OutputChannel,
    token: vscode.CancellationToken,
    projectStartMs: number
): Promise<{ started: boolean; executed: number }> {
    // Remove any TRX from a previous attempt so a stale file isn't mistaken for this run's results.
    try { if (fs.existsSync(trxPath)) { fs.rmSync(trxPath); } } catch { /* ignore */ }

    // xUnit v3 -waitForDebugger does NOT print its PID, so attach by process name.
    const processName = path.basename(exePath, '.exe');
    const xunitResult = await waitForXunitV3Ready(exePath, tests, caseIdMap, trxPath, run, outputChannel, token);
    if (!xunitResult.ready) {
        outputChannel.appendLine('xUnit v3 process did not become ready for debug attach');
        return { started: false, executed: 0 };
    }

    const SESSION_NAME = `KAT C# Test Explorer: Attach (${processName})`;
    outputChannel.appendLine(`Attaching debugger to: ${processName}`);
    run.appendOutput(`\r\nAttaching debugger to process '${processName}'...\r\n`);

    const attachConfig: vscode.DebugConfiguration = {
        type: 'coreclr',
        name: SESSION_NAME,
        request: 'attach',
        processName,
        justMyCode: true,
        requireExactSource: false,
        suppressJITOptimizations: true
    };

    const started = await vscode.debug.startDebugging(undefined, attachConfig, { testRun: run });
    if (!started) {
        outputChannel.appendLine('Failed to start attach debug session');
        return { started: false, executed: 0 };
    }

    // Wait for the debug session to end.
    await waitForDebugSessionToEnd(SESSION_NAME, token);
    outputChannel.appendLine('Debug session ended.');

    // Tests run after the debugger detaches; wait for the process to flush and write its TRX.
    const FLUSH_TIMEOUT_MS = 5000;
    await Promise.race([
        xunitResult.processExited,
        new Promise(r => setTimeout(r, FLUSH_TIMEOUT_MS))
    ]);
    run.appendOutput('\r\n\r\n');

    let summary: TestRunSummary | undefined;
    let executed = 0;
    if (fs.existsSync(trxPath)) {
        try {
            const trxResults = await parseTrxFile(trxPath);
            outputChannel.appendLine(`Parsed ${trxResults.length} result(s) from xUnit v3 TRX`);
            executed = trxResults.length;
            ({ summary } = applyTestResults(controller, trxResults, run, outputChannel));
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            outputChannel.appendLine(`xUnit v3 TRX parse failed (${msg}); falling back to console parsing`);
        }
    } else {
        outputChannel.appendLine('xUnit v3 TRX not found; using console output parsing');
    }
    if (!summary) {
        summary = applyXunitV3ConsoleResults(controller, xunitResult.outputLines, run, tests);
        executed = summary.passed + summary.failed;
    }
    appendSummaryBlock(run, summary, Date.now() - projectStartMs);

    return { started: true, executed };
}

/**
 * Spawns the xUnit v3 project executable directly with -waitForDebugger.
 * xUnit v3 prints "Waiting for debugger to be attached..." when ready.
 * Returns true when that message is seen (process is paused for attach).
 * Attach should then use processName, not PID, since xUnit v3 does not print its PID.
 */
async function waitForXunitV3Ready(
    exePath: string,
    tests: vscode.TestItem[],
    caseIdMap: Map<string, string>,
    trxPath: string,
    run: vscode.TestRun,
    outputChannel: vscode.OutputChannel,
    token: vscode.CancellationToken
): Promise<{ ready: boolean; outputLines: string[]; processExited: Promise<void> }> {
    // -trx writes standard TRX so results map through the existing applyTestResults path.
    const args: string[] = ['-waitForDebugger', '-trx', trxPath];
    // Dedup -id (per resolved theory case) and -method (per theory/method) so a method is
    // never launched more than once when multiple of its rows are selected.
    const seenIds = new Set<string>();
    const seenMethods = new Set<string>();
    for (const test of tests) {
        const metadata = getTestMetadata(test);
        if (metadata?.kind === 'case') {
            // Theory case: run exactly this data row by its xUnit unique ID. See CommandLine.cs
            // (-id "run a test case (by unique ID)"). IDs are resolved via -list full/json.
            const uniqueId = caseIdMap.get(test.id);
            if (uniqueId) {
                if (!seenIds.has(uniqueId)) {
                    seenIds.add(uniqueId);
                    args.push('-id', uniqueId);
                }
            } else if (!seenMethods.has(metadata.fullyQualifiedName)) {
                // Fallback: no unique ID (e.g. non-pre-enumerable theory) → debug the whole
                // theory method. Breakpoints still bind, but every data row runs.
                seenMethods.add(metadata.fullyQualifiedName);
                args.push('-method', metadata.fullyQualifiedName);
                outputChannel.appendLine(`Could not resolve unique ID for case '${metadata.displayName ?? test.label}'; debugging entire theory '${metadata.fullyQualifiedName}' (all data rows).`);
                run.appendOutput(`\r\n⚠️ Could not isolate the selected theory case; debugging all data rows of ${metadata.fullyQualifiedName}.\r\n`);
            }
        } else if (metadata) {
            if (!seenMethods.has(metadata.fullyQualifiedName)) {
                seenMethods.add(metadata.fullyQualifiedName);
                args.push('-method', metadata.fullyQualifiedName);
            }
        } else {
            // ID formats: projectPath|cls|FQN (3 parts) or projectPath|ns|Name (3 parts)
            const parts = test.id.split('|');
            if (parts.length === 3 && parts[1] === 'cls' && parts[2]) {
                args.push('-class', parts[2]);
            } else if (parts.length === 3 && parts[1] === 'ns') {
                // xUnit v3 has no namespace filter arg; running all tests in this invocation
                outputChannel.appendLine(`Warning: namespace-level filter not supported for xUnit v3 direct; running all`);
            }
        }
    }
    if (seenIds.size > 0) {
        // The -id values were computed from pre-enumerated theory rows during discovery. The
        // execution run must pre-enumerate the same way, otherwise the theory enumerates
        // differently at runtime and the row unique IDs won't match (yielding "Total: 0").
        args.push('-preEnumerateTheories');
    }
    outputChannel.appendLine(`Spawning (xUnit v3 direct): ${exePath} ${args.join(' ')}`);

    // outputLines accumulates complete stdout/stderr lines from the xUnit v3 process.
    // It keeps filling even after `ready` resolves (tests run after debugger attaches).
    const outputLines: string[] = [];
    let pendingLine = '';

    // Patterns for xUnit v3 framework output lines that should be suppressed from the
    // Test Results pane. Console.WriteLine output from user code is passed through.
    const xunitResultLineRe = /^\s+(.+?)\s+\[(PASS|FAIL|SKIP)\](?:\s+\(([^)]+)\))?\s*$/;
    const xunitSummaryRe = /^=== TEST EXECUTION SUMMARY|Total:\s+\d+,\s*Errors:/;
    // Tracks whether we are inside the indented error-detail block after a [FAIL] line.
    let inFailBlock = false;

    const { ready, processExited } = await new Promise<{ ready: boolean; processExited: Promise<void> }>((resolve) => {
        let resolved = false;

        const child = spawn(exePath, args, {
            cwd: path.dirname(exePath),
            shell: false
        });

        const processExited = new Promise<void>((exitResolve) => {
            child.on('close', exitResolve);
        });

        const handleOutput = (data: Buffer) => {
            const rawText = data.toString();
            const text = decodeCommonTextEntities(rawText);

            // Capture complete lines for post-debug result parsing.
            // Child process output arrives in arbitrary chunks, so keep a carry-over buffer.
            const combined = pendingLine + text;
            const parts = combined.split(/\r?\n/);
            pendingLine = parts.pop() ?? '';

            const userLines: string[] = [];
            for (const line of parts) {
                outputLines.push(line);

                // Suppress xUnit framework result lines (they are processed post-run).
                if (xunitResultLineRe.test(line)) {
                    inFailBlock = line.includes('[FAIL]');
                    continue;
                }
                // Suppress indented error-detail lines that follow a [FAIL] result.
                if (inFailBlock && /^\s{4}/.test(line)) {
                    continue;
                }
                inFailBlock = false;
                // Suppress xUnit execution summary lines.
                if (xunitSummaryRe.test(line)) {
                    continue;
                }
                userLines.push(line);
            }

            if (userLines.length > 0) {
                run.appendOutput(userLines.join('\r\n') + '\r\n');
            }

            outputChannel.append(text);
            // xUnit v3 prints this when paused waiting for a debugger to attach
            if (!resolved && /Waiting for debugger to be attached/i.test(text)) {
                resolved = true;
                resolve({ ready: true, processExited });
            }
        };

        child.stdout.on('data', handleOutput);
        child.stderr.on('data', handleOutput);
        child.on('close', () => {
            if (pendingLine.length > 0) {
                outputLines.push(pendingLine);
                pendingLine = '';
            }
            if (!resolved) { resolved = true; resolve({ ready: false, processExited }); }
        });
        child.on('error', (err) => {
            outputChannel.appendLine(`xUnit v3 process error: ${err.message}`);
            if (!resolved) { resolved = true; resolve({ ready: false, processExited }); }
        });
        token.onCancellationRequested(() => {
            child.kill();
            if (!resolved) { resolved = true; resolve({ ready: false, processExited }); }
        });
        setTimeout(() => {
            if (!resolved) {
                resolved = true;
                outputChannel.appendLine('Timeout waiting for xUnit v3 debugger-ready message');
                child.kill();
                resolve({ ready: false, processExited });
            }
        }, 30000);
    });

    return { ready, outputLines, processExited };
}

/**
 * Spawns dotnet test with VSTEST_HOST_DEBUG=1 (VSTest / xUnit v2 fallback path).
 * Waits for the testhost PID to be printed and returns it.
 */
function waitForTesthostPid(
    args: string[],
    projectPath: string,
    run: vscode.TestRun,
    outputChannel: vscode.OutputChannel,
    token: vscode.CancellationToken
): Promise<number | undefined> {
    return new Promise((resolve) => {
        let resolved = false;

        const child = spawn('dotnet', args, {
            cwd: path.dirname(projectPath),
            // VSTEST_DEBUG_NOBP=1 suppresses the Debugger.Break() call VSTest makes after attach,
            // preventing an unwanted initial stop. Pending breakpoints bind on module load without
            // needing the process to pause first.
            env: (() => { const e = { ...process.env, VSTEST_HOST_DEBUG: '1', VSTEST_DEBUG_NOBP: '1' }; return e; })()
        });

        const handleOutput = (data: Buffer) => {
            const text = data.toString();
            run.appendOutput(text.replace(/\n/g, '\r\n'));
            outputChannel.append(text);
            // VSTest testhost: "Process Id: 12345"
            const match = text.match(/Process Id:\s*(\d+)/i);
            if (match && !resolved) {
                resolved = true;
                resolve(parseInt(match[1], 10));
            }
        };

        child.stdout.on('data', handleOutput);
        child.stderr.on('data', handleOutput);
        child.on('close', () => { if (!resolved) { resolved = true; resolve(undefined); } });
        child.on('error', (err) => {
            outputChannel.appendLine(`Process error: ${err.message}`);
            if (!resolved) { resolved = true; resolve(undefined); }
        });
        token.onCancellationRequested(() => {
            child.kill();
            if (!resolved) { resolved = true; resolve(undefined); }
        });
        setTimeout(() => {
            if (!resolved) {
                resolved = true;
                outputChannel.appendLine('Timeout waiting for testhost PID');
                child.kill();
                resolve(undefined);
            }
        }, 30000);
    });
}

/**
 * Parses xUnit v3 console output lines and applies pass/fail/skip states to test items.
 * xUnit v3 format:  "  <displayName> [PASS|FAIL|SKIP] (optional duration)"
 * Failed tests are followed by indented error lines until the next result line.
 * Tests in `expectedItems` that have no output entry are marked as skipped.
 */
function applyXunitV3ConsoleResults(
    controller: vscode.TestController,
    outputLines: string[],
    run: vscode.TestRun,
    expectedItems: vscode.TestItem[]
): TestRunSummary {
    // Build lookup maps: FQN → TestItem, metadata.displayName → TestItem, label → TestItem.
    // metadata.displayName holds the full xUnit display name including parameters
    // (e.g. "Ns.Class.Method(data: Foo { A = 1 })"), which is what xUnit v3 prints in console
    // output. After controller.ts changed theory case labels to the short "Method (MemberData N)"
    // format, itemByLabel no longer matches; itemByDisplayName fills that gap.
    const itemByFqn = new Map<string, vscode.TestItem>();
    const itemByDisplayName = new Map<string, vscode.TestItem>();
    const itemByLabel = new Map<string, vscode.TestItem>();
    const stack: vscode.TestItem[] = [];
    controller.items.forEach(item => stack.push(item));
    while (stack.length > 0) {
        const item = stack.pop()!;
        const metadata = getTestMetadata(item);
        if (metadata?.fullyQualifiedName) {
            itemByFqn.set(metadata.fullyQualifiedName, item);
        }
        if (metadata?.displayName) {
            itemByDisplayName.set(metadata.displayName, item);
        }
        itemByLabel.set(item.label, item);
        item.children.forEach(child => stack.push(child));
    }

    // xUnit v3 result line: leading whitespace, then name, then [PASS|FAIL|SKIP], optional (Xms)
    const resultLineRe = /^\s+(.+?)\s+\[(PASS|FAIL|SKIP)\](?:\s+\(([^)]+)\))?\s*$/;

    const appliedItems = new Set<string>();
    const appliedOutcomes = new Map<string, 'passed' | 'failed' | 'skipped'>();

    let i = 0;
    while (i < outputLines.length) {
        const line = outputLines[i];
        const match = resultLineRe.exec(line);
        if (!match) { i++; continue; }

        const displayName = match[1];
        const outcome = match[2] as 'PASS' | 'FAIL' | 'SKIP';
        const durationStr = match[3];
        const durationMs = parseDurationString(durationStr);

        // Look up: FQN (non-theory), then full display name (theory cases), then label (fallback)
        const testItem = itemByFqn.get(displayName)
            ?? itemByDisplayName.get(displayName)
            ?? itemByLabel.get(displayName);

        if (!testItem) {
            i++;
            continue;
        }

        if (outcome === 'PASS') {
            run.passed(testItem, durationMs);
            appliedItems.add(testItem.id);
            appliedOutcomes.set(testItem.id, 'passed');
            run.appendOutput(`✅ PASSED: ${displayName} (${formatDuration(durationMs)})\r\n`);
            appendCaseData(testItem, run);
        } else if (outcome === 'SKIP') {
            run.skipped(testItem);
            appliedItems.add(testItem.id);
            appliedOutcomes.set(testItem.id, 'skipped');
            run.appendOutput(`⏭️ SKIPPED: ${displayName} (N/A)\r\n`);
            appendCaseData(testItem, run);
        } else {
            // Collect error lines — indented 4+ spaces, until next result or end
            i++;
            const errorLines: string[] = [];
            while (i < outputLines.length && !resultLineRe.test(outputLines[i])) {
                errorLines.push(outputLines[i].replace(/^\s{4}/, ''));
                i++;
            }
            const errorText = errorLines.join('\n').trim() || 'Test failed';
            // Prepend the theory data block so the failing data row is visible on a single click.
            const theoryBlock = buildTheoryDataBlock(testItem);
            const message = theoryBlock ? `${theoryBlock}\n\n${errorText}` : errorText;
            run.failed(testItem, new vscode.TestMessage(message), durationMs);
            appliedItems.add(testItem.id);
            appliedOutcomes.set(testItem.id, 'failed');
            run.appendOutput(`❌ FAILED: ${displayName} (${formatDuration(durationMs)})\r\n`);
            continue; // i already advanced
        }

        i++;
    }

    // Any expected leaf items with no result → skipped (fixture may have prevented execution)
    const expectedRunnableItems = new Map<string, vscode.TestItem>();
    for (const item of expectedItems) {
        collectRunnableItemsForDebug(item, expectedRunnableItems);
    }
    const expectedRunnable = Array.from(expectedRunnableItems.values());
    const unmatched = expectedRunnable.filter(item => !appliedItems.has(item.id));

    const parsedSummary = parseXunitExecutionSummary(outputLines);

    const matchedFailed = countOutcome(appliedOutcomes, 'failed');
    const matchedSkipped = countOutcome(appliedOutcomes, 'skipped');
    const matchedPassed = countOutcome(appliedOutcomes, 'passed');

    let inferredPass = 0;
    let inferredSkip = 0;
    if (parsedSummary) {
        inferredPass = Math.max(0, parsedSummary.total - parsedSummary.failed - parsedSummary.skipped - parsedSummary.notRun - matchedPassed);
        inferredSkip = Math.max(0, parsedSummary.skipped + parsedSummary.notRun - matchedSkipped);
    }

    // xUnit v3 often prints only failures in debug mode. When the execution summary
    // proves additional tests ran and passed, mark unmatched tests as passed.
    let cursor = 0;
    while (cursor < unmatched.length && inferredPass > 0) {
        const item = unmatched[cursor++];
        run.passed(item);
        appliedItems.add(item.id);
        appliedOutcomes.set(item.id, 'passed');
        const metadata = getTestMetadata(item);
        run.appendOutput(`✅ PASSED: ${metadata?.displayName ?? metadata?.fullyQualifiedName ?? item.label} (inferred from xUnit execution summary)\r\n`);
        appendCaseData(item, run);
        inferredPass--;
    }

    while (cursor < unmatched.length && inferredSkip > 0) {
        const item = unmatched[cursor++];
        run.skipped(item);
        appliedItems.add(item.id);
        appliedOutcomes.set(item.id, 'skipped');
        const metadata = getTestMetadata(item);
        run.appendOutput(`⏭️ SKIPPED: ${metadata?.displayName ?? metadata?.fullyQualifiedName ?? item.label} (inferred from xUnit execution summary)\r\n`);
        appendCaseData(item, run);
        inferredSkip--;
    }

    // Any remaining unmatched tests are unknown in debug output; keep them skipped,
    // but emit diagnostics so we can refine parsing without guesswork.
    for (; cursor < unmatched.length; cursor++) {
        const item = unmatched[cursor];
        run.skipped(item);
        appliedItems.add(item.id);
        appliedOutcomes.set(item.id, 'skipped');
        const metadata = getTestMetadata(item);
        run.appendOutput(`⏭️ SKIPPED: ${metadata?.displayName ?? metadata?.fullyQualifiedName ?? item.label} (no explicit xUnit result line)\r\n`);
        appendCaseData(item, run);
    }

    const summary: TestRunSummary = {
        passed: countOutcome(appliedOutcomes, 'passed'),
        failed: countOutcome(appliedOutcomes, 'failed'),
        skipped: countOutcome(appliedOutcomes, 'skipped'),
        total: appliedOutcomes.size,
        executionTimeMs: 0
    };

    return summary;
}

function decodeCommonTextEntities(value: string): string {
    return value
        .replace(/&#xD;/gi, '\r')
        .replace(/&#13;/g, '\r')
        .replace(/&#xA;/gi, '\n')
        .replace(/&#10;/g, '\n')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

function collectRunnableItemsForDebug(
    root: vscode.TestItem,
    collected: Map<string, vscode.TestItem>
): void {
    const stack: vscode.TestItem[] = [root];
    while (stack.length > 0) {
        const current = stack.pop()!;
        if (isLeafRunnableItem(current)) {
            collected.set(current.id, current);
        }
        current.children.forEach(child => stack.push(child));
    }
}

function parseDurationString(durationStr: string | undefined): number | undefined {
    if (!durationStr) { return undefined; }
    const msMatch = durationStr.match(/^([\d.]+)\s*ms$/i);
    if (msMatch) { return parseFloat(msMatch[1]); }
    const sMatch = durationStr.match(/^([\d.]+)\s*s$/i);
    if (sMatch) { return parseFloat(sMatch[1]) * 1000; }
    return undefined;
}

function parseXunitExecutionSummary(outputLines: string[]): { total: number; failed: number; skipped: number; notRun: number } | undefined {
    // Example:
    //   Camelot.Api.DataStore.Tests.Integration  Total: 4, Errors: 0, Failed: 1, Skipped: 0, Not Run: 0, Time: 16.161s
    const summaryRe = /Total:\s*(\d+),\s*Errors:\s*\d+,\s*Failed:\s*(\d+),\s*Skipped:\s*(\d+),\s*Not Run:\s*(\d+)/i;
    for (let i = outputLines.length - 1; i >= 0; i--) {
        const match = summaryRe.exec(outputLines[i]);
        if (match) {
            return {
                total: parseInt(match[1], 10),
                failed: parseInt(match[2], 10),
                skipped: parseInt(match[3], 10),
                notRun: parseInt(match[4], 10)
            };
        }
    }
    return undefined;
}

function countOutcome(map: Map<string, 'passed' | 'failed' | 'skipped'>, outcome: 'passed' | 'failed' | 'skipped'): number {
    let count = 0;
    for (const value of map.values()) {
        if (value === outcome) {
            count++;
        }
    }
    return count;
}

function formatDuration(ms: number | undefined): string {
    if (!ms || ms <= 0) {
        return 'N/A';
    }

    if (ms < 1000) {
        return `${ms}ms`;
    }

    return `${(ms / 1000).toFixed(2)}s (${ms}ms)`;
}

function appendSummaryBlock(
    run: vscode.TestRun,
    summary: TestRunSummary,
    totalTimeMs: number
): void {
    const resultText = summary.failed > 0 ? '❌ FAILED' : '✅ SUCCEEDED';
    const executionTimeMs = summary.executionTimeMs > 0 ? summary.executionTimeMs : totalTimeMs;

    run.appendOutput('\r\n========================================\r\n');
    run.appendOutput('Test Run Summary\r\n');
    run.appendOutput('========================================\r\n');
    run.appendOutput(`Total Tests: ${summary.total}\r\n`);
    run.appendOutput(`Passed: ${summary.passed}\r\n`);
    run.appendOutput(`Failed: ${summary.failed}\r\n`);
    run.appendOutput(`Skipped: ${summary.skipped}\r\n`);
    run.appendOutput(`Result: ${resultText}\r\n`);
    run.appendOutput(`Test Execution Time: ${formatSummaryDuration(executionTimeMs)}\r\n`);
    run.appendOutput(`Total Time (including build): ${formatSummaryDuration(totalTimeMs)}\r\n`);
    run.appendOutput('========================================\r\n');
}

function formatSummaryDuration(durationMs: number): string {
    const safeDurationMs = Math.max(0, Math.round(durationMs));
    return `${(safeDurationMs / 1000).toFixed(2)}s (${safeDurationMs}ms)`;
}

function getAllTests(controller: vscode.TestController): vscode.TestItem[] {
    const tests: vscode.TestItem[] = [];
    controller.items.forEach(item => collectTests(item, tests));
    return tests;
}

function collectTests(item: vscode.TestItem, tests: vscode.TestItem[]): void {
    tests.push(item);
    item.children.forEach(child => collectTests(child, tests));
}

function enqueueSelectedLeafRunnableItems(run: vscode.TestRun, test: vscode.TestItem): void {
    run.enqueued(test);
    test.children.forEach(child => {
        enqueueSelectedLeafRunnableItems(run, child);
    });
}

function waitForDebugSessionToEnd(sessionName: string, token: vscode.CancellationToken): Promise<void> {
    return new Promise<void>((resolve) => {
        let sessionToStop: vscode.DebugSession | undefined =
            vscode.debug.activeDebugSession?.name === sessionName ? vscode.debug.activeDebugSession : undefined;

        const startDisposable = vscode.debug.onDidStartDebugSession((session) => {
            if (session.name === sessionName) {
                sessionToStop = session;
            }
        });

        const terminateDisposable = vscode.debug.onDidTerminateDebugSession((session) => {
            if (session.name !== sessionName) {
                return;
            }

            startDisposable.dispose();
            terminateDisposable.dispose();
            resolve();
        });

        token.onCancellationRequested(() => {
            if (sessionToStop) {
                void vscode.debug.stopDebugging(sessionToStop);
            }

            startDisposable.dispose();
            terminateDisposable.dispose();
            resolve();
        });
    });
}

function markSelectedLeafRunnableItemsErrored(
    run: vscode.TestRun,
    test: vscode.TestItem,
    message: string
): void {
    if (isLeafRunnableItem(test)) {
        run.errored(test, new vscode.TestMessage(message));
        return;
    }

    test.children.forEach(child => {
        markSelectedLeafRunnableItemsErrored(run, child, message);
    });
}

function markSelectedLeafRunnableItemsPassed(run: vscode.TestRun, test: vscode.TestItem): void {
    if (isLeafRunnableItem(test)) {
        run.passed(test);
        return;
    }

    test.children.forEach(child => {
        markSelectedLeafRunnableItemsPassed(run, child);
    });
}

function groupTestsByProject(tests: readonly vscode.TestItem[]): Map<string, vscode.TestItem[]> {
    const grouped = new Map<string, vscode.TestItem[]>();
    for (const test of tests) {
        const projectPath = getProjectPath(test.id);
        if (projectPath) {
            if (!grouped.has(projectPath)) { grouped.set(projectPath, []); }
            grouped.get(projectPath)!.push(test);
        }
    }
    return grouped;
}

function getXunitV3DirectSelectionSupport(tests: readonly vscode.TestItem[]): { supported: boolean; reason: string } {
    const unsupportedReasons = new Set<string>();
    let includesProjectSelection = false;

    for (const test of tests) {
        const metadata = getTestMetadata(test);
        if (metadata?.kind === 'method' || metadata?.kind === 'case') {
            // Methods run via -method; individual theory cases run via -id (resolved at debug time).
            continue;
        }

        if (shouldRunAll(test)) {
            includesProjectSelection = true;
            continue;
        }

        const parts = test.id.split('|');
        if (parts.length === 3 && parts[1] === 'cls' && parts[2]) {
            continue;
        }

        if (parts.length === 3 && parts[1] === 'ns' && parts[2]) {
            unsupportedReasons.add('namespace selections require VSTest fallback');
            continue;
        }

        unsupportedReasons.add(`unsupported selection '${test.id}' requires VSTest fallback`);
    }

    if (unsupportedReasons.size > 0) {
        return {
            supported: false,
            reason: Array.from(unsupportedReasons).join('; ')
        };
    }

    return {
        supported: true,
        reason: includesProjectSelection
            ? 'project, class, and method selections are representable by xUnit v3 direct'
            : 'class and method selections are representable by xUnit v3 direct'
    };
}
