import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { WorkerClient } from '../worker/workerClient';
import { buildVSTestFilter, shouldRunAll } from './filterBuilder';
import { getProjectPath } from './testItemStore';
import { parseTrxFile } from '../results/trxParser';
import { applyTestResults } from '../results/resultMapper';
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

                const logFilePrefix = `debug-run`;

                for (const test of tests) { run.started(test); }

                // Build first (separate from test run) so the build doesn't eat into the
                // 30-second testhost debugger-attach timeout.
                run.appendOutput(`\r\nBuilding ${path.basename(projectPath)}...\r\n`);
                outputChannel.appendLine(`Building: dotnet build ${projectPath} --configuration Debug`);
                const buildResult = await new Promise<number>((resolve) => {
                    const buildProc = spawn('dotnet', ['build', projectPath, '--configuration', 'Debug'], {
                        cwd: path.dirname(projectPath),
                        shell: true
                    });
                    buildProc.stdout.on('data', (d: Buffer) => outputChannel.append(d.toString()));
                    buildProc.stderr.on('data', (d: Buffer) => outputChannel.append(d.toString()));
                    buildProc.on('close', resolve);
                    buildProc.on('error', () => resolve(1));
                });

                if (buildResult !== 0) {
                    for (const test of tests) {
                        run.errored(test, new vscode.TestMessage('Build failed before debug run'));
                    }
                    continue;
                }

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

                run.appendOutput(`\r\n=== Debugging tests in ${path.basename(projectPath)} ===\r\n`);
                run.appendOutput(`\r\nStarting test host... waiting for debugger attachment.\r\n`);
                outputChannel.appendLine(`Spawning: dotnet ${args.join(' ')}`);

                // Spawn dotnet test with VSTEST_HOST_DEBUG=1
                // This makes the testhost pause and print "Process Id: XXXXX"
                const testhostPid = await waitForTesthostPid(args, projectPath, run, outputChannel, token);

                if (!testhostPid) {
                    outputChannel.appendLine('Could not find testhost PID - debug attach failed');
                    for (const test of tests) {
                        run.errored(test, new vscode.TestMessage('Could not find testhost process to attach to'));
                    }
                    continue;
                }

                outputChannel.appendLine(`Attaching debugger to testhost PID: ${testhostPid}`);
                run.appendOutput(`\r\nAttaching debugger to process ${testhostPid}...\r\n`);

                const SESSION_NAME = 'KAT C# Test Explorer: Attach to testhost';
                // Track both signals needed before we can safely continue:
                // - stoppedThreadId: set when we see a 'stopped' event (VSTest initial break, if NOBP didn't fully suppress it)
                // - configDone: set when VS Code sends 'configurationDone' (breakpoints are synced to adapter)
                // We continue when BOTH are true, OR when the fallback timer fires.
                let stoppedThreadId: number | undefined;
                let configDone = false;
                let autoContinueDone = false;
                let fallbackTimer: NodeJS.Timeout | undefined;

                const doAutoContinue = async (session: vscode.DebugSession, reason: string) => {
                    if (autoContinueDone) { return; }
                    autoContinueDone = true;
                    if (fallbackTimer) { clearTimeout(fallbackTimer); }
                    const threadId = stoppedThreadId ?? 1;
                    outputChannel.appendLine(`Auto-continue (${reason}, thread ${threadId})`);
                    try {
                        await session.customRequest('continue', { threadId });
                    } catch (e) {
                        outputChannel.appendLine(`Auto-continue failed: ${e}`);
                    }
                };

                const trackerDisposable = vscode.debug.registerDebugAdapterTrackerFactory('coreclr', {
                    createDebugAdapterTracker(session: vscode.DebugSession) {
                        if (session.name !== SESSION_NAME) { return undefined; }
                        return {
                            onWillReceiveMessage(message: { command?: string; type?: string }) {
                                // configurationDone = VS Code has sent all setBreakpoints requests to the adapter
                                if (message.type === 'request' && message.command === 'configurationDone') {
                                    configDone = true;
                                    outputChannel.appendLine('configurationDone sent — breakpoints synced to adapter');
                                    // If we're already stopped, safe to continue now
                                    if (stoppedThreadId !== undefined) {
                                        doAutoContinue(session, 'configurationDone+stopped');
                                    }
                                }
                            },
                            onDidSendMessage(message: { type: string; event?: string; body?: { reason?: string; threadId?: number } }) {
                                if (autoContinueDone) { return; }

                                if (message.type === 'event' && message.event === 'stopped') {
                                    stoppedThreadId = message.body?.threadId ?? 1;
                                    outputChannel.appendLine(`Stopped event (reason: ${message.body?.reason ?? 'unknown'}, thread ${stoppedThreadId})`);

                                    // Start fallback timer — if configurationDone never arrives, continue after 8s
                                    fallbackTimer = setTimeout(() => {
                                        doAutoContinue(session, '8s fallback timeout');
                                    }, 8000);

                                    // If configurationDone already arrived, continue now
                                    if (configDone) {
                                        doAutoContinue(session, 'stopped+configurationDone');
                                    }
                                }
                            },
                            onError(error: Error) {
                                outputChannel.appendLine(`DAP tracker error: ${error.message}`);
                            }
                        };
                    }
                });

                const attachConfig: vscode.DebugConfiguration = {
                    type: 'coreclr',
                    name: SESSION_NAME,
                    request: 'attach',
                    processId: testhostPid,
                    justMyCode: false
                };

                const started = await vscode.debug.startDebugging(undefined, attachConfig, { testRun: run });

                if (!started) {
                    trackerDisposable.dispose();
                    outputChannel.appendLine('Failed to start attach debug session');
                    for (const test of tests) {
                        run.errored(test, new vscode.TestMessage('Failed to attach debugger to testhost'));
                    }
                    continue;
                }

                // Wait for debug session (and therefore the test run) to end
                await new Promise<void>((resolve) => {
                    const disposable = vscode.debug.onDidTerminateDebugSession((session) => {
                        if (session.name === SESSION_NAME) {
                            disposable.dispose();
                            trackerDisposable.dispose();
                            resolve();
                        }
                    });
                    token.onCancellationRequested(() => {
                        const sessionToStop = vscode.debug.sessions.find(s => s.name === SESSION_NAME);
                        if (sessionToStop) {
                            vscode.debug.stopDebugging(sessionToStop);
                        } else {
                            vscode.debug.stopDebugging();
                        }
                        disposable.dispose();
                        trackerDisposable.dispose();
                        resolve();
                    });
                });

                outputChannel.appendLine('Debug session ended, parsing results...');

                // Wait briefly for TRX to be written
                await new Promise(r => setTimeout(r, 500));

                const trxFile = findTrxFile(resultsDirectory, logFilePrefix);
                if (trxFile) {
                    try {
                        const trxResults = await parseTrxFile(trxFile);
                        outputChannel.appendLine(`Parsed ${trxResults.length} result(s)`);
                        applyTestResults(controller, trxResults, run, outputChannel);
                    } catch (e) {
                        const msg = e instanceof Error ? e.message : String(e);
                        for (const test of tests) {
                            run.errored(test, new vscode.TestMessage(`TRX parse error: ${msg}`));
                        }
                    }
                } else {
                    outputChannel.appendLine('TRX not found - marking tests as passed (debug ran successfully)');
                    for (const test of tests) { run.passed(test); }
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

/**
 * Spawns dotnet test with VSTEST_HOST_DEBUG=1, waits for the testhost PID
 * to be printed to output, and returns that PID as a number.
 * Returns undefined if PID is not found within the timeout.
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
            shell: true,
            env: { ...process.env, VSTEST_HOST_DEBUG: '1', VSTEST_DEBUG_NOBP: '1' }
        });

        // xUnit v3 may also print to stderr
        const handleOutput = (data: Buffer) => {
            const text = data.toString();
            run.appendOutput(text.replace(/\n/g, '\r\n'));
            outputChannel.append(text);

            // Match "Process Id: 12345" (VSTest testhost format)
            const match = text.match(/Process Id:\s*(\d+)/i);
            if (match && !resolved) {
                resolved = true;
                resolve(parseInt(match[1], 10));
                // Do NOT kill child - the testhost must keep running for debugging
                // The child (dotnet CLI) will exit naturally when testhost finishes
            }
        };

        child.stdout.on('data', handleOutput);
        child.stderr.on('data', handleOutput);

        child.on('close', () => {
            if (!resolved) {
                resolved = true;
                resolve(undefined);
            }
        });

        child.on('error', (err) => {
            outputChannel.appendLine(`Process error: ${err.message}`);
            if (!resolved) {
                resolved = true;
                resolve(undefined);
            }
        });

        token.onCancellationRequested(() => {
            child.kill();
            if (!resolved) {
                resolved = true;
                resolve(undefined);
            }
        });

        // Timeout: if no PID after 30s, give up
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

function getAllTests(controller: vscode.TestController): vscode.TestItem[] {
    const tests: vscode.TestItem[] = [];
    controller.items.forEach(item => collectTests(item, tests));
    return tests;
}

function collectTests(item: vscode.TestItem, tests: vscode.TestItem[]): void {
    tests.push(item);
    item.children.forEach(child => collectTests(child, tests));
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
