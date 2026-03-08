import * as crypto from 'crypto';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { ParsedFileCoverage } from '../results/coberturaParser';

const CONTEXT_KEY = 'test-explorer.hasCachedCoverage';

interface CachedEntry {
    coverage: ParsedFileCoverage;
    /** MD5 of file contents at the time coverage was captured. */
    hash: string;
}

/**
 * Holds the last successful coverage run results with a content hash per file.
 * The hash is only checked when VS Code requests detailed coverage for a specific
 * file (loadDetailedCoverage) — not on every save and not globally at restore time.
 */
export class CoverageCache {
    private readonly cache = new Map<string, CachedEntry>();

    update(fileCoverages: ParsedFileCoverage[], outputChannel: vscode.OutputChannel): void {
        this.cache.clear();

        for (const fc of fileCoverages) {
            const hash = hashFile(fc.uri.fsPath);
            if (hash !== undefined) {
                this.cache.set(fc.uri.toString(), { coverage: fc, hash });
            } else {
                outputChannel.appendLine(`Coverage cache: could not hash ${fc.uri.fsPath}, skipping`);
            }
        }

        void vscode.commands.executeCommand('setContext', CONTEXT_KEY, this.cache.size > 0);
    }

    get entries(): ParsedFileCoverage[] {
        return Array.from(this.cache.values()).map(e => e.coverage);
    }

    get hasEntries(): boolean {
        return this.cache.size > 0;
    }

    /**
     * Returns true if the given file is in the cache and its content has changed
     * since coverage was captured. Call this in loadDetailedCoverage to warn the
     * user before showing potentially stale gutter annotations.
     */
    isStale(uri: vscode.Uri): boolean {
        const entry = this.cache.get(uri.toString());
        if (!entry) { return false; }
        return hashFile(entry.coverage.uri.fsPath) !== entry.hash;
    }

    /** No-op — kept so callers can push this into context.subscriptions. */
    dispose(): void { /* nothing to clean up */ }
}

function hashFile(filePath: string): string | undefined {
    try {
        const contents = fs.readFileSync(filePath);
        return crypto.createHash('md5').update(contents).digest('hex');
    } catch {
        return undefined;
    }
}
