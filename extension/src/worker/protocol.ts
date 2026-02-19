/**
 * NDJSON Protocol Types for TestExplorer Worker Communication
 */

export interface BaseRequest {
    id: string;
    type: string;
}

export interface BaseResponse {
    id: string;
    success: boolean;
    error?: string;
}

export interface PingRequest extends BaseRequest {
    type: 'ping';
}

export interface PingResponse extends BaseResponse {
    payload: {
        version: string;
    };
}

export interface DiscoverRequest extends BaseRequest {
    type: 'discover';
    workspaceFolders: string[];
}

export interface TestLocation {
    filePath: string;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
}

export interface TestMethodDto {
    id: string;
    name: string;
    fullyQualifiedName: string;
    location: TestLocation;
}

export interface TestClassDto {
    name: string;
    methods: TestMethodDto[];
    location: TestLocation | null;
}

export interface TestNamespaceDto {
    name: string;
    classes: TestClassDto[];
}

export interface TestProjectDto {
    name: string;
    projectPath: string;
    namespaces: TestNamespaceDto[];
}

export interface DiscoverResponse extends BaseResponse {
    projects: TestProjectDto[];
}
