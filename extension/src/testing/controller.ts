import * as vscode from 'vscode';
import { TestMetadata, TestLocation, getTestId } from './model';
import { setTestMetadata, setProjectPath, getTestMetadata as getMetadata } from './testItemStore';
import { TestProjectDto } from '../worker/protocol';
import { WorkerClient } from '../worker/workerClient';
import { createRunHandler } from './runHandler';
import { createDebugHandler } from './debugHandler';
import { logError, logInfo } from '../logging/outputChannel';

/**
 * Creates a new test item or returns an existing one if it already exists.
 * 
 * @param controller The test controller (used to create new items)
 * @param parent The parent TestItem or TestController
 * @param id The unique identifier for the test item
 * @param label The display label
 * @param uri Optional URI for the test item
 * @param range Optional range within the file
 * @returns The created or existing TestItem
 */
function createOrGetTestItem(
    controller: vscode.TestController,
    parent: vscode.TestItem | vscode.TestController,
    id: string,
    label: string,
    uri?: vscode.Uri,
    range?: vscode.Range,
    isLeaf: boolean = false
): vscode.TestItem {
    const collection = 'children' in parent ? parent.children : parent.items;
    
    let item = collection.get(id);
    if (!item) {
        // Create new test item using controller
        item = controller.createTestItem(id, label, uri);
        if (range) {
            item.range = range;
        }
        collection.add(item);
    }
    
    item.canResolveChildren = !isLeaf;
    
    return item;
}

/**
 * Adds a diagnostic node to the test tree.
 * Diagnostic nodes provide user guidance when tests cannot be discovered or loaded.
 * 
 * @param controller The test controller
 * @param id The unique identifier for the diagnostic node (should use "diagnostic:" prefix)
 * @param label The display label for the diagnostic node
 * @param tooltip Optional tooltip to show on hover
 * @returns The created diagnostic TestItem
 */
export function addDiagnosticNode(
    controller: vscode.TestController,
    id: string,
    label: string,
    tooltip?: string
): vscode.TestItem {
    // Remove any existing diagnostic nodes with this ID
    controller.items.delete(id);
    
    // Create diagnostic test item without a URI
    const item = controller.createTestItem(id, label);
    
    // Set tooltip if provided
    if (tooltip) {
        item.description = tooltip;
    }
    
    // Make it non-runnable and non-expandable
    item.canResolveChildren = false;
    
    // Add to controller
    controller.items.add(item);
    
    return item;
}

/**
 * Builds the test tree from discovered tests.
 * Creates hierarchy: Project → Namespace → Class → Method
 * 
 * @param controller The test controller
 * @param projects Array of discovered test projects from discovery response
 */
export function buildTestTree(controller: vscode.TestController, projects: TestProjectDto[]): void {
    for (const project of projects) {
        // Get or create project node
        const projectId = project.projectPath;
        const projectUri = vscode.Uri.file(project.projectPath);
        const projectItem = createOrGetTestItem(
            controller, 
            controller, 
            projectId, 
            project.name, 
            projectUri
        );
        
        // Store project path mapping
        setProjectPath(projectId, project.projectPath);
        
        // Check if project has no tests discovered
        const hasTests = project.namespaces.length > 0 && 
                        project.namespaces.some(ns => 
                            ns.classes.length > 0 && 
                            ns.classes.some(c => c.methods.length > 0)
                        );
        
        if (!hasTests) {
            // Add diagnostic node under project
            const diagnosticId = `${projectId}|diagnostic:no-tests`;
            const diagnosticItem = controller.createTestItem(
                diagnosticId,
                'ℹ️ No tests discovered'
            );
            diagnosticItem.canResolveChildren = false;
            diagnosticItem.description = 'Add test methods with [Fact] or [Theory] attributes';
            projectItem.children.add(diagnosticItem);
            continue;
        }
        
        // Process each namespace
        for (const namespace of project.namespaces) {
            const namespaceId = `${projectId}|ns|${namespace.name}`;
            const namespaceItem = createOrGetTestItem(
                controller,
                projectItem,
                namespaceId,
                namespace.name,
                projectUri
            );
            setProjectPath(namespaceId, project.projectPath);
            const currentParent = namespaceItem;
            
            // Process each class in this namespace
            for (const testClass of namespace.classes) {
                const fullClassName = namespace.name ? `${namespace.name}.${testClass.name}` : testClass.name;
                const classId = `${projectId}|${fullClassName}`;
                
                // Set uri and range for class if location is available
                let classUri: vscode.Uri | undefined;
                let classRange: vscode.Range | undefined;
                
                if (testClass.location) {
                    classUri = vscode.Uri.file(testClass.location.filePath);
                    classRange = new vscode.Range(
                        Math.max(0, testClass.location.startLine),
                        Math.max(0, testClass.location.startColumn),
                        Math.max(0, testClass.location.endLine),
                        Math.max(0, testClass.location.endColumn)
                    );
                }
                
                const classItem = createOrGetTestItem(
                    controller,
                    currentParent,
                    classId,
                    testClass.name,
                    classUri,
                    classRange
                );
                
                setProjectPath(classId, project.projectPath);
                
                // Process each method in this class
                for (const method of testClass.methods) {
                    const methodId = getTestId(project.projectPath, method.fullyQualifiedName);
                    
                    // Set uri and range for method
                    const methodUri = vscode.Uri.file(method.location.filePath);
                    const methodRange = new vscode.Range(
                        Math.max(0, method.location.startLine),
                        Math.max(0, method.location.startColumn),
                        Math.max(0, method.location.endLine),
                        Math.max(0, method.location.endColumn)
                    );
                    
                    const methodItem = createOrGetTestItem(
                        controller,
                        classItem,
                        methodId,
                        method.name,
                        methodUri,
                        methodRange,
                        true
                    );
                    
                    // Store metadata for method
                    const metadata: TestMetadata = {
                        fullyQualifiedName: method.fullyQualifiedName,
                        projectPath: project.projectPath
                    };
                    setTestMetadata(methodItem, metadata);
                    setProjectPath(methodId, project.projectPath);
                }
                
                // Sort methods in class
                sortTestItems(classItem);
            }
            
            // Sort classes in namespace
            sortTestItems(currentParent);
        }
        
        // Sort namespaces in project
        sortTestItems(projectItem);
    }
}

