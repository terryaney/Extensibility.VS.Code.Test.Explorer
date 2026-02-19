import * as vscode from 'vscode';
import * as path from 'path';
import { TrxTestResult } from './trxParser';
import { testMetadata } from '../testing/testItemStore';

/**
 * Applies TRX test results to VS Code TestItems and updates the TestRun.
 * 
 * @param controller The test controller
 * @param results Array of TRX test results
 * @param run The test run to update
 * @param outputChannel Output channel for logging warnings
 */
export function applyTestResults(
    controller: vscode.TestController,
    results: TrxTestResult[],
    run: vscode.TestRun,
    outputChannel: vscode.OutputChannel
): void {
    // Build a map of fully qualified names to test items for quick lookup
    const testItemsByFqn = new Map<string, vscode.TestItem>();
    buildTestItemMap(controller, testItemsByFqn);
    
    // Apply each result
    for (const result of results) {
        const testItem = testItemsByFqn.get(result.fullyQualifiedName);
        
        if (!testItem) {
            outputChannel.appendLine(
                `Warning: TRX contains test not found in tree: ${result.fullyQualifiedName}`
            );
            continue;
        }
        
        // Start the test if not already started
        run.started(testItem);
        
        // Apply outcome
        switch (result.outcome) {
            case 'Passed':
                run.passed(testItem, result.duration);
                break;
                
            case 'Failed':
                applyFailedResult(testItem, result, run);
                break;
                
            case 'Skipped':
                run.skipped(testItem);
                break;
                
            case 'NotExecuted':
                run.skipped(testItem);
                break;
        }
        
        // Append stdout if present
        if (result.stdOut) {
            run.appendOutput(`\r\n--- Output from ${result.testName} ---\r\n`);
            run.appendOutput(result.stdOut);
            run.appendOutput('\r\n');
        }
    }
}

/**
 * Applies a failed test result with error messages and stack traces.
 * 
 * @param testItem The test item that failed
 * @param result The TRX test result
 * @param run The test run
 */
function applyFailedResult(
    testItem: vscode.TestItem,
    result: TrxTestResult,
    run: vscode.TestRun
): void {
    // Build error message
    const message = result.errorMessage || 'Test failed';
    
    // Create TestMessage
    const testMessage = new vscode.TestMessage(message);
    
    // Parse stack trace to extract location
    if (result.errorStackTrace) {
        const location = parseStackTraceLocation(result.errorStackTrace);
        if (location) {
            testMessage.location = new vscode.Location(
                vscode.Uri.file(location.filePath),
                new vscode.Position(location.line - 1, 0) // Convert to 0-based
            );
        }
        
        // Include full stack trace in the message
        testMessage.message = `${message}\n\nStack Trace:\n${result.errorStackTrace}`;
    }
    
    // Mark test as failed
    run.failed(testItem, testMessage, result.duration);
}

/**
 * Parses a stack trace to extract the first relevant file location.
 * Common format: "at ClassName.MethodName() in FilePath:line LineNumber"
 * 
 * @param stackTrace The stack trace string
 * @returns Parsed location or undefined if not found
 */
function parseStackTraceLocation(stackTrace: string): { filePath: string; line: number } | undefined {
    // Split into lines
    const lines = stackTrace.split(/\r?\n/);
    
    // Look for lines containing " in " followed by a file path
    for (const line of lines) {
        // Pattern: "at <method> in <filepath>:line <number>"
        const match = line.match(/\s+in\s+(.+?):line\s+(\d+)/i);
        if (match) {
            const filePath = match[1].trim();
            const lineNumber = parseInt(match[2], 10);
            
            // Validate that it looks like a real file path
            if (filePath && (filePath.includes('\\') || filePath.includes('/')) && lineNumber > 0) {
                return {
                    filePath: path.normalize(filePath),
                    line: lineNumber
                };
            }
        }
    }
    
    return undefined;
}

/**
 * Recursively builds a map of fully qualified names to test items.
 * 
 * @param controller The test controller
 * @param map Map to populate
 */
function buildTestItemMap(
    controller: vscode.TestController,
    map: Map<string, vscode.TestItem>
): void {
    controller.items.forEach(item => {
        addTestItemToMap(item, map);
    });
}

/**
 * Recursively adds a test item and its children to the map.
 * 
 * @param item The test item
 * @param map Map to populate
 */
function addTestItemToMap(
    item: vscode.TestItem,
    map: Map<string, vscode.TestItem>
): void {
    // Get metadata for this item
    const metadata = testMetadata.get(item);
    if (metadata && metadata.fullyQualifiedName) {
        map.set(metadata.fullyQualifiedName, item);
    }
    
    // Recursively process children
    item.children.forEach(child => {
        addTestItemToMap(child, map);
    });
}
