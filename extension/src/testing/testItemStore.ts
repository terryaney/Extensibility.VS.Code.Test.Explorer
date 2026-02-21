import * as vscode from 'vscode';
import { TestMetadata } from './model';

/**
 * WeakMap to store test metadata associated with TestItem instances.
 * Uses WeakMap to allow TestItems to be garbage collected when no longer referenced.
 */
export const testMetadata = new WeakMap<vscode.TestItem, TestMetadata>();

/**
 * Map to store project paths by test item ID.
 * This allows quick lookup of which project a test belongs to.
 */
export const projectPaths = new Map<string, string>();

/**
 * Sets metadata for a test item.
 * 
 * @param item The test item
 * @param metadata The metadata to associate with the test item
 */
export function setTestMetadata(item: vscode.TestItem, metadata: TestMetadata): void {
    testMetadata.set(item, metadata);
}

/**
 * Gets metadata for a test item.
 * 
 * @param item The test item
 * @returns The metadata or undefined if not found
 */
export function getTestMetadata(item: vscode.TestItem): TestMetadata | undefined {
    return testMetadata.get(item);
}

/**
 * Determines whether a test item should receive run state updates.
 * Leaf runnable items are theory cases and non-theory method leaves.
 *
 * @param item The test item
 * @returns True when the item is a leaf runnable item
 */
export function isLeafRunnableItem(item: vscode.TestItem): boolean {
    const metadata = getTestMetadata(item);
    if (!metadata) {
        return false;
    }

    if (metadata.kind === 'case') {
        return true;
    }

    if (metadata.kind === 'method') {
        if (item.children.size > 0) {
            return false;
        }

        return metadata.isTheory !== true || item.children.size === 0;
    }

    return false;
}

/**
 * Sets the project path for a test item ID.
 * 
 * @param testId The test item ID
 * @param projectPath The project path
 */
export function setProjectPath(testId: string, projectPath: string): void {
    projectPaths.set(testId, projectPath);
}

/**
 * Gets the project path for a test item ID.
 * 
 * @param testId The test item ID
 * @returns The project path or undefined if not found
 */
export function getProjectPath(testId: string): string | undefined {
    return projectPaths.get(testId);
}
