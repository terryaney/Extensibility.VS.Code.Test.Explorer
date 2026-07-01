import * as fs from 'fs';
import { XMLParser } from 'fast-xml-parser';

/**
 * Represents a test result parsed from a TRX file.
 */
export interface TrxTestResult {
    testId: string;
    testName: string;
    displayName: string;
    fullyQualifiedName: string;
    outcome: 'Passed' | 'Failed' | 'NotExecuted' | 'Skipped';
    duration: number; // milliseconds
    errorMessage?: string;
    errorStackTrace?: string;
    stdOut?: string;
}

/**
 * Parses a TRX (Test Results) XML file and extracts test results.
 * 
 * @param trxFilePath Path to the TRX file
 * @returns Array of parsed test results
 */
export async function parseTrxFile(trxFilePath: string): Promise<TrxTestResult[]> {
    // Read the TRX file
    const xmlContent = await fs.promises.readFile(trxFilePath, 'utf-8');
    
    // Configure XML parser
    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        textNodeName: '#text',
        parseAttributeValue: false,
        processEntities: true,
        trimValues: true
    });
    
    // Parse XML
    const parsed = parser.parse(xmlContent);
    
    // Extract test results
    const results: TrxTestResult[] = [];
    
    // Navigate to test results section
    const testRun = parsed.TestRun;
    if (!testRun || !testRun.Results) {
        return results;
    }
    
    // Get UnitTestResult elements (can be single object or array)
    let unitTestResults = testRun.Results.UnitTestResult;
    if (!unitTestResults) {
        return results;
    }
    
    // Normalize to array
    if (!Array.isArray(unitTestResults)) {
        unitTestResults = [unitTestResults];
    }
    
    // Also build a map of test definitions for getting fully qualified names
    const testDefinitions = new Map<string, string>();
    if (testRun.TestDefinitions && testRun.TestDefinitions.UnitTest) {
        let unitTests = testRun.TestDefinitions.UnitTest;
        if (!Array.isArray(unitTests)) {
            unitTests = [unitTests];
        }
        
        for (const unitTest of unitTests) {
            const testId = unitTest['@_id'];
            const testMethod = unitTest.TestMethod;
            if (testId && testMethod) {
                const className = testMethod['@_className'];
                const methodName = testMethod['@_name'];
                if (className && methodName) {
                    testDefinitions.set(testId, `${className}.${methodName}`);
                }
            }
        }
    }
    
    // Process each test result
    for (const unitTestResult of unitTestResults) {
        const testId = unitTestResult['@_testId'];
        // fast-xml-parser escapes " as \" when parsing single-quoted XML attributes (xUnit v3 TRX
        // uses single-quoted testName attributes). Unescape so display names match metadata.
        const testName = (unitTestResult['@_testName'] as string)?.replace(/\\"/g, '"') ?? '';
        const displayName = testName;
        const outcome = normalizeOutcome(unitTestResult['@_outcome']);
        const duration = parseDuration(unitTestResult['@_duration']);
        
        // Get fully qualified name from test definitions
        const fullyQualifiedName = testDefinitions.get(testId) || testName;
        
        // Extract error information if test failed
        let errorMessage: string | undefined;
        let errorStackTrace: string | undefined;
        let stdOut: string | undefined;
        
        if (unitTestResult.Output) {
            // Extract error info
            if (unitTestResult.Output.ErrorInfo) {
                const errorInfo = unitTestResult.Output.ErrorInfo;
                // Normalize CRLF/CR → LF at the adapter boundary so VS Code's TestMessage
                // renderer receives clean LF-only strings. dotnet test on Windows embeds
                // \r\n (or XML-escaped &#xD;) in message and stack trace content.
                errorMessage = typeof errorInfo.Message === 'string'
                    ? decodeCommonTextEntities(errorInfo.Message).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
                    : errorInfo.Message;
                errorStackTrace = typeof errorInfo.StackTrace === 'string'
                    ? decodeCommonTextEntities(errorInfo.StackTrace).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
                    : errorInfo.StackTrace;
            }
            
            // Extract stdout
            if (unitTestResult.Output.StdOut) {
                stdOut = typeof unitTestResult.Output.StdOut === 'string'
                    ? decodeCommonTextEntities(unitTestResult.Output.StdOut)
                    : unitTestResult.Output.StdOut;
            }
        }
        
        results.push({
            testId,
            testName,
            displayName,
            fullyQualifiedName,
            outcome,
            duration,
            errorMessage,
            errorStackTrace,
            stdOut
        });
    }
    
    return results;
}

/**
 * Normalizes TRX outcome values to our enum.
 * TRX outcomes: "Passed", "Failed", "NotExecuted", "Skipped", etc.
 * 
 * @param outcome The TRX outcome string
 * @returns Normalized outcome
 */
function normalizeOutcome(outcome: string): 'Passed' | 'Failed' | 'NotExecuted' | 'Skipped' {
    switch (outcome) {
        case 'Passed':
            return 'Passed';
        case 'Failed':
            return 'Failed';
        case 'NotExecuted':
            return 'NotExecuted';
        case 'Skipped':
            return 'Skipped';
        default:
            // Default to NotExecuted for unknown outcomes
            return 'NotExecuted';
    }
}

/**
 * Parses TRX duration format (HH:MM:SS.mmmmmmm) to milliseconds.
 * 
 * @param duration The duration string
 * @returns Duration in milliseconds
 */
function parseDuration(duration: string): number {
    if (!duration) {
        return 0;
    }
    
    // Format: HH:MM:SS.mmmmmmm
    const parts = duration.split(':');
    if (parts.length !== 3) {
        return 0;
    }
    
    const hours = parseInt(parts[0], 10);
    const minutes = parseInt(parts[1], 10);
    const secondsParts = parts[2].split('.');
    const seconds = parseInt(secondsParts[0], 10);
    const fraction = secondsParts.length > 1 ? parseFloat('0.' + secondsParts[1]) : 0;
    
    return (hours * 3600 + minutes * 60 + seconds) * 1000 + fraction * 1000;
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
