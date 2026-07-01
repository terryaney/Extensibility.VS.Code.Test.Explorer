import * as vscode from 'vscode';
import * as path from 'path';
import { TrxTestResult } from './trxParser';
import { clearErrorLocation, getTestMetadata, setErrorLocation } from '../testing/testItemStore';

export interface TestRunSummary {
    passed: number;
    failed: number;
    skipped: number;
    total: number;
    executionTimeMs: number;
}

export interface ApplyTestResultsResult {
    summary: TestRunSummary;
    /** TRX results that had no matching tree node — callers use these to apply to newly discovered nodes. */
    unmatchedResults: TrxTestResult[];
    /** True when expected items had no TRX result (theory cases removed from source). */
    hadRemovals: boolean;
}

export function applyTestResults(
    controller: vscode.TestController,
    results: TrxTestResult[],
    run: vscode.TestRun,
    outputChannel: vscode.OutputChannel
): ApplyTestResultsResult {
    const methodItemsByFqn = new Map<string, vscode.TestItem>();
    const caseItemsByFqnAndDisplayName = new Map<string, vscode.TestItem>();
    const orderedCasesByFqn = new Map<string, vscode.TestItem[]>();
    buildTestItemMaps(controller, methodItemsByFqn, caseItemsByFqnAndDisplayName, orderedCasesByFqn);

    const itemStates = new Map<string, 'passed' | 'failed' | 'errored' | 'skipped'>();
    const matchedItems = new Set<vscode.TestItem>();
    const appliedResults = new Set<TrxTestResult>();
    const summary: TestRunSummary = { passed: 0, failed: 0, skipped: 0, total: 0, executionTimeMs: 0 };

    // ── Phase 1: group TRX results by FQN, preserving first-seen order ──
    const resultsByFqn = new Map<string, TrxTestResult[]>();
    const fqnOrder: string[] = [];
    for (const result of results) {
        if (!resultsByFqn.has(result.fullyQualifiedName)) {
            resultsByFqn.set(result.fullyQualifiedName, []);
            fqnOrder.push(result.fullyQualifiedName);
        }
        resultsByFqn.get(result.fullyQualifiedName)!.push(result);
    }

    // Removals: a theory FQN has fewer TRX results than tree case nodes
    let hadRemovals = false;
    for (const [fqn, cases] of orderedCasesByFqn) {
        if ((resultsByFqn.get(fqn)?.length ?? 0) < cases.length) {
            hadRemovals = true;
            break;
        }
    }

    // ── Phase 2: resolve theory FQNs → ordered list of (caseItem, result) ──
    const theoryResolutions = new Map<string, Array<{ caseItem: vscode.TestItem; result: TrxTestResult }>>();
    const ignoredTheoryContainerResults = new Set<TrxTestResult>();
    for (const [fqn, fqnResults] of resultsByFqn) {
        const allCases = orderedCasesByFqn.get(fqn);
        if (!allCases) continue;

        const candidateResults = fqnResults.filter(result => !isTheoryContainerResult(fqn, result.displayName));
        for (const result of fqnResults) {
            if (!candidateResults.includes(result)) {
                ignoredTheoryContainerResults.add(result);
            }
        }

        const caseResultMap = new Map<string, TrxTestResult>(); // caseId → result
        const exactMatchedCaseIds = new Set<string>();

        for (const result of candidateResults) {
            const exactCase =
                caseItemsByFqnAndDisplayName.get(buildCaseLookupKey(fqn, result.displayName)) ??
                findCaseItemByTruncatedDisplayName(fqn, result.displayName, caseItemsByFqnAndDisplayName);
            if (exactCase) {
                caseResultMap.set(exactCase.id, result);
                exactMatchedCaseIds.add(exactCase.id);
            }
        }

        // Positional fallback for results whose display names didn't match
        const unmatchedResults = candidateResults.filter(r =>
            !exactMatchedCaseIds.has(
                (caseItemsByFqnAndDisplayName.get(buildCaseLookupKey(fqn, r.displayName)) ??
                 findCaseItemByTruncatedDisplayName(fqn, r.displayName, caseItemsByFqnAndDisplayName))?.id ?? ''
            )
        );
        const unmatchedCases = allCases.filter(c => !exactMatchedCaseIds.has(c.id));
        for (let i = 0; i < Math.min(unmatchedResults.length, unmatchedCases.length); i++) {
            caseResultMap.set(unmatchedCases[i].id, unmatchedResults[i]);
        }

        // Build in case order (insertion order = discovery order)
        const resolved: Array<{ caseItem: vscode.TestItem; result: TrxTestResult }> = [];
        for (const caseItem of allCases) {
            const r = caseResultMap.get(caseItem.id);
            if (r) resolved.push({ caseItem, result: r });
        }
        theoryResolutions.set(fqn, resolved);
    }

    // ── Phase 3: apply in FQN-first-appearance order; theories applied in case order ──
    for (const fqn of fqnOrder) {
        const resolved = theoryResolutions.get(fqn);
        if (resolved) {
            for (const { caseItem, result } of resolved) {
                applyResultToItem(caseItem, result, run, itemStates, matchedItems, summary, outputChannel);
                appliedResults.add(result);
            }
        } else {
            const methodItem = methodItemsByFqn.get(fqn);
            if (!methodItem) {
                outputChannel.appendLine(`[TreeSync] TRX result has no matching tree node: ${fqn}`);
                continue;
            }
            for (const result of resultsByFqn.get(fqn) ?? []) {
                applyResultToItem(methodItem, result, run, itemStates, matchedItems, summary, outputChannel);
                appliedResults.add(result);
            }
        }
    }

    const unmatchedResults = results.filter(r => !appliedResults.has(r) && !ignoredTheoryContainerResults.has(r));
    return { summary, unmatchedResults, hadRemovals };
}

