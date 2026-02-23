import * as vscode from 'vscode';
import * as path from 'path';
import { TrxTestResult } from './trxParser';
import { getTestMetadata, isLeafRunnableItem } from '../testing/testItemStore';

export interface TestRunSummary {
    passed: number;
    failed: number;
    skipped: number;
    total: number;
    executionTimeMs: number;
}

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
    outputChannel: vscode.OutputChannel,
    expectedItems?: readonly vscode.TestItem[]
): TestRunSummary {
    // Build method and case maps for result matching
    const methodItemsByFqn = new Map<string, vscode.TestItem>();
    const caseItemsByFqnAndDisplayName = new Map<string, vscode.TestItem>();
    buildTestItemMaps(controller, methodItemsByFqn, caseItemsByFqnAndDisplayName);

    const itemStates = new Map<string, 'passed' | 'failed' | 'errored' | 'skipped'>();
    const matchedItems = new Set<vscode.TestItem>();
    const summary: TestRunSummary = {
        passed: 0,
        failed: 0,
        skipped: 0,
        total: 0,
        executionTimeMs: 0
    };
    
    // Apply each result
    for (const result of results) {
        const caseKey = buildCaseLookupKey(result.fullyQualifiedName, result.displayName);
        const testItem =
            caseItemsByFqnAndDisplayName.get(caseKey) ??
            findCaseItemByTruncatedDisplayName(result.fullyQualifiedName, result.displayName, caseItemsByFqnAndDisplayName) ??
            methodItemsByFqn.get(result.fullyQualifiedName);
        
        if (!testItem) {
            outputChannel.appendLine(
                `Warning: TRX contains test not found in tree: ${result.fullyQualifiedName}`
            );
            continue;
        }
        
        // Apply outcome
        switch (result.outcome) {
            case 'Passed':
                run.passed(testItem, result.duration);
                itemStates.set(testItem.id, 'passed');
                summary.passed++;
                run.appendOutput(`✅ PASSED: ${result.testName} (${formatDuration(result.duration)})\r\n`);
                if (result.stdOut) {
                    run.appendOutput(result.stdOut, undefined, testItem);
                }
                break;
                
            case 'Failed':
                applyFailedResult(testItem, result, run);
                itemStates.set(testItem.id, 'failed');
                summary.failed++;
                run.appendOutput(`❌ FAILED: ${result.testName} (${formatDuration(result.duration)})\r\n`);
                if (result.stdOut) {
                    run.appendOutput(result.stdOut, undefined, testItem);
                }
                break;
                
            case 'Skipped':
                run.skipped(testItem);
                itemStates.set(testItem.id, 'skipped');
                summary.skipped++;
                run.appendOutput(`⏭️ SKIPPED: ${result.testName} (N/A)\r\n`);
                break;
                
            case 'NotExecuted':
                run.skipped(testItem);
                itemStates.set(testItem.id, 'skipped');
                summary.skipped++;
                run.appendOutput(`⏭️ SKIPPED: ${result.testName} (N/A)\r\n`);
                break;
        }

        if (result.duration > 0) {
            summary.executionTimeMs += result.duration;
        }

        summary.total++;

        matchedItems.add(testItem);
    }

    const missingSkippedCount = markMissingExpectedResultsAsSkipped(expectedItems, itemStates, matchedItems, run);
    summary.skipped += missingSkippedCount;
    summary.total += missingSkippedCount;

    return summary;
}

