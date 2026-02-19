import * as vscode from 'vscode';

/**
 * Metadata associated with a test item.
 * Stored in a WeakMap to associate additional data with TestItem instances.
 */
export interface TestMetadata {
    fullyQualifiedName: string;
    projectPath: string;
}

/**
 * Location information for a test element (method, class, etc.)
 */
export interface TestLocation {
    filePath: string;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
}

/**
 * Parses a fully qualified name into namespace segments.
 * Example: "MyNamespace.SubNamespace.MyClass.MyMethod" -> ["MyNamespace", "SubNamespace", "MyClass", "MyMethod"]
 * 
 * @param fullyQualifiedName The fully qualified name to parse
 * @returns Array of name segments
 */
export function parseNamespace(fullyQualifiedName: string): string[] {
    if (!fullyQualifiedName) {
        return [];
    }
    return fullyQualifiedName.split('.');
}

/**
 * Gets the display label for a test item.
 * This returns the simple name (last segment) rather than the full qualified name.
 * 
 * @param item The test item
 * @returns The display label
 */
export function getTestLabel(item: vscode.TestItem): string {
    return item.label;
}

/**
 * Creates a stable test ID from project path and fully qualified name.
 * Format: <projectPath>|<fullyQualifiedName>
 * 
 * @param projectPath The project file path
 * @param fullyQualifiedName The fully qualified test name
 * @returns A stable test ID
 */
export function getTestId(projectPath: string, fullyQualifiedName: string): string {
    return `${projectPath}|${fullyQualifiedName}`;
}