// ─── result application ──────────────────────────────────────────────────────

function applyResultToItem(
    testItem: vscode.TestItem,
    result: TrxTestResult,
    run: vscode.TestRun,
    itemStates: Map<string, 'passed' | 'failed' | 'errored' | 'skipped'>,
    matchedItems: Set<vscode.TestItem>,
    summary: TestRunSummary,
    outputChannel: vscode.OutputChannel
): void {
    const outName = buildResultOutputName(testItem, result.fullyQualifiedName);

    switch (result.outcome) {
        case 'Passed':
            run.passed(testItem, result.duration);
            clearErrorLocation(testItem.id);
            itemStates.set(testItem.id, 'passed');
            summary.passed++;
            run.appendOutput(`✅ PASSED: ${outName} (${formatDuration(result.duration)})\r\n`);
            appendCaseData(testItem, run);
            if (result.stdOut) appendStdOut(result.stdOut, run, testItem);
            break;

        case 'Failed':
            applyFailedResult(testItem, result, run);
            itemStates.set(testItem.id, 'failed');
            summary.failed++;
            run.appendOutput(`❌ FAILED: ${outName} (${formatDuration(result.duration)})\r\n`);
            appendCaseData(testItem, run);
            if (result.stdOut) appendStdOut(result.stdOut, run, testItem);
            break;

        case 'Skipped':
        case 'NotExecuted':
            run.skipped(testItem);
            clearErrorLocation(testItem.id);
            itemStates.set(testItem.id, 'skipped');
            summary.skipped++;
            run.appendOutput(`⏭️ SKIPPED: ${outName} (N/A)\r\n`);
            break;
    }

    if (result.duration > 0) summary.executionTimeMs += result.duration;
    summary.total++;
    matchedItems.add(testItem);
}

/**
 * Builds the short name for the run output line.
 * Theory case: "FQN - DataType N"   Non-theory: "FQN"
 */
function buildResultOutputName(testItem: vscode.TestItem, fqn: string): string {
    const metadata = getTestMetadata(testItem);
    if (metadata?.kind !== 'case') return fqn;
    const m = testItem.label.match(/\(([^)]+)\)$/);
    return m ? `${fqn} - ${m[1]}` : fqn;
}

function appendStdOut(stdOut: string, run: vscode.TestRun, testItem: vscode.TestItem): void {
    let normalized = stdOut.replace(/\r?\n/g, '\r\n');
    if (!normalized.endsWith('\r\n')) normalized += '\r\n';
    run.appendOutput(normalized, undefined, testItem);
}

/**
 * For passed theory cases: writes the formatted theory data to the item's
 * output channel (visible via "Show Test Output").
 */
export function appendCaseData(testItem: vscode.TestItem, run: vscode.TestRun): void {
    const metadata = getTestMetadata(testItem);
    if (metadata?.kind !== 'case' || !metadata.displayName) return;
    const raw = extractParamDescription(metadata.displayName, metadata.fullyQualifiedName);
    if (!raw) return;
    // formatTheoryDataOutput uses bare \n; the VS Code test terminal requires \r\n or
    // each new line will start where the previous ended (staircase effect).
    const text = formatTheoryDataOutput(raw).replace(/\n/g, '\r\n');
    run.appendOutput(`${text}\r\n`, undefined, testItem);
}

