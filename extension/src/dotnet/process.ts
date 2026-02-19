import { spawn, ChildProcess } from 'child_process';
import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Result of a process execution.
 */
export interface ProcessResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

/**
 * Options for spawning a process.
 */
export interface ProcessOptions {
    cwd?: string;
    onStdout?: (line: string) => void;
    onStderr?: (line: string) => void;
    token?: vscode.CancellationToken;
}

/**
 * Spawns a process and streams output line-by-line.
 * 
 * @param command The command to execute
 * @param args Command line arguments
 * @param options Process options including callbacks for streaming output
 * @returns Promise that resolves with the process result
 */
export async function spawnProcess(
    command: string,
    args: string[],
    options: ProcessOptions = {}
): Promise<ProcessResult> {
    return new Promise<ProcessResult>((resolve, reject) => {
        const childProcess = spawn(command, args, {
            cwd: options.cwd,
            shell: true,
            windowsHide: true
        });

        let stdout = '';
        let stderr = '';
        let stdoutBuffer = '';
        let stderrBuffer = '';

        // Handle cancellation
        const cancellationListener = options.token?.onCancellationRequested(() => {
            killProcessTree(childProcess.pid!);
        });

        // Stream stdout line by line
        if (childProcess.stdout) {
            childProcess.stdout.on('data', (data: Buffer) => {
                const text = data.toString();
                stdout += text;
                stdoutBuffer += text;

                // Process complete lines
                const lines = stdoutBuffer.split(/\r?\n/);
                stdoutBuffer = lines.pop() || ''; // Keep incomplete line in buffer

                for (const line of lines) {
                    if (line && options.onStdout) {
                        options.onStdout(line);
                    }
                }
            });
        }

        // Stream stderr line by line
        if (childProcess.stderr) {
            childProcess.stderr.on('data', (data: Buffer) => {
                const text = data.toString();
                stderr += text;
                stderrBuffer += text;

                // Process complete lines
                const lines = stderrBuffer.split(/\r?\n/);
                stderrBuffer = lines.pop() || ''; // Keep incomplete line in buffer

                for (const line of lines) {
                    if (line && options.onStderr) {
                        options.onStderr(line);
                    }
                }
            });
        }

        // Handle process exit
        childProcess.on('close', (code) => {
            cancellationListener?.dispose();

            // Flush remaining buffer content
            if (stdoutBuffer && options.onStdout) {
                options.onStdout(stdoutBuffer);
            }
            if (stderrBuffer && options.onStderr) {
                options.onStderr(stderrBuffer);
            }

            resolve({
                exitCode: code ?? -1,
                stdout,
                stderr
            });
        });

        childProcess.on('error', (error) => {
            cancellationListener?.dispose();
            reject(error);
        });
    });
}

/**
 * Kills a process and all its child processes on Windows.
 * Uses taskkill to terminate the entire process tree.
 * 
 * @param pid Process ID to kill
 */
function killProcessTree(pid: number): void {
    if (process.platform === 'win32') {
        // Use taskkill to kill process tree on Windows
        try {
            execAsync(`taskkill /F /T /PID ${pid}`).catch(() => {
                // Ignore errors (process may have already exited)
            });
        } catch {
            // Ignore errors
        }
    } else {
        // On Unix-like systems, send SIGTERM
        try {
            process.kill(pid, 'SIGTERM');
        } catch {
            // Ignore errors
        }
    }
}