function markMissingExpectedResultsAsSkipped(
    expectedItems: readonly vscode.TestItem[] | undefined,
    itemStates: Map<string, 'passed' | 'failed' | 'errored' | 'skipped'>,
    matchedItems: Set<vscode.TestItem>,
    run: vscode.TestRun
): number {
    if (!expectedItems || expectedItems.length === 0) {
        return 0;
    }

    const expectedRunnableItems = new Map<string, vscode.TestItem>();
    for (const item of expectedItems) {
        collectRunnableItems(item, expectedRunnableItems);
    }

    let skippedCount = 0;

    for (const item of expectedRunnableItems.values()) {
        if (itemStates.has(item.id)) {
            continue;
        }

        run.skipped(item);
        itemStates.set(item.id, 'skipped');
        matchedItems.add(item);
        skippedCount++;
    }

    return skippedCount;
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

function collectRunnableItems(
    root: vscode.TestItem,
    collected: Map<string, vscode.TestItem>
): void {
    const stack: vscode.TestItem[] = [root];

    while (stack.length > 0) {
        const current = stack.pop()!;
        const metadata = getTestMetadata(current);
        if (
            (metadata?.kind === 'method' || metadata?.kind === 'case') &&
            !(metadata?.kind === 'method' && current.children.size > 0) &&
            isLeafRunnableItem(current)
        ) {
            collected.set(current.id, current);
        }

        current.children.forEach(child => {
            stack.push(child);
        });
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
 * Recursively builds method and case lookup maps for test items.
 * 
 * @param controller The test controller
 * @param methodMap Method-level map to populate
 * @param caseMap Case-level map to populate
 */
function buildTestItemMaps(
    controller: vscode.TestController,
    methodMap: Map<string, vscode.TestItem>,
    caseMap: Map<string, vscode.TestItem>
): void {
    controller.items.forEach(item => {
        addTestItemToMaps(item, methodMap, caseMap);
    });
}

/**
 * Recursively adds a test item and its children to method/case maps.
 * 
 * @param item The test item
 * @param methodMap Method-level map to populate
 * @param caseMap Case-level map to populate
 */
function addTestItemToMaps(
    item: vscode.TestItem,
    methodMap: Map<string, vscode.TestItem>,
    caseMap: Map<string, vscode.TestItem>
): void {
    // Get metadata for this item
    const metadata = getTestMetadata(item);
    if (metadata && metadata.fullyQualifiedName) {
        if (metadata.kind === 'case' && metadata.displayName) {
            caseMap.set(buildCaseLookupKey(metadata.fullyQualifiedName, metadata.displayName), item);
        } else {
            methodMap.set(metadata.fullyQualifiedName, item);
        }
    }
    
    // Recursively process children
    item.children.forEach(child => {
        addTestItemToMaps(child, methodMap, caseMap);
    });
}

function buildCaseLookupKey(fullyQualifiedName: string, displayName: string): string {
    return `${fullyQualifiedName}||${displayName}`;
}

/**
 * Fallback case lookup for xUnit v2 VSTest truncation.
 *
 * The xUnit v2 VSTest adapter truncates theory display names in the TRX file,
 * replacing the tail with ", ... }". Discovery (dotnet test -t) returns full names.
 * When an exact key match fails and the TRX display name looks truncated, this
 * strips the truncation marker and does a prefix search against the case map.
 */
function findCaseItemByTruncatedDisplayName(
    fqn: string,
    trxDisplayName: string,
    caseMap: Map<string, vscode.TestItem>
): vscode.TestItem | undefined {
    // Only attempt when the name looks like it was truncated by xUnit v2 VSTest adapter.
    // xUnit v2 uses U+00B7 MIDDLE DOT (·) as the truncation marker, producing ", ··· }"
    if (!trxDisplayName || !/,\s*[\u00B7\.]{2,}\s*\}/.test(trxDisplayName)) {
        return undefined;
    }

    // Strip the truncation suffix (", ··· }" or ", ... }") to get the stable prefix
    const prefix = trxDisplayName.replace(/,\s*[\u00B7\.]{2,}\s*\}.*$/, '').trim();
    const keyPrefix = `${fqn}||${prefix}`;

    for (const [key, item] of caseMap) {
        if (key.startsWith(keyPrefix)) {
            return item;
        }
    }

    return undefined;
}
