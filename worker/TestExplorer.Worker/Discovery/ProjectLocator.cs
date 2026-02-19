using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.CodeAnalysis;

namespace TestExplorer.Worker.Discovery;

/// <summary>
/// Locates and filters .NET projects and solutions in workspace folders.
/// Implements solution-first discovery with recursive project fallback.
/// </summary>
public sealed class ProjectLocator
{
    private static readonly string[] ExcludedFolders = 
    { 
        "node_modules", "bin", "obj", ".git", ".vs", ".vscode" 
    };

    private static readonly string[] TestFrameworkIndicators =
    {
        "Microsoft.NET.Test.Sdk",
        "xunit",
        "nunit",
        "NUnit",
        "MSTest"
    };

    /// <summary>
    /// Finds all .csproj files to scan in the given workspace folders.
    /// Uses solution-first discovery: if .sln exists in root, extracts projects from it.
    /// Otherwise, recursively scans for .csproj files (excluding specified folders).
    /// </summary>
    /// <param name="workspaceFolders">Array of workspace folder paths.</param>
    /// <param name="cancellationToken">Cancellation token for the operation.</param>
    /// <returns>Deduplicated list of absolute .csproj paths.</returns>
    public async Task<List<string>> FindProjectsAsync(
        string[] workspaceFolders, 
        CancellationToken cancellationToken = default)
    {
        if (workspaceFolders == null || workspaceFolders.Length == 0)
        {
            return new List<string>();
        }

        var projectPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var folder in workspaceFolders)
        {
            if (string.IsNullOrWhiteSpace(folder) || !Directory.Exists(folder))
            {
                continue;
            }

            cancellationToken.ThrowIfCancellationRequested();

            // Look for .sln files in the root (non-recursive)
            var solutionFiles = Directory.GetFiles(folder, "*.sln", SearchOption.TopDirectoryOnly);

            if (solutionFiles.Length > 0)
            {
                // Solution-first: extract projects from solutions
                foreach (var slnFile in solutionFiles)
                {
                    try
                    {
                        var projects = await ExtractProjectPathsFromSolutionAsync(slnFile, cancellationToken);
                        foreach (var proj in projects)
                        {
                            projectPaths.Add(proj);
                        }
                    }
                    catch (Exception ex)
                    {
                        Console.Error.WriteLine($"Warning: Failed to parse solution {slnFile}: {ex.Message}");
                    }
                }
            }
            else
            {
                // Fallback: recursive .csproj scan
                var projects = FindProjectsRecursive(folder);
                foreach (var proj in projects)
                {
                    projectPaths.Add(proj);
                }
            }
        }

        return projectPaths.ToList();
    }

    /// <summary>
    /// Determines if a project is a test project by checking for test framework references.
    /// </summary>
    /// <param name="project">The Roslyn Project object to check.</param>
    /// <returns>True if the project references a test framework; otherwise false.</returns>
    public bool IsTestProject(Project project)
    {
        if (project == null)
        {
            return false;
        }

        // Check metadata references (compiled DLLs)
        foreach (var metadataRef in project.MetadataReferences)
        {
            var display = metadataRef.Display;
            if (display != null && ContainsTestFrameworkIndicator(display))
            {
                return true;
            }
        }

        // Check project references (other projects in solution)
        // If a referenced project is a test framework, this is likely a test project
        foreach (var projectRef in project.ProjectReferences)
        {
            var referencedProject = project.Solution.GetProject(projectRef.ProjectId);
            if (referencedProject != null && ContainsTestFrameworkIndicator(referencedProject.Name))
            {
                return true;
            }
        }

        // Fallback: check the .csproj file directly for PackageReference
        if (!string.IsNullOrEmpty(project.FilePath) && File.Exists(project.FilePath))
        {
            try
            {
                var csprojContent = File.ReadAllText(project.FilePath);
                if (ContainsTestFrameworkIndicator(csprojContent))
                {
                    return true;
                }
            }
            catch
            {
                // If we can't read the file, assume it's not a test project
            }
        }

        return false;
    }

    /// <summary>
    /// Extracts project paths from a solution file.
    /// Parses the .sln file to find Project(...) entries and resolves their absolute paths.
    /// </summary>
    private async Task<List<string>> ExtractProjectPathsFromSolutionAsync(
        string solutionPath, 
        CancellationToken cancellationToken)
    {
        var projectPaths = new List<string>();
        var solutionDir = Path.GetDirectoryName(solutionPath);
        
        if (string.IsNullOrEmpty(solutionDir))
        {
            return projectPaths;
        }

        var lines = await File.ReadAllLinesAsync(solutionPath, cancellationToken);

        foreach (var line in lines)
        {
            // Solution file format: Project("{GUID}") = "ProjectName", "RelativePath\Project.csproj", "{GUID}"
            if (line.TrimStart().StartsWith("Project(", StringComparison.Ordinal))
            {
                var parts = line.Split(new[] { '"' }, StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length >= 4)
                {
                    var relativePath = parts[3].Trim();
                    
                    // Only include C# projects
                    if (relativePath.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase))
                    {
                        var absolutePath = Path.GetFullPath(Path.Combine(solutionDir, relativePath));
                        if (File.Exists(absolutePath))
                        {
                            projectPaths.Add(absolutePath);
                        }
                    }
                }
            }
        }

        return projectPaths;
    }

    /// <summary>
    /// Recursively finds all .csproj files in a folder, excluding specified folders.
    /// </summary>
    private List<string> FindProjectsRecursive(string folderPath)
    {
        var projects = new List<string>();
        
        try
        {
            // Find .csproj files in current directory
            foreach (var projectFile in Directory.GetFiles(folderPath, "*.csproj"))
            {
                projects.Add(Path.GetFullPath(projectFile));
            }

            // Recurse into subdirectories (excluding blacklisted folders)
            foreach (var subDir in Directory.GetDirectories(folderPath))
            {
                var dirName = Path.GetFileName(subDir);
                if (!ExcludedFolders.Contains(dirName, StringComparer.OrdinalIgnoreCase))
                {
                    projects.AddRange(FindProjectsRecursive(subDir));
                }
            }
        }
        catch (UnauthorizedAccessException)
        {
            // Skip folders we don't have access to
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"Warning: Error scanning {folderPath}: {ex.Message}");
        }

        return projects;
    }

    /// <summary>
    /// Checks if a string contains any test framework indicator.
    /// </summary>
    private bool ContainsTestFrameworkIndicator(string text)
    {
        return TestFrameworkIndicators.Any(indicator => 
            text.Contains(indicator, StringComparison.OrdinalIgnoreCase));
    }
}
