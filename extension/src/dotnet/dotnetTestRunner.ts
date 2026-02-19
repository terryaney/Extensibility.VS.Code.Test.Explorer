import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawnProcess } from './process';

/**
 * Options for running dotnet test.
 */
export interface DotnetTestOptions {
    projectPath: string;
    filter?: string;
    resultsDirectory: string;
    logFilePrefix: string;
    configuration?: string;
}

/**
 * Runs dotnet test with the specified options.
 * 
 * @param options Test execution options
 * @param run The test run to append output to
 * @param token Cancellation token
 * @returns Path to the generated TRX file, or undefined if not found
 */
export async function runDotnetTest(
    options: DotnetTestOptions,
    run: vscode.TestRun,
    token?: vscode.CancellationToken
): Promise<string | undefined> {
    const configuration = options.configuration || 'Debug';
    
    // Build command line arguments
    const args: string[] = [
        'test',
        `"${options.projectPath}"`,
        '--configuration',
        configuration,
        '--logger',
        `"trx;LogFilePrefix=${options.logFilePrefix}"`,
        '--results-directory',
        `"${options.resultsDirectory}"`
    ];

    // Add filter if specified
    if (options.filter) {
        args.push('--filter', `"${options.filter}"`);
    }

    // Stream output to test run
    const onStdout = (line: string) => {
        run.appendOutput(`${line}\r\n`);
    };

    const onStderr = (line: string) => {
        run.appendOutput(`${line}\r\n`);
    };

    // Execute dotnet test
    const result = await spawnProcess('dotnet', args, {
        cwd: path.dirname(options.projectPath),
        onStdout,
        onStderr,
        token
    });

    // Log exit code
    if (result.exitCode !== 0) {
        run.appendOutput(`\r\ndotnet test exited with code ${result.exitCode}\r\n`);
    }

    // Find and return TRX file
    return findTrxFile(options.resultsDirectory, options.logFilePrefix);
}

/**
 * Finds a TRX file in the results directory matching the specified prefix.
 * 
 * @param resultsDirectory Directory to search for TRX files
 * @param logFilePrefix Prefix to match TRX files against
 * @returns Path to the TRX file, or undefined if not found
 */
export function findTrxFile(resultsDirectory: string, logFilePrefix: string): string | undefined {
    if (!fs.existsSync(resultsDirectory)) {
        return undefined;
    }

    const files = fs.readdirSync(resultsDirectory);
    
    // Find TRX files matching the prefix
    const trxFiles = files.filter(file => 
        file.startsWith(logFilePrefix) && file.endsWith('.trx')
    );

    if (trxFiles.length === 0) {
        return undefined;
    }

    // Return the first match (should typically be only one)
    return path.join(resultsDirectory, trxFiles[0]);
}