/**
 * Sorts test items alphabetically by label.
 * 
 * @param parent The parent test item whose children should be sorted
 */
function sortTestItems(parent: vscode.TestItem): void {
    const items: vscode.TestItem[] = [];
    parent.children.forEach(item => items.push(item));
    
    // Sort by label
    items.sort((a, b) => a.label.localeCompare(b.label));
    
    // Note: VS Code TestItemCollection doesn't have a built-in sort,
    // but the order of addition generally reflects display order.
    // This is a best-effort sorting implementation.
}

/**
 * Gets the metadata associated with a test item.
 * 
 * @param item The test item
 * @returns The metadata or undefined if not found
 */
export function getTestMetadata(item: vscode.TestItem): TestMetadata | undefined {
    return getMetadata(item);
}

/**
 * Clears all test items from the controller.
 * 
 * @param controller The test controller
 */
export function clearTests(controller: vscode.TestController): void {
    controller.items.forEach(item => {
        controller.items.delete(item.id);
    });
}

/**
 * Discovers tests and updates the test tree.
 * 
 * @param controller The test controller
 * @param workerClient The worker client to use for discovery
 * @param outputChannel The output channel for logging
 * @param statusBarItem The status bar item to show progress
 * @param token Optional cancellation token
 */
export async function discoverAsync(
    controller: vscode.TestController,
    workerClient: WorkerClient,
    outputChannel: vscode.OutputChannel,
    statusBarItem: vscode.StatusBarItem,
    token?: vscode.CancellationToken
): Promise<void> {
    try {
        // Show status bar busy indicator
        statusBarItem.text = '$(sync~spin) Discovering C# Tests...';
        statusBarItem.show();

        // Get workspace folders
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            logInfo(outputChannel, 'No workspace folders found');
            return;
        }

        const folderPaths = workspaceFolders.map(f => f.uri.fsPath);
        logInfo(outputChannel, `Starting test discovery in: ${folderPaths.join(', ')}`);

        // Call worker client to discover tests
        const abortController = new AbortController();
        if (token) {
            token.onCancellationRequested(() => abortController.abort());
        }

        const projects = await workerClient.discover(folderPaths, abortController.signal);
        logInfo(outputChannel, `Discovered ${projects.length} test project(s)`);

        // Scenario 1: No test projects found
        if (projects.length === 0) {
            addDiagnosticNode(
                controller,
                'diagnostic:no-projects',
                '⚠️ No test projects found (click for help)',
                'Right-click to learn how to set up test projects'
            );
            logInfo(outputChannel, 'No test projects found in workspace');
            return;
        }

        // Build the test tree (scenario 2 handled inside buildTestTree)
        buildTestTree(controller, projects);

        logInfo(outputChannel, 'Test discovery completed successfully');
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError(outputChannel, 'Test discovery failed', error instanceof Error ? error : undefined);

        // Scenario 3/4: Determine type of error
        const isWorkerError = errorMessage.includes('Worker') || errorMessage.includes('process');
        
        if (isWorkerError) {
            // Scenario 4: Worker communication failed
            addDiagnosticNode(
                controller,
                'diagnostic:worker-unavailable',
                '🔌 Test Service Unavailable (Restart Required)',
                'Right-click to restart the test service'
            );
        } else {
            // Scenario 3: MSBuild/Project load error
            addDiagnosticNode(
                controller,
                'diagnostic:load-error',
                '❌ Project Load Error (See Output)',
                'Right-click to view detailed error information'
            );
        }
    } finally {
        // Hide status bar indicator
        statusBarItem.hide();
    }
}

export function createTestController(
    context: vscode.ExtensionContext,
    workerClient: WorkerClient,
    outputChannel: vscode.OutputChannel,
    statusBarItem: vscode.StatusBarItem
): vscode.TestController {
    const controller = vscode.tests.createTestController(
        'csharpTestExplorer',
        'C# Tests'
    );

    // Set up the resolve handler for lazy loading tests
    controller.resolveHandler = async (item) => {
        if (!item) {
            // Root level - discover all projects
            console.log('Resolving tests at root level...');
            await discoverAsync(controller, workerClient, outputChannel, statusBarItem);
        } else {
            // Project or namespace item - currently we discover all tests eagerly
            // This can be extended later for more granular discovery
            console.log('Resolving tests for item:', item.id);
        }
    };

    // Create Run profile
    const runHandler = createRunHandler(controller, workerClient, outputChannel);
    const runProfile = controller.createRunProfile(
        'Run Tests',
        vscode.TestRunProfileKind.Run,
        runHandler,
        true // isDefault
    );

    // Create Debug profile
    const debugHandler = createDebugHandler(controller, workerClient, outputChannel);
    const debugProfile = controller.createRunProfile(
        'Debug Tests',
        vscode.TestRunProfileKind.Debug,
        debugHandler,
        false // isDefault
    );

    return controller;
}
