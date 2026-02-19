using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Build.Locator;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.MSBuild;

namespace TestExplorer.Worker.Discovery;

/// <summary>
/// Loads .NET solutions and projects using MSBuildWorkspace and Roslyn APIs.
/// Handles MSBuild locator registration and workspace diagnostic collection.
/// </summary>
public sealed class WorkspaceLoader : IDisposable
{
    private static bool _msbuildRegistered;
    private static readonly object _registrationLock = new();
    private readonly List<WorkspaceDiagnostic> _diagnostics = new();
    private MSBuildWorkspace? _workspace;

    /// <summary>
    /// Gets the collection of diagnostics encountered during workspace operations.
    /// </summary>
    public IReadOnlyList<WorkspaceDiagnostic> Diagnostics => _diagnostics.AsReadOnly();

    /// <summary>
    /// Gets diagnostic messages as a list of formatted strings.
    /// </summary>
    /// <returns>List of diagnostic messages</returns>
    public List<string> GetDiagnostics()
    {
        var messages = new List<string>();
        foreach (var diagnostic in _diagnostics)
        {
            var severity = diagnostic.Kind switch
            {
                WorkspaceDiagnosticKind.Failure => "ERROR",
                WorkspaceDiagnosticKind.Warning => "WARNING",
                _ => "INFO"
            };
            
            messages.Add($"[{severity}] {diagnostic.Message}");
        }
        return messages;
    }

    /// <summary>
    /// Registers MSBuild with the MSBuildLocator.
    /// Must be called before any MSBuild API usage.
    /// This method is thread-safe and ensures registration occurs exactly once.
    /// </summary>
    /// <exception cref="InvalidOperationException">
    /// Thrown if MSBuild cannot be located or if registration fails.
    /// </exception>
    public static void RegisterMSBuild()
    {
        lock (_registrationLock)
        {
            if (_msbuildRegistered)
            {
                return;
            }

            try
            {
                MSBuildLocator.RegisterDefaults();
                _msbuildRegistered = true;
            }
            catch (Exception ex)
            {
                throw new InvalidOperationException(
                    "Failed to register MSBuild. Ensure MSBuild is installed on the system.", 
                    ex);
            }
        }
    }

    /// <summary>
    /// Loads a solution file (.sln) and returns the Roslyn Solution object.
    /// </summary>
    /// <param name="solutionPath">Absolute path to the .sln file.</param>
    /// <param name="cancellationToken">Cancellation token for the operation.</param>
    /// <returns>A task that returns the loaded Solution object.</returns>
    /// <exception cref="ArgumentNullException">Thrown if solutionPath is null or empty.</exception>
    /// <exception cref="FileNotFoundException">Thrown if the solution file does not exist.</exception>
    public async Task<Solution> LoadSolutionAsync(
        string solutionPath, 
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(solutionPath))
        {
            throw new ArgumentNullException(nameof(solutionPath));
        }

        if (!File.Exists(solutionPath))
        {
            throw new FileNotFoundException($"Solution file not found: {solutionPath}", solutionPath);
        }

        EnsureWorkspaceCreated();

        try
        {
            var solution = await _workspace!.OpenSolutionAsync(solutionPath, cancellationToken: cancellationToken);
            return solution;
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException(
                $"Failed to load solution: {solutionPath}. Check diagnostics for details.", 
                ex);
        }
    }

    /// <summary>
    /// Loads a single project file (.csproj, .vbproj, etc.) and returns the Roslyn Project object.
    /// </summary>
    /// <param name="projectPath">Absolute path to the project file.</param>
    /// <param name="cancellationToken">Cancellation token for the operation.</param>
    /// <returns>A task that returns the loaded Project object.</returns>
    /// <exception cref="ArgumentNullException">Thrown if projectPath is null or empty.</exception>
    /// <exception cref="FileNotFoundException">Thrown if the project file does not exist.</exception>
    public async Task<Project> LoadProjectAsync(
        string projectPath, 
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(projectPath))
        {
            throw new ArgumentNullException(nameof(projectPath));
        }

        if (!File.Exists(projectPath))
        {
            throw new FileNotFoundException($"Project file not found: {projectPath}", projectPath);
        }

        EnsureWorkspaceCreated();

        try
        {
            var project = await _workspace!.OpenProjectAsync(projectPath, cancellationToken: cancellationToken);
            return project;
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException(
                $"Failed to load project: {projectPath}. Check diagnostics for details.", 
                ex);
        }
    }

    /// <summary>
    /// Creates the MSBuildWorkspace if not already created and subscribes to diagnostic events.
    /// </summary>
    private void EnsureWorkspaceCreated()
    {
        if (_workspace != null)
        {
            return;
        }

        if (!_msbuildRegistered)
        {
            throw new InvalidOperationException(
                "MSBuild must be registered before creating a workspace. Call RegisterMSBuild() first.");
        }

        _workspace = MSBuildWorkspace.Create();
        _workspace.WorkspaceFailed += OnWorkspaceFailed;
    }

    /// <summary>
    /// Event handler for workspace failures. Collects diagnostics for later inspection.
    /// </summary>
    private void OnWorkspaceFailed(object? sender, WorkspaceDiagnosticEventArgs e)
    {
        _diagnostics.Add(e.Diagnostic);
    }

    /// <summary>
    /// Disposes the workspace and unsubscribes from events.
    /// </summary>
    public void Dispose()
    {
        if (_workspace != null)
        {
            _workspace.WorkspaceFailed -= OnWorkspaceFailed;
            _workspace.Dispose();
            _workspace = null;
        }
    }
}
