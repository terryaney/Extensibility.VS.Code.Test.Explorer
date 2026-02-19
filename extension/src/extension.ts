import * as vscode from 'vscode';
import { createTestController, discoverAsync, clearTests } from './testing/controller';
import { WorkerClient } from './worker/workerClient';
import { logError, logInfo } from './logging/outputChannel';

let debounceTimer: NodeJS.Timeout | undefined;
let workerClientInstance: WorkerClient | undefined;
let testControllerInstance: vscode.TestController | undefined;
let outputChannelInstance: vscode.OutputChannel | undefined;
let statusBarItemInstance: vscode.StatusBarItem | undefined;

export async function activate(context: vscode.ExtensionContext) {
    console.log('KAT C# Test Explorer activated');

    // Create output channel for diagnostics
    const outputChannel = vscode.window.createOutputChannel('KAT C# Test Explorer');
    outputChannelInstance = outputChannel;
    context.subscriptions.push(outputChannel);

    // Create status bar item for discovery progress
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    statusBarItemInstance = statusBarItem;
    statusBarItem.command = 'test-explorer.showOutput';
    statusBarItem.tooltip = 'Click to show KAT C# Test Explorer output';
    context.subscriptions.push(statusBarItem);

    // Start worker client
    const workerClient = new WorkerClient(context);
    workerClientInstance = workerClient;
    context.subscriptions.push(workerClient);
    
    try {
        logInfo(outputChannel, 'Starting worker process...');
        await workerClient.start();
        logInfo(outputChannel, 'Worker process started successfully');
    } catch (error) {
        logError(outputChannel, 'Failed to start worker process', error instanceof Error ? error : undefined);
        const errorMessage = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to start KAT C# Test Explorer worker: ${errorMessage}`);
        return;
    }

    // Create and register the test controller
    const controller = createTestController(context, workerClient, outputChannel, statusBarItem);
    testControllerInstance = controller;
    context.subscriptions.push(controller);

    // Register command to show output channel
    context.subscriptions.push(
        vscode.commands.registerCommand('test-explorer.showOutput', () => {
            outputChannel.show();
        })
    );

    // Register command to show help for no test projects scenario
    context.subscriptions.push(
        vscode.commands.registerCommand('test-explorer.showNoProjectsHelp', () => {
            const message = 'To use KAT C# Test Explorer, your project needs:\n\n' +
                '1. A test project (e.g., xUnit, NUnit, or MSTest)\n' +
                '2. The Microsoft.NET.Test.Sdk package installed\n' +
                '3. A test framework package (e.g., xunit, NUnit, or MSTest.TestFramework)\n\n' +
                'Add these packages to your .csproj file or use:\n' +
                'dotnet add package Microsoft.NET.Test.Sdk\n' +
                'dotnet add package xunit';
            
            vscode.window.showInformationMessage(message, 'Open Output').then(selection => {
                if (selection === 'Open Output') {
                    outputChannel.show();
                }
            });
        })
    );

    // Register command to restart worker
    context.subscriptions.push(
        vscode.commands.registerCommand('test-explorer.restartWorker', async () => {
            try {
                logInfo(outputChannel, 'Restarting worker process...');
                
                // Dispose current worker
                workerClient.dispose();
                
                // Create and start new worker
                const newWorkerClient = new WorkerClient(context);
                workerClientInstance = newWorkerClient;
                context.subscriptions.push(newWorkerClient);
                
                await newWorkerClient.start();
                logInfo(outputChannel, 'Worker process restarted successfully');
                
                // Clear and rediscover tests
                clearTests(controller);
                await discoverAsync(controller, newWorkerClient, outputChannel, statusBarItem);
            } catch (error) {
                logError(outputChannel, 'Failed to restart worker process', error instanceof Error ? error : undefined);
                const errorMessage = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Failed to restart worker: ${errorMessage}`);
            }
        })
    );

    // Register command to show load error details
    context.subscriptions.push(
        vscode.commands.registerCommand('test-explorer.showLoadError', () => {
            outputChannel.show();
            vscode.window.showErrorMessage(
                'Failed to load test projects. See the KAT C# Test Explorer output for details.',
                'Show Output'
            ).then(selection => {
                if (selection === 'Show Output') {
                    outputChannel.show();
                }
            });
        })
    );

    // Register refresh command
    context.subscriptions.push(
        vscode.commands.registerCommand('test-explorer.refreshTests', async () => {
            logInfo(outputChannel, 'Manual refresh requested');
            clearTests(controller);
            await discoverAsync(controller, workerClient, outputChannel, statusBarItem);
        })
    );

    // Run initial discovery (projects only - full discovery happens via resolveHandler)
    logInfo(outputChannel, 'Running initial test discovery...');
    await discoverAsync(controller, workerClient, outputChannel, statusBarItem);

    const saveWatcher = vscode.workspace.onDidSaveTextDocument((doc) => {
        if (doc.languageId !== 'csharp') { return; }
        if (debounceTimer) { clearTimeout(debounceTimer); }
        debounceTimer = setTimeout(async () => {
            logInfo(outputChannel, 'File saved, refreshing tests...');
            clearTests(controller);
            await discoverAsync(controller, workerClient, outputChannel, statusBarItem);
        }, 1500);
    });
    context.subscriptions.push(saveWatcher);
}

export function deactivate() {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
    }
}
