using System;

namespace TestExplorer.Worker.Protocol;

public record BaseRequest(string Id, string Type);

public record BaseResponse(string Id, bool Success, string? Error = null);

public record PingRequest(string Id, string Type) : BaseRequest(Id, Type);

public record PingResponse(string Id, bool Success, string? Error = null) : BaseResponse(Id, Success, Error)
{
    public string Version { get; init; } = string.Empty;
}

public record DiscoverRequest(string Id, string Type, string[] WorkspaceFolders) : BaseRequest(Id, Type);

public record DiscoverResponse(string Id, bool Success, string? Error = null) : BaseResponse(Id, Success, Error)
{
    public TestProjectDto[] Projects { get; init; } = Array.Empty<TestProjectDto>();
}
