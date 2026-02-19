import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as readline from 'readline';
import { BaseRequest, BaseResponse, PingRequest, PingResponse } from './protocol';

/**
 * Client for communicating with the .NET TestExplorer worker process via NDJSON protocol
 */
export class WorkerClient {
    private process: cp.ChildProcess | null = null;
    private pendingRequests = new Map<string, {
        resolve: (response: any) => void;
        reject: (error: Error) => void;
    }>();
    private nextRequestId = 1;
    private lineReader: readline.Interface | null = null;

    constructor(private extensionContext: vscode.ExtensionContext) {}

    /**
     * Start the worker process
     */
    async start(): Promise<void> {
        if (this.process) {
            throw new Error('Worker process already started');
        }

        const workerPath = this.resolveWorkerPath();
        console.log(`Starting worker process: ${workerPath}`);

        // Determine if we need to use 'dotnet' or can run the .exe directly
        const isExe = workerPath.endsWith('.exe');
        const command = isExe ? workerPath : 'dotnet';
        const args = isExe ? [] : [workerPath];

        this.process = cp.spawn(command, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: path.dirname(workerPath)
        });

        // Handle process exit
        this.process.on('exit', (code, signal) => {
            console.log(`Worker process exited with code ${code}, signal ${signal}`);
            this.cleanup();
        });

        this.process.on('error', (err) => {
            console.error('Worker process error:', err);
            this.rejectAllPending(new Error(`Worker process error: ${err.message}`));
        });

        // Handle stderr - log to console
        if (this.process.stderr) {
            this.process.stderr.on('data', (data: Buffer) => {
                console.error('Worker stderr:', data.toString());
            });
        }

        // Set up line-by-line reading from stdout
        if (this.process.stdout) {
            this.lineReader = readline.createInterface({
                input: this.process.stdout,
                crlfDelay: Infinity
            });

            this.lineReader.on('line', (line: string) => {
                this.handleOutputLine(line);
            });
        }
    }

    /**
     * Resolve the path to the worker executable
     * Checks production path first (bundled with extension), then falls back to development path
     */
    private resolveWorkerPath(): string {
        const extensionDir = this.extensionContext.extensionPath;
        
        // Production path (bundled with extension)
        const productionDllPath = path.join(extensionDir, 'dist', 'worker', 'TestExplorer.Worker.dll');
        if (fs.existsSync(productionDllPath)) {
            return productionDllPath;
        }

        // Development paths
        const devWorkerBasePath = path.join(extensionDir, '..', 'worker', 'TestExplorer.Worker', 'bin', 'Debug', 'net8.0');
        
        // Try .exe first (Windows, development)
        const devExePath = path.join(devWorkerBasePath, 'TestExplorer.Worker.exe');
        if (fs.existsSync(devExePath)) {
            return devExePath;
        }

        // Fall back to .dll (cross-platform with dotnet, development)
        const devDllPath = path.join(devWorkerBasePath, 'TestExplorer.Worker.dll');
        if (fs.existsSync(devDllPath)) {
            return devDllPath;
        }

        throw new Error(
            `Worker executable not found. Looked for:\n` +
            `  Production: ${productionDllPath}\n` +
            `  Development: ${devExePath}\n` +
            `  Development: ${devDllPath}\n\n` +
            `Please build the worker project first with: npm run build-worker`
        );
    }

    /**
     * Handle a line of output from the worker process
     */
    private handleOutputLine(line: string): void {
        if (!line.trim()) {
            return;
        }

        try {
            const response = JSON.parse(line) as BaseResponse;
            const pending = this.pendingRequests.get(response.id);
            
            if (pending) {
                this.pendingRequests.delete(response.id);
                
                if (response.success) {
                    pending.resolve(response);
                } else {
                    pending.reject(new Error(response.error || 'Unknown error'));
                }
            } else {
                console.warn('Received response for unknown request ID:', response.id);
            }
        } catch (err) {
            console.error('Failed to parse worker output:', line, err);
        }
    }

    /**
     * Send a request to the worker and wait for a response
     */
    async request<TResponse extends BaseResponse>(
        request: BaseRequest,
        abortSignal?: AbortSignal
    ): Promise<TResponse> {
        if (!this.process || !this.process.stdin) {
            throw new Error('Worker process not started');
        }

        // Generate correlation ID if not provided
        if (!request.id) {
            request.id = this.generateRequestId();
        }

        return new Promise<TResponse>((resolve, reject) => {
            // Set up abort handling
            if (abortSignal) {
                if (abortSignal.aborted) {
                    reject(new Error('Request aborted'));
                    return;
                }

                const abortHandler = () => {
                    this.pendingRequests.delete(request.id);
                    reject(new Error('Request aborted'));
                };
                abortSignal.addEventListener('abort', abortHandler, { once: true });
            }

            // Store the pending request
            this.pendingRequests.set(request.id, { resolve, reject });

            // Send the request
            const requestJson = JSON.stringify(request) + '\n';
            this.process!.stdin!.write(requestJson, 'utf8', (err) => {
                if (err) {
                    this.pendingRequests.delete(request.id);
                    reject(new Error(`Failed to write request: ${err.message}`));
                }
            });
        });
    }

    /**
     * Send a ping request to the worker
     */
    async ping(abortSignal?: AbortSignal): Promise<string> {
        const request: PingRequest = {
            id: this.generateRequestId(),
            type: 'ping'
        };

        const response = await this.request<PingResponse>(request, abortSignal);
        return response.payload.version;
    }

    /**
     * Discover tests in the workspace
     */
    async discover(workspaceFolders: string[], abortSignal?: AbortSignal): Promise<import('./protocol').TestProjectDto[]> {
        const request: import('./protocol').DiscoverRequest = {
            id: this.generateRequestId(),
            type: 'discover',
            workspaceFolders
        };

        const response = await this.request<import('./protocol').DiscoverResponse>(request, abortSignal);
        return response.projects;
    }

    /**
     * Generate a unique request ID
     */
    private generateRequestId(): string {
        return `req-${this.nextRequestId++}`;
    }

    /**
     * Reject all pending requests
     */
    private rejectAllPending(error: Error): void {
        Array.from(this.pendingRequests.entries()).forEach(([id, pending]) => {
            pending.reject(error);
        });
        this.pendingRequests.clear();
    }

    /**
     * Clean up resources
     */
    private cleanup(): void {
        this.rejectAllPending(new Error('Worker process terminated'));
        
        if (this.lineReader) {
            this.lineReader.close();
            this.lineReader = null;
        }
        
        this.process = null;
    }

    /**
     * Dispose of the worker process
     */
    dispose(): void {
        if (this.process) {
            console.log('Disposing worker process');
            this.process.kill();
            this.cleanup();
        }
    }
}