function applyFailedResult(testItem: vscode.TestItem, result: TrxTestResult, run: vscode.TestRun): void {
    const errorBody = result.errorMessage || 'Test failed';

    // Prepend theory data so it's visible on a single click
    const theoryBlock = buildTheoryDataBlock(testItem);
    const message = theoryBlock ? `${theoryBlock}\n\n${errorBody}` : errorBody;

    const testMessage = new vscode.TestMessage(message);
    if (testItem.uri) {
        testMessage.location = new vscode.Location(testItem.uri, testItem.range ?? new vscode.Position(0, 0));
    }
    if (result.errorStackTrace) {
        testMessage.message = `${message}\n\nStack Trace:\n${result.errorStackTrace}`;
        const loc = parseStackTraceLocation(result.errorStackTrace);
        if (loc) setErrorLocation(testItem.id, loc); else clearErrorLocation(testItem.id);
    } else {
        clearErrorLocation(testItem.id);
    }
    run.failed(testItem, testMessage, result.duration);
}

export function buildTheoryDataBlock(testItem: vscode.TestItem): string | undefined {
    const metadata = getTestMetadata(testItem);
    if (metadata?.kind !== 'case' || !metadata.displayName) return undefined;
    const raw = extractParamDescription(metadata.displayName, metadata.fullyQualifiedName);
    return raw ? formatTheoryDataOutput(raw) : undefined;
}

// ─── theory data formatting ──────────────────────────────────────────────────

/**
 * Extracts the parameter portion of an xUnit theory display name.
 * "Namespace.Class.Method(param1, param2)" → "param1, param2"
 */
function extractParamDescription(displayName: string, fqn: string): string | undefined {
    if (!displayName.startsWith(fqn)) return undefined;
    const rest = displayName.substring(fqn.length);
    if (!rest.startsWith('(')) return rest.trim() || undefined;
    return rest.endsWith(')') ? rest.slice(1, -1) : rest.slice(1);
}

/**
 * Converts an xUnit parameter description to a "Theory Data:" block.
 *
 * Handles two forms:
 *   MemberData  → "paramName: TypeName { Prop = Val, ... }"
 *   InlineData  → "key: val, key2: val2"
 *
 * Output is JSON-like with quoted keys and proper primitive handling.
 */
function formatTheoryDataOutput(desc: string): string {
    try {
        const json = xunitDescToFormattedJson(desc.trim());
        return `Theory Data:\n${json}`;
    } catch {
        return `Theory Data:\n${desc}`;
    }
}

function xunitDescToFormattedJson(s: string): string {
    const braceIdx = s.indexOf('{');
    if (braceIdx >= 0) {
        // MemberData: "paramName: TypeName { Prop = Val, ... }"
        const objectPart = s.substring(braceIdx);
        return formatXunitObject(objectPart);
    }
    // InlineData: "key: val, key2: val2"
    return formatInlineParams(s);
}

function formatXunitObject(s: string): string {
    if (!s.startsWith('{') || !s.endsWith('}')) return s;
    const inner = s.slice(1, -1).trim();
    if (!inner) return '{}';
    const parts = splitTopLevel(inner);
    const lines = parts.map(p => formatProperty(p, 1));
    return `{\n${lines.join(',\n')}\n}`;
}

function formatInlineParams(s: string): string {
    const parts = splitTopLevel(s);
    const lines = parts.map(p => {
        const colonIdx = p.indexOf(':');
        if (colonIdx < 0) return `  ${p.trim()}`;
        const key = p.substring(0, colonIdx).trim();
        const val = p.substring(colonIdx + 1).trim();
        return `  "${key}": ${formatJsonValue(val)}`;
    });
    return `{\n${lines.join(',\n')}\n}`;
}

function formatProperty(prop: string, depth: number): string {
    const indent = '  '.repeat(depth);
    // Try "Key = Value" format (MemberData object properties)
    const eqIdx = prop.indexOf(' = ');
    if (eqIdx >= 0) {
        const key = prop.substring(0, eqIdx).trim();
        const val = prop.substring(eqIdx + 3).trim();
        return `${indent}"${key}": ${formatJsonValue(val)}`;
    }
    // Try "key: value" format
    const colonIdx = prop.indexOf(':');
    if (colonIdx >= 0) {
        const key = prop.substring(0, colonIdx).trim();
        const val = prop.substring(colonIdx + 1).trim();
        return `${indent}"${key}": ${formatJsonValue(val)}`;
    }
    return `${indent}${prop.trim()}`;
}

