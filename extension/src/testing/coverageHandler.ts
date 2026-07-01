import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { buildVSTestFilter, shouldRunAll } from './filterBuilder';
import { getProjectPath, isLeafRunnableItem } from './testItemStore';
import { runDotnetTest } from '../dotnet/dotnetTestRunner';
import { parseTrxFile } from '../results/trxParser';
import { applyTestResults, TestRunSummary } from '../results/resultMapper';
import { parseCoberturaFile } from '../results/coberturaParser';
import { CoverageCache } from './coverageCache';

/**
 * Creates a coverage run handler that runs tests with coverlet.msbuild instrumentation
 * and reports per-file coverage back to VS Code via run.addCoverage().
 *
 * @param controller The test controller
 * @param outputChannel The output channel for logging
 * @param coverageRunDetails WeakMap populated with per-run, per-file detailed coverage for loadDetailedCoverage
 */
export function createCoverageHandler(
    controller: vscode.TestController,
    outputChannel: vscode.OutputChannel,
    coverageRunDetails: WeakMap<vscode.TestRun, Map<string, vscode.FileCoverageDetail[]>>,
    cache: CoverageCache
): (request: vscode.TestRunRequest, token: vscode.CancellationToken) => Promise<void> {

    return async (request: vscode.TestRunRequest, token: vscode.CancellationToken) => {
        const run = controller.createTestRun(request);

        // Each run gets its own detail map so concurrent/sequential runs don't clobber each other
        const runDetailMap = new Map<string, vscode.FileCoverageDetail[]>();
        coverageRunDetails.set(run, runDetailMap);
        run.appendOutput('Running tests with coverage...\r\n\r\n');

        const resultsDirectory = path.join(os.tmpdir(), `test-results-${uuidv4()}`);

        try {
            if (!fs.existsSync(resultsDirectory)) {
                fs.mkdirSync(resultsDirectory, { recursive: true });
            }

            const testsToRun = request.include ?? getAllTests(controller);
            const testsByProject = groupTestsByProject(testsToRun);

            outputChannel.appendLine(`Running with coverage: ${testsToRun.length} test(s) across ${testsByProject.size} project(s)`);
            outputChannel.appendLine(`Results directory: ${resultsDirectory}`);

            const hasMultipleProjects = testsByProject.size > 1;
            const projectSummaries: Array<{ projectName: string; summary: TestRunSummary; totalTimeMs: number }> = [];

            let projectIndex = 0;
            for (const [projectPath, tests] of Array.from(testsByProject.entries())) {
                if (token.isCancellationRequested) {
                    outputChannel.appendLine('Test run cancelled');
                    break;
                }

                projectIndex++;
                const logFilePrefix = `coverage-run-${projectIndex}`;

                // Each project writes its Cobertura output to a unique path so multi-project runs don't collide
                const coberturaPath = path.join(resultsDirectory, `coverage-${projectIndex}.cobertura.xml`);

                const msBuildProperties: Record<string, string> = {
                    CollectCoverage: 'true',
                    CoverletOutputFormat: 'cobertura',
                    CoverletOutput: coberturaPath
                };

                const runningAll = tests.length === 1 && shouldRunAll(tests[0]);

                if (runningAll) {
                    outputChannel.appendLine(`\nRunning all tests (with coverage) in project: ${projectPath}`);
                    markProjectTests(run, tests[0], 'enqueued');

                    const invocationStart = Date.now();
                    const trxFile = await runDotnetTest(
                        { projectPath, resultsDirectory, logFilePrefix, configuration: 'Debug', msBuildProperties },
                        run,
                        outputChannel,
                        token
                    );
                    const totalTimeMs = Date.now() - invocationStart;

                    if (trxFile) {
                        try {
                            const trxResults = await parseTrxFile(trxFile);
                            const { summary } = applyTestResults(controller, trxResults, run, outputChannel);
                            projectSummaries.push({ projectName: path.basename(projectPath), summary, totalTimeMs });
                            appendSummaryBlock(run, summary, totalTimeMs, hasMultipleProjects ? path.basename(projectPath) : undefined);
                        } catch (parseError) {
                            const msg = parseError instanceof Error ? parseError.message : String(parseError);
                            outputChannel.appendLine(`Error parsing TRX file: ${msg}`);
                            markProjectTests(run, tests[0], 'errored');
                        }
                    } else {
                        outputChannel.appendLine('Warning: TRX file not found');
                        markProjectTests(run, tests[0], 'errored');
                    }
                } else {
                    const filter = buildVSTestFilter(tests);
                    outputChannel.appendLine(`\nRunning filtered tests (with coverage) in project: ${projectPath}`);
                    outputChannel.appendLine(`Filter: ${filter}`);

                    for (const test of tests) {
                        markProjectTests(run, test, 'enqueued');
                    }

                    const invocationStart = Date.now();
                    const trxFile = await runDotnetTest(
                        { projectPath, filter, resultsDirectory, logFilePrefix, configuration: 'Debug', msBuildProperties },
                        run,
                        outputChannel,
                        token
                    );
                    const totalTimeMs = Date.now() - invocationStart;

                    if (trxFile) {
                        try {
                            const trxResults = await parseTrxFile(trxFile);
                            const { summary } = applyTestResults(controller, trxResults, run, outputChannel);
                            projectSummaries.push({ projectName: path.basename(projectPath), summary, totalTimeMs });
                            appendSummaryBlock(run, summary, totalTimeMs, hasMultipleProjects ? path.basename(projectPath) : undefined);
                        } catch (parseError) {
                            const msg = parseError instanceof Error ? parseError.message : String(parseError);
                            outputChannel.appendLine(`Error parsing TRX file: ${msg}`);
                            for (const test of tests) {
                                run.errored(test, new vscode.TestMessage(msg));
                            }
                        }
                    } else {
                        outputChannel.appendLine('Warning: TRX file not found');
                        for (const test of tests) {
                            run.errored(test, new vscode.TestMessage('TRX file not found'));
                        }
                    }
                }

                // Parse Cobertura coverage for this project and report to VS Code
                if (fs.existsSync(coberturaPath)) {
                    outputChannel.appendLine(`Parsing coverage: ${coberturaPath}`);
                    try {
                        const fileCoverages = parseCoberturaFile(coberturaPath);
                        outputChannel.appendLine(`Coverage data for ${fileCoverages.length} file(s)`);

                        for (const fc of fileCoverages) {
                            // Store details per-run for loadDetailedCoverage
                            runDetailMap.set(fc.uri.toString(), fc.details);

                            run.addCoverage(new vscode.FileCoverage(
                                fc.uri,
                                fc.statementCoverage,
                                fc.branchCoverage
                            ));
                        }

                        // Update the cache so coverage can be restored without re-running
                        cache.update(fileCoverages, outputChannel);
                    } catch (coverageError) {
                        const msg = coverageError instanceof Error ? coverageError.message : String(coverageError);
                        outputChannel.appendLine(`Warning: Failed to parse coverage file: ${msg}`);
                    }
                } else {
                    outputChannel.appendLine(`Warning: Coverage file not found at ${coberturaPath}`);
                    outputChannel.appendLine('Ensure coverlet.msbuild is referenced in the test project.');
                }
            }

            if (projectSummaries.length > 1) {
                const combinedSummary = projectSummaries.reduce<TestRunSummary>((acc, entry) => {
                    acc.passed += entry.summary.passed;
                    acc.failed += entry.summary.failed;
                    acc.skipped += entry.summary.skipped;
                    acc.total += entry.summary.total;
                    acc.executionTimeMs += entry.summary.executionTimeMs;
                    return acc;
                }, { passed: 0, failed: 0, skipped: 0, total: 0, executionTimeMs: 0 });

                const combinedTotalTimeMs = projectSummaries.reduce((acc, e) => acc + e.totalTimeMs, 0);
                appendSummaryBlock(run, combinedSummary, combinedTotalTimeMs, 'Combined');
            }

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            outputChannel.appendLine(`Coverage run failed: ${errorMessage}`);
            run.appendOutput(`\r\nError: ${errorMessage}\r\n`);
        } finally {
            try {
                if (fs.existsSync(resultsDirectory)) {
                    fs.rmSync(resultsDirectory, { recursive: true, force: true });
                    outputChannel.appendLine(`Cleaned up results directory: ${resultsDirectory}`);
                }
            } catch (cleanupError) {
                outputChannel.appendLine(`Warning: Failed to clean up results directory: ${cleanupError}`);
            }

            run.end();
        }
    };
}

