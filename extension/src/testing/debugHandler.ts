import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { WorkerClient } from '../worker/workerClient';
import { buildVSTestFilter, shouldRunAll } from './filterBuilder';
import { getProjectPath, getTestMetadata } from './testItemStore';
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

                for (const test of tests) { run.started(test); }

                // Build first so it doesn't eat into the debugger-attach window.
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

                // Determine whether this is an xUnit v3 project (output is a self-contained .exe).
                // MSBuild's TargetPath always returns the managed .dll; the apphost .exe is generated
                // alongside it for executable projects. Swap the extension to check for its presence.
                const targetPath = await getProjectTargetPath(projectPath, outputChannel);
                const exePath = targetPath ? targetPath.replace(/\.dll$/i, '.exe') : undefined;
                const isXunitV3 = !!exePath && fs.existsSync(exePath);
                outputChannel.appendLine(`Target path: ${targetPath ?? '(unknown)'} | exe: ${exePath ?? '(none)'} | xUnit v3 direct: ${isXunitV3}`);

                run.appendOutput(`\r\n=== Debugging tests in ${path.basename(projectPath)} ===\r\n`);
                run.appendOutput(`\r\nStarting test runner... waiting for debugger attachment.\r\n`);

                let pid: number | undefined;
                let processName: string | undefined;

                if (isXunitV3) {
                    // xUnit v3 -waitForDebugger prints "Waiting for debugger to be attached..."
                    // but does NOT print its PID. Attach by process name instead.
                    processName = path.basename(exePath!, '.exe');
                    const ready = await waitForXunitV3Ready(exePath!, tests, run, outputChannel, token);
                    if (!ready) {
                        outputChannel.appendLine('xUnit v3 process did not become ready for debug attach');
                        for (const test of tests) {
                            run.errored(test, new vscode.TestMessage('xUnit v3 test runner did not start'));
                        }
                        continue;
                    }
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
                        run.errored(test, new vscode.TestMessage('Could not find test runner process to attach to'));
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
                    justMyCode: false,
                    requireExactSource: false,
                    suppressJITOptimizations: true
                };

                const started = await vscode.debug.startDebugging(undefined, attachConfig, { testRun: run });

                if (!started) {
                    outputChannel.appendLine('Failed to start attach debug session');
                    for (const test of tests) {
                        run.errored(test, new vscode.TestMessage('Failed to attach debugger to test runner'));
                    }
                    continue;
                }

                // Wait for debug session to end
                await new Promise<void>((resolve) => {
                    const disposable = vscode.debug.onDidTerminateDebugSession((session) => {
                        if (session.name === SESSION_NAME) {
                            disposable.dispose();
                            resolve();
                        }
                    });
                    token.onCancellationRequested(() => {
                        const sessionToStop = vscode.debug.sessions.find(s => s.name === SESSION_NAME);
                        if (sessionToStop) { vscode.debug.stopDebugging(sessionToStop); }
                        disposable.dispose();
                        resolve();
                    });
                });

                outputChannel.appendLine('Debug session ended.');

                if (!isXunitV3) {
                    // VSTest path: parse TRX for results
                    await new Promise(r => setTimeout(r, 500));
                    const logFilePrefix2 = `debug-run`;
                    const trxFile = findTrxFile(resultsDirectory, logFilePrefix2);
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
                        outputChannel.appendLine('TRX not found - marking tests as passed');
                        for (const test of tests) { run.passed(test); }
                    }
                } else {
                    // xUnit v3 direct: no TRX produced; mark passed (debug run)
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

/**
 * Spawns the xUnit v3 project executable directly with -waitForDebugger.
 * xUnit v3 prints "Waiting for debugger to be attached..." when ready.
 * Returns true when that message is seen (process is paused for attach).
 * Attach should then use processName, not PID, since xUnit v3 does not print its PID.
 */
function waitForXunitV3Ready(
    exePath: string,
    tests: vscode.TestItem[],
    run: vscode.TestRun,
    outputChannel: vscode.OutputChannel,
    token: vscode.CancellationToken
): Promise<boolean> {
    const args: string[] = ['-waitForDebugger'];
    for (const test of tests) {
        const metadata = getTestMetadata(test);
        if (metadata) {
            args.push('-method', metadata.fullyQualifiedName);
        } else {
            const parts = test.id.split('|');
            if (parts.length === 2 && parts[1]) {
                args.push('-class', parts[1]);
            }
        }
    }
    outputChannel.appendLine(`Spawning (xUnit v3 direct): ${exePath} ${args.join(' ')}`);

    return new Promise((resolve) => {
        let resolved = false;

        const child = spawn(exePath, args, {
            cwd: path.dirname(exePath),
            shell: false
        });

        const handleOutput = (data: Buffer) => {
            const text = data.toString();
            run.appendOutput(text.replace(/\n/g, '\r\n'));
            outputChannel.append(text);
            // xUnit v3 prints this when paused waiting for a debugger to attach
            if (!resolved && /Waiting for debugger to be attached/i.test(text)) {
                resolved = true;
                resolve(true);
            }
        };

        child.stdout.on('data', handleOutput);
        child.stderr.on('data', handleOutput);
        child.on('close', () => { if (!resolved) { resolved = true; resolve(false); } });
        child.on('error', (err) => {
            outputChannel.appendLine(`xUnit v3 process error: ${err.message}`);
            if (!resolved) { resolved = true; resolve(false); }
        });
        token.onCancellationRequested(() => {
            child.kill();
            if (!resolved) { resolved = true; resolve(false); }
        });
        setTimeout(() => {
            if (!resolved) {
                resolved = true;
                outputChannel.appendLine('Timeout waiting for xUnit v3 debugger-ready message');
                child.kill();
                resolve(false);
            }
        }, 30000);
    });
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
            shell: true,
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