function formatJsonValue(val: string): string {
    if (val === 'null') return 'null';
    if (val === 'true' || val === 'false') return val;
    if (/^-?\d+(\.\d+)?$/.test(val)) return val;
    if (val.startsWith('"') && val.endsWith('"')) return val; // already a quoted string
    if (val.startsWith('[') || val.startsWith('{')) return val; // array/nested object — pass through
    return `"${val}"`; // unquoted value (datetime, enum, etc.)
}

/** Splits a string on top-level ", " separators (not inside quotes/brackets). */
function splitTopLevel(s: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let inStr = false;
    let cur = '';

    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '"') { inStr = !inStr; cur += c; continue; }
        if (inStr) { cur += c; continue; }
        if (c === '{' || c === '[') { depth++; cur += c; continue; }
        if (c === '}' || c === ']') { depth--; cur += c; continue; }
        if (c === ',' && depth === 0 && s[i + 1] === ' ') {
            parts.push(cur.trim());
            cur = '';
            i++; // skip the space
            continue;
        }
        cur += c;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts;
}

// ─── duration ────────────────────────────────────────────────────────────────

function formatDuration(ms: number | undefined): string {
    if (!ms || ms <= 0) return 'N/A';
    if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
    // Trim trailing zeros after decimal
    return `${parseFloat(ms.toFixed(2))}ms`;
}

// ─── failed-result helpers ───────────────────────────────────────────────────

function parseStackTraceLocation(stackTrace: string): { filePath: string; line: number } | undefined {
    for (const line of stackTrace.split(/\r?\n/)) {
        const m = line.match(/\s+in\s+(.+?):line\s+(\d+)/i);
        if (m) {
            const filePath = m[1].trim();
            const lineNum = parseInt(m[2], 10);
            if (filePath && (filePath.includes('\\') || filePath.includes('/')) && lineNum > 0) {
                return { filePath: path.normalize(filePath), line: lineNum };
            }
        }
    }
    return undefined;
}

// ─── map building ─────────────────────────────────────────────────────────────

function buildTestItemMaps(
    controller: vscode.TestController,
    methodMap: Map<string, vscode.TestItem>,
    caseMap: Map<string, vscode.TestItem>,
    orderedCasesByFqn: Map<string, vscode.TestItem[]>
): void {
    controller.items.forEach(item => addTestItemToMaps(item, methodMap, caseMap, orderedCasesByFqn));
}

function addTestItemToMaps(
    item: vscode.TestItem,
    methodMap: Map<string, vscode.TestItem>,
    caseMap: Map<string, vscode.TestItem>,
    orderedCasesByFqn: Map<string, vscode.TestItem[]>
): void {
    const meta = getTestMetadata(item);
    if (meta?.fullyQualifiedName) {
        if (meta.kind === 'case' && meta.displayName) {
            caseMap.set(buildCaseLookupKey(meta.fullyQualifiedName, meta.displayName), item);
            const list = orderedCasesByFqn.get(meta.fullyQualifiedName) ?? [];
            if (list.length === 0) orderedCasesByFqn.set(meta.fullyQualifiedName, list);
            list.push(item);
        } else {
            methodMap.set(meta.fullyQualifiedName, item);
        }
    }
    item.children.forEach(child => addTestItemToMaps(child, methodMap, caseMap, orderedCasesByFqn));
}

function buildCaseLookupKey(fqn: string, displayName: string): string {
    return `${fqn}||${displayName}`;
}

function isTheoryContainerResult(fqn: string, displayName: string): boolean {
    const methodName = fqn.split('.').pop() ?? fqn;
    return displayName === methodName || displayName === fqn;
}

function findCaseItemByTruncatedDisplayName(
    fqn: string,
    trxDisplayName: string,
    caseMap: Map<string, vscode.TestItem>
): vscode.TestItem | undefined {
    if (!trxDisplayName || !/,\s*[·.]{2,}\s*\}/.test(trxDisplayName)) return undefined;
    const prefix = trxDisplayName.replace(/,\s*[·.]{2,}\s*\}.*$/, '').trim();
    const keyPrefix = `${fqn}||${prefix}`;
    for (const [key, item] of caseMap) {
        if (key.startsWith(keyPrefix)) return item;
    }
    return undefined;
}