// -- Helpers (mirrors of private helpers in runHandler.ts) --

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

function markProjectTests(run: vscode.TestRun, item: vscode.TestItem, state: 'enqueued' | 'errored'): void {
    if (state === 'enqueued') {
        run.enqueued(item);
    } else if (isLeafRunnableItem(item)) {
        run.errored(item, new vscode.TestMessage('Test execution failed'));
    }
    item.children.forEach(child => markProjectTests(run, child, state));
}

function appendSummaryBlock(run: vscode.TestRun, summary: TestRunSummary, totalTimeMs: number, projectName?: string): void {
    const resultText = summary.failed > 0 ? '❌ FAILED' : '✅ SUCCEEDED';
    const executionTimeMs = summary.executionTimeMs > 0 ? summary.executionTimeMs : totalTimeMs;
    const headerTitle = projectName ? `Test Run Summary (${projectName})` : 'Test Run Summary';

    run.appendOutput('\r\n========================================\r\n');
    run.appendOutput(`${headerTitle}\r\n`);
    run.appendOutput('========================================\r\n');
    run.appendOutput(`Total Tests: ${summary.total}\r\n`);
    run.appendOutput(`Passed: ${summary.passed}\r\n`);
    run.appendOutput(`Failed: ${summary.failed}\r\n`);
    run.appendOutput(`Skipped: ${summary.skipped}\r\n`);
    run.appendOutput(`Result: ${resultText}\r\n`);
    run.appendOutput(`Test Execution Time: ${(Math.max(0, Math.round(executionTimeMs)) / 1000).toFixed(2)}s\r\n`);
    run.appendOutput(`Total Time (including build): ${(Math.max(0, Math.round(totalTimeMs)) / 1000).toFixed(2)}s\r\n`);
    run.appendOutput('========================================\r\n');
}
