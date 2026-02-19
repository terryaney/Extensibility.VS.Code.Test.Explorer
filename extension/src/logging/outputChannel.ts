import * as vscode from 'vscode';

/**
 * Creates a new output channel with the given name.
 * 
 * @param name The display name for the output channel
 * @returns The created output channel
 */
export function createOutputChannel(name: string): vscode.OutputChannel {
    return vscode.window.createOutputChannel(name);
}

/**
 * Logs an error message to the output channel with timestamp.
 * 
 * @param channel The output channel to write to
 * @param message The error message
 * @param error Optional error object to include details from
 */
export function logError(channel: vscode.OutputChannel, message: string, error?: Error): void {
    const timestamp = new Date().toLocaleTimeString();
    channel.appendLine(`[${timestamp}] ERROR: ${message}`);
    
    if (error) {
        channel.appendLine(`  Details: ${error.message}`);
        if (error.stack) {
            channel.appendLine(`  Stack: ${error.stack}`);
        }
    }
}

/**
 * Logs an info message to the output channel with timestamp.
 * 
 * @param channel The output channel to write to
 * @param message The info message
 */
export function logInfo(channel: vscode.OutputChannel, message: string): void {
    const timestamp = new Date().toLocaleTimeString();
    channel.appendLine(`[${timestamp}] INFO: ${message}`);
}
