import * as vscode from 'vscode';
import { getTestMetadata } from './testItemStore';

/**
 * Builds a VSTest filter expression from an array of test items.
 * 
 * For individual test methods, uses: FullyQualifiedName=<exact.name>
 * For containers (class/namespace), uses: FullyQualifiedName~<prefix>
 * Multiple tests are joined with | (OR operator)
 * 
 * @param tests Array of test items to include in filter
 * @returns VSTest filter expression
 * 
 * @example
 * // Single test: FullyQualifiedName=MyNamespace.MyClass.MyMethod
 * // Multiple tests: FullyQualifiedName=Test1|FullyQualifiedName=Test2
 * // Container: FullyQualifiedName~MyNamespace.MyClass
 */
export function buildVSTestFilter(tests: vscode.TestItem[]): string {
    const filterParts: string[] = [];

    for (const item of tests) {
        const metadata = getTestMetadata(item);
        
        if (!metadata) {
            // No metadata means this is a project, namespace, or class node.
            // ID formats:
            //   project:   projectPath                         (1 segment, no |)
            //   namespace: projectPath|ns|namespaceName        (3 segments)
            //   class:     projectPath|cls|namespace.ClassName (3 segments)
            const parts = item.id.split('|');
            if (parts.length === 3 && (parts[1] === 'cls' || parts[1] === 'ns') && parts[2]) {
                // Container node — use contains operator against the FQN
                const fqn = encodeFilterValue(parts[2]);
                filterParts.push(`FullyQualifiedName~${fqn}`);
            }
            // Single-segment (project) node → shouldRunAll handles this; no filter pushed here.
        } else {
            // Leaf node (test method) - use exact match
            const fqn = encodeFilterValue(metadata.fullyQualifiedName);

            if (metadata.kind === 'case') {
                const displayName = metadata.displayName ?? item.label;
                const encodedDisplayName = encodeDisplayNameFilterValue(displayName);
                filterParts.push(`(FullyQualifiedName=${fqn}&DisplayName=${encodedDisplayName})`);
            } else {
                filterParts.push(`FullyQualifiedName=${fqn}`);
            }
        }
    }

    return filterParts.join('|');
}

/**
 * Encodes special characters in test names for VSTest filter expressions.
 * Commas in generic types need to be URL encoded as %2C.
 * Other special characters may also need encoding.
 * 
 * @param value The value to encode
 * @returns Encoded value suitable for VSTest filter
 */
function encodeFilterValue(value: string): string {
    // Replace commas with %2C (for generic types like Dictionary<int,string>)
    let encoded = value.replace(/,/g, '%2C');
    
    // URL encode other special characters that might appear in test names
    // Note: VSTest filter is sensitive to parentheses, quotes, etc.
    // We need to be careful not to over-encode since VSTest has specific requirements
    // For now, focus on commas which are common in generics
    
    return encoded;
}

/**
 * Encodes xUnit DisplayName values for VSTest filters.
 *
 * dotnet test expects Name/DisplayName special characters to be URL encoded.
 * We additionally preserve the existing VSTest operator escaping for grouping
 * and logical characters that can appear in theory data.
 */
function encodeDisplayNameFilterValue(value: string): string {
    return value
        .replace(/%/g, '%25')
        .replace(/"/g, '%22')
        .replace(/,/g, '%2C')
        .replace(/\\/g, '\\\\')
        .replace(/\(/g, '\\(')
        .replace(/\)/g, '\\)')
        .replace(/\|/g, '\\|')
        .replace(/&/g, '\\&')
        .replace(/=/g, '\\=')
        .replace(/!/g, '\\!')
        .replace(/~/g, '\\~');
}

/**
 * Determines if a test item represents running all tests in a project.
 * Returns true if the item is a project node (no metadata and no fully qualified name).
 * 
 * @param item The test item to check
 * @returns True if all tests should be run (no filter), false if a filter should be used
 */
export function shouldRunAll(item: vscode.TestItem): boolean {
    // Check if this is a project node (ID is just a path, no | separator)
    const hasMetadata = getTestMetadata(item) !== undefined;
    const hasFqnInId = item.id.includes('|');
    
    // If it has no metadata and no | in the ID, it's a project node
    return !hasMetadata && !hasFqnInId;
}
