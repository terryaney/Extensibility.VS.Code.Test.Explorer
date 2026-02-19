import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { WorkerClient } from '../worker/workerClient';
import { buildVSTestFilter, shouldRunAll } from './filterBuilder';
import { getProjectPath } from './testItemStore';
import { runDotnetTest } from '../dotnet/dotnetTestRunner';
import { parseTrxFile } from '../results/trxParser';
import { applyTestResults } from '../results/resultMapper';

/**
 * Creates a run handler for executing tests.
 * 
 * @param controller The test controller
 * @param workerClient The worker client for communicating with the .NET worker
 * @param outputChannel The output channel for logging
 * @returns A run profile handler function
 */
export function createRunHandler(
    controller: vscode.TestController,
    workerClient: WorkerClient,
    outputChannel: vscode.OutputChannel
): (request: vscode.TestRunRequest, token: vscode.CancellationToken) => Promise<void> {
    
    return async (request: vscode.TestRunRequest, token: vscode.CancellationToken) => {
        const run = controller.createTestRun(request);
        
        // Create temp directory for TRX results
        const resultsDirectory = path.join(os.tmpdir(), `test-results-${uuidv4()}`);
        
        try {
            // Ensure results directory exists
            if (!fs.existsSync(resultsDirectory)) {
                fs.mkdirSync(resultsDirectory, { recursive: true });
            }
            
            // Determine which tests to run
            const testsToRun = request.include ?? getAllTests(controller);
            const testsToExclude = request.exclude ?? [];
            
            // Group tests by project
            const testsByProject = groupTestsByProject(testsToRun);
            
            outputChannel.appendLine(`Running ${testsToRun.length} test(s) across ${testsByProject.size} project(s)`);
            outputChannel.appendLine(`Results directory: ${resultsDirectory}`);
            
            // Execute tests for each project
            let projectIndex = 0;
            for (const [projectPath, tests] of Array.from(testsByProject.entries())) {
                if (token.isCancellationRequested) {
                    outputChannel.appendLine('Test run cancelled');
                    break;
                }
                
                projectIndex++;
                const logFilePrefix = `test-run-${projectIndex}`;
                
                // Check if we're running all tests or filtered subset
                const runningAll = tests.length === 1 && shouldRunAll(tests[0]);
                
                if (runningAll) {
                    outputChannel.appendLine(`\nRunning all tests in project: ${projectPath}`);
                    
                    // Mark all tests in project as enqueued
                    markProjectTests(run, tests[0], 'enqueued');
                    
                    // Execute dotnet test without filter
                    run.appendOutput(`\r\n=== Running all tests in ${path.basename(projectPath)} ===\r\n`);
                    
                    const trxFile = await runDotnetTest(
                        {
                            projectPath,
                            resultsDirectory,
                            logFilePrefix,
                            configuration: 'Debug'
                        },
                        run,
                        token
                    );
                    
                    if (trxFile) {
                        outputChannel.appendLine(`TRX file generated: ${trxFile}`);
                        
                        try {
                            // Parse TRX file and apply results
                            const trxResults = await parseTrxFile(trxFile);
                            outputChannel.appendLine(`Parsed ${trxResults.length} test result(s) from TRX`);
                            applyTestResults(controller, trxResults, run, outputChannel);
                        } catch (parseError) {
                            const errorMsg = parseError instanceof Error ? parseError.message : String(parseError);
                            outputChannel.appendLine(`Error parsing TRX file: ${errorMsg}`);
                            // Mark all tests as errored if parsing fails
                            markProjectTests(run, tests[0], 'errored');
                        }
                    } else {
                        outputChannel.appendLine('Warning: TRX file not found');
                        // Mark all tests as errored if TRX not found
                        markProjectTests(run, tests[0], 'errored');
                    }
                    
                } else {
                    // Build filter expression for selected tests
                    const filter = buildVSTestFilter(tests);
                    outputChannel.appendLine(`\nRunning filtered tests in project: ${projectPath}`);
                    outputChannel.appendLine(`Filter: ${filter}`);
                    
                    // Mark tests as enqueued
                    for (const test of tests) {
                        run.enqueued(test);
                    }
                    
                    // Execute dotnet test with filter
                    run.appendOutput(`\r\n=== Running filtered tests in ${path.basename(projectPath)} ===\r\n`);
                    
                    const trxFile = await runDotnetTest(
                        {
                            projectPath,
                            filter,
                            resultsDirectory,
                            logFilePrefix,
                            configuration: 'Debug'
                        },
                        run,
                        token
                    );
                    
                    if (trxFile) {
                        outputChannel.appendLine(`TRX file generated: ${trxFile}`);
                        
                        try {
                            // Parse TRX file and apply results
                            const trxResults = await parseTrxFile(trxFile);
                            outputChannel.appendLine(`Parsed ${trxResults.length} test result(s) from TRX`);
                            applyTestResults(controller, trxResults, run, outputChannel);
                        } catch (parseError) {
                            const errorMsg = parseError instanceof Error ? parseError.message : String(parseError);
                            outputChannel.appendLine(`Error parsing TRX file: ${errorMsg}`);
                            // Mark all tests as errored if parsing fails
                            for (const test of tests) {
                                run.errored(test, new vscode.TestMessage(errorMsg));
                            }
                        }
                    } else {
                        outputChannel.appendLine('Warning: TRX file not found');
                        // Mark all tests as errored if TRX not found
                        for (const test of tests) {
                            run.errored(test, new vscode.TestMessage('TRX file not found'));
                        }
                    }
                }
            }
            
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            outputChannel.appendLine(`Test run failed: ${errorMessage}`);
            run.appendOutput(`\r\nError: ${errorMessage}\r\n`);
        } finally {
            // Clean up temp directory
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

/**
 * Gets all test items from the controller.
 * 
 * @param controller The test controller
 * @returns Array of all test items
 */
function getAllTests(controller: vscode.TestController): vscode.TestItem[] {
    const tests: vscode.TestItem[] = [];
    controller.items.forEach(item => {
        collectTests(item, tests);
    });
    return tests;
}

/**
 * Recursively collects all test items from a parent.
 * 
 * @param item The parent test item
 * @param tests Array to collect tests into
 */
function collectTests(item: vscode.TestItem, tests: vscode.TestItem[]): void {
    tests.push(item);
    item.children.forEach(child => {
        collectTests(child, tests);
    });
}

/**
 * Groups test items by their owning project.
 * 
 * @param tests Array of test items to group
 * @returns Map of project path to array of test items
 */
function groupTestsByProject(tests: readonly vscode.TestItem[]): Map<string, vscode.TestItem[]> {
    const grouped = new Map<string, vscode.TestItem[]>();
    
    for (const test of tests) {
        const projectPath = getProjectPath(test.id);
        if (projectPath) {
            if (!grouped.has(projectPath)) {
                grouped.set(projectPath, []);
            }
            grouped.get(projectPath)!.push(test);
        }
    }
    
    return grouped;
}

/**
 * Marks all tests in a project with a specific state.
 * Recursively processes all children.
 * 
 * @param run The test run
 * @param projectItem The project test item
 * @param state The state to apply ('enqueued' | 'started' | 'passed' | 'errored')
 */
function markProjectTests(
    run: vscode.TestRun,
    projectItem: vscode.TestItem,
    state: 'enqueued' | 'started' | 'passed' | 'errored'
): void {
    // Apply state based on type
    if (state === 'enqueued') {
        run.enqueued(projectItem);
    } else if (state === 'started') {
        run.started(projectItem);
    } else if (state === 'passed') {
        run.passed(projectItem);
    } else if (state === 'errored') {
        run.errored(projectItem, new vscode.TestMessage('Test execution failed'));
    }
    
    // Recursively process children
    projectItem.children.forEach(child => {
        markProjectTests(run, child, state);
    });
}
