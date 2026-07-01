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
    /** Additional MSBuild properties to pass as /p:Key=Value arguments */
    msBuildProperties?: Record<string, string>;
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
    outputChannel: vscode.OutputChannel,
    token?: vscode.CancellationToken
): Promise<string | undefined> {
    const configuration = options.configuration || 'Debug';

    // Build command line arguments
    const args: string[] = [
        'test',
        options.projectPath,
        '--configuration',
        configuration,
        '--logger',
        `trx;LogFilePrefix=${options.logFilePrefix}`,
        '--results-directory',
        options.resultsDirectory
    ];

    // Add filter if specified
    if (options.filter) {
        args.push('--filter', options.filter);
    }

    // Add MSBuild properties if specified
    if (options.msBuildProperties) {
        for (const [key, value] of Object.entries(options.msBuildProperties)) {
            args.push(`/p:${key}=${value}`);
        }
    }

    // Buffer stdout/stderr to outputChannel only during execution.
    // Raw build/restore/runner output is suppressed from the Test Results pane unless the
    // build fails (no TRX produced), in which case it is surfaced after the exit-code line.
    const bufferedLines: string[] = [];

    const onStdout = (line: string) => {
        outputChannel.append(`${line}\r\n`);
        bufferedLines.push(line);
    };

    const onStderr = (line: string) => {
        outputChannel.append(`${line}\r\n`);
        bufferedLines.push(line);
    };

    // Execute dotnet test
    const result = await spawnProcess('dotnet', args, {
        cwd: path.dirname(options.projectPath),
        onStdout,
        onStderr,
        token
    });

    const trxFile = findTrxFile(options.resultsDirectory, options.logFilePrefix);

    // Always emit the exit code — this is the visual divider before structured results.
    run.appendOutput(`\r\ndotnet test exited with code ${result.exitCode}\r\n`);

    // Only surface the raw output when build/restore failed (no TRX produced).
    if (!trxFile) {
        run.appendOutput('\r\n');
        for (const line of bufferedLines) {
            run.appendOutput(`${line}\r\n`);
        }
    }

    return trxFile;
}

/**
 * Runs dotnet build on each project before test discovery to ensure compiled
 * assemblies are current (required for theory case enumeration).
 */
export async function buildProjects(
    projectPaths: string[],
    outputChannel: vscode.OutputChannel,
    statusBarItem: vscode.StatusBarItem
): Promise<void> {
    statusBarItem.text = '$(sync~spin) Building test projects...';
    statusBarItem.show();

    for (const projectPath of projectPaths) {
        outputChannel.appendLine(`[Build] dotnet build "${projectPath}" --configuration Debug`);
        const result = await spawnProcess('dotnet', ['build', projectPath, '--configuration', 'Debug'], {
            cwd: path.dirname(projectPath),
            onStdout: (line) => outputChannel.appendLine(line),
            onStderr: (line) => outputChannel.appendLine(line)
        });
        outputChannel.appendLine(`[Build] Exit code: ${result.exitCode}`);
        if (result.exitCode !== 0) {
            vscode.window.showWarningMessage(
                `Build failed for ${path.basename(projectPath)} — theory cases may be stale. See KAT C# Test Explorer output for details.`
            );
        }
    }
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
