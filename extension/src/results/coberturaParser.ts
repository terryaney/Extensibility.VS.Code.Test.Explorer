import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { XMLParser } from 'fast-xml-parser';

/**
 * Per-file coverage data parsed from a Cobertura XML file.
 */
export interface ParsedFileCoverage {
    uri: vscode.Uri;
    statementCoverage: vscode.TestCoverageCount;
    branchCoverage?: vscode.TestCoverageCount;
    details: vscode.FileCoverageDetail[];
}

/**
 * Parses a Cobertura XML coverage file and returns per-file coverage data.
 *
 * @param coberturaPath Absolute path to the coverage.cobertura.xml file
 * @returns Array of per-file coverage data
 */
interface RawLineData {
    hits: number;
    isBranch: boolean;
    conditions: Array<{ coverage: string }>;
}

export function parseCoberturaFile(coberturaPath: string): ParsedFileCoverage[] {
    const xmlContent = fs.readFileSync(coberturaPath, 'utf-8');

    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        textNodeName: '#text',
        parseAttributeValue: false,
        trimValues: true
    });

    const parsed = parser.parse(xmlContent);
    const coverage = parsed.coverage;
    if (!coverage) {
        return [];
    }

    // Collect <source> roots for resolving relative filenames
    const sourceRoots: string[] = [];
    if (coverage.sources?.source) {
        const raw = coverage.sources.source;
        const sources: string[] = Array.isArray(raw) ? raw : [raw];
        sourceRoots.push(...sources.map((s: string) => s.trim()).filter(Boolean));
    }

    // First pass: accumulate raw line data per file, merging across multiple classes.
    // A file with ClassA and ClassB will have two <class> entries. The same line can
    // appear in both — we take the max hit count so a line covered by either class
    // is correctly reported as covered.
    const rawFileMap = new Map<string, Map<number, RawLineData>>();

    let packages = coverage.packages?.package;
    if (!packages) { return []; }
    if (!Array.isArray(packages)) { packages = [packages]; }

    for (const pkg of packages) {
        let classes = pkg.classes?.class;
        if (!classes) { continue; }
        if (!Array.isArray(classes)) { classes = [classes]; }

        for (const cls of classes) {
            const filename: string = cls['@_filename'];
            if (!filename) { continue; }

            const absolutePath = resolveFilePath(filename, sourceRoots);
            const uriString = vscode.Uri.file(absolutePath).toString();

            if (!rawFileMap.has(uriString)) {
                rawFileMap.set(uriString, new Map<number, RawLineData>());
            }
            const lineMap = rawFileMap.get(uriString)!;

            let lines = cls.lines?.line;
            if (!lines) { continue; }
            if (!Array.isArray(lines)) { lines = [lines]; }

            for (const line of lines) {
                const lineNumber = parseInt(line['@_number'], 10);
                const hits = parseInt(line['@_hits'], 10);
                const isBranch = line['@_branch'] === 'True';

                if (isNaN(lineNumber) || lineNumber < 1) { continue; }

                const existing = lineMap.get(lineNumber);
                if (!existing) {
                    const conditions: Array<{ coverage: string }> = [];
                    if (isBranch && line.conditions?.condition) {
                        let raw = line.conditions.condition;
                        if (!Array.isArray(raw)) { raw = [raw]; }
                        for (const cond of raw) {
                            conditions.push({ coverage: cond['@_coverage'] ?? '0%' });
                        }
                    }
                    lineMap.set(lineNumber, { hits, isBranch, conditions });
                } else {
                    // Same line in a second class — keep the higher hit count
                    existing.hits = Math.max(existing.hits, hits);
                }
            }
        }
    }

    // Second pass: build FileCoverage from the merged per-line data
    const results: ParsedFileCoverage[] = [];

    for (const [uriString, lineMap] of rawFileMap) {
        let stmtCovered = 0;
        let stmtTotal = 0;
        let branchCovered = 0;
        let branchTotal = 0;
        const details: vscode.FileCoverageDetail[] = [];

        for (const [lineNumber, data] of lineMap) {
            stmtTotal++;
            if (data.hits > 0) { stmtCovered++; }

            const branches: vscode.BranchCoverage[] = [];
            if (data.isBranch) {
                for (const cond of data.conditions) {
                    const pct = parseFloat(cond.coverage);
                    const condExecuted = !isNaN(pct) && pct > 0;
                    branchTotal++;
                    if (condExecuted) { branchCovered++; }
                    branches.push(new vscode.BranchCoverage(
                        condExecuted,
                        new vscode.Position(lineNumber - 1, 0)
                    ));
                }
            }

            details.push(new vscode.StatementCoverage(
                data.hits,
                new vscode.Position(lineNumber - 1, 0),
                branches
            ));
        }

        results.push({
            uri: vscode.Uri.parse(uriString),
            statementCoverage: new vscode.TestCoverageCount(stmtCovered, stmtTotal),
            branchCoverage: branchTotal > 0
                ? new vscode.TestCoverageCount(branchCovered, branchTotal)
                : undefined,
            details
        });
    }

    return results;
}

/**
 * Resolves a possibly-relative filename to an absolute path using source roots.
 */
function resolveFilePath(filename: string, sourceRoots: string[]): string {
    if (path.isAbsolute(filename)) {
        return filename;
    }

    for (const root of sourceRoots) {
        const candidate = path.join(root, filename);
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    // Return as-is if we can't resolve it
    return filename;
}
