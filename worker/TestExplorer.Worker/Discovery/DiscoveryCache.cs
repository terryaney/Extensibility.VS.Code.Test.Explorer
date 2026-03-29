using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace TestExplorer.Worker.Discovery;

/// <summary>
/// Caches Roslyn compilations and project metadata between discovery requests.
/// Populated on full discovery, updated incrementally on file-scoped discovery.
/// </summary>
public sealed class DiscoveryCache
{
    /// <summary>
    /// Maps absolute file paths to the project path (.csproj) that contains them.
    /// </summary>
    private readonly Dictionary<string, string> _fileToProject = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// Cached compilations keyed by project path.
    /// </summary>
    private readonly Dictionary<string, Compilation> _compilations = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// Cached syntax trees keyed by absolute file path.
    /// </summary>
    private readonly Dictionary<string, SyntaxTree> _syntaxTrees = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// Set of known test project paths (projects that passed the IsTestProject check).
    /// </summary>
    private readonly HashSet<string> _testProjects = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// Previously discovered tests keyed by project path, for computing removed test IDs.
    /// </summary>
    private readonly Dictionary<string, List<DiscoveredTest>> _previousTests = new(StringComparer.OrdinalIgnoreCase);

    public bool HasData => _compilations.Count > 0;

    /// <summary>
    /// Stores a project's compilation and indexes its documents after a full discovery.
    /// </summary>
    public void CacheProject(Project project, Compilation compilation, bool isTestProject)
    {
        var projectPath = project.FilePath;
        if (string.IsNullOrEmpty(projectPath)) return;

        _compilations[projectPath] = compilation;

        if (isTestProject)
        {
            _testProjects.Add(projectPath);
        }

        foreach (var document in project.Documents)
        {
            if (!string.IsNullOrEmpty(document.FilePath))
            {
                _fileToProject[document.FilePath] = projectPath;

                var tree = compilation.SyntaxTrees
                    .FirstOrDefault(t => string.Equals(t.FilePath, document.FilePath, StringComparison.OrdinalIgnoreCase));
                if (tree != null)
                {
                    _syntaxTrees[document.FilePath] = tree;
                }
            }
        }
    }

    /// <summary>
    /// Stores the discovered tests for a project (used to compute removed test IDs on incremental updates).
    /// </summary>
    public void CacheDiscoveredTests(string projectPath, IReadOnlyList<DiscoveredTest> tests)
    {
        _previousTests[projectPath] = new List<DiscoveredTest>(tests);
    }

    /// <summary>
    /// Gets previously discovered tests for a project.
    /// </summary>
    public IReadOnlyList<DiscoveredTest>? GetPreviousTests(string projectPath)
    {
        return _previousTests.TryGetValue(projectPath, out var tests) ? tests : null;
    }

    /// <summary>
    /// Tries to find the project path for a given file.
    /// </summary>
    public bool TryGetProjectPath(string filePath, out string projectPath)
    {
        if (_fileToProject.TryGetValue(filePath, out projectPath!))
        {
            return true;
        }

        // Fallback: scan known projects to find one whose directory contains this file
        foreach (var kvp in _compilations)
        {
            var projectDir = Path.GetDirectoryName(kvp.Key);
            if (!string.IsNullOrEmpty(projectDir) &&
                filePath.StartsWith(projectDir + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            {
                projectPath = kvp.Key;
                _fileToProject[filePath] = projectPath;
                return true;
            }
        }

        projectPath = string.Empty;
        return false;
    }

    /// <summary>
    /// Returns whether the project is a known test project.
    /// </summary>
    public bool IsTestProject(string projectPath)
    {
        return _testProjects.Contains(projectPath);
    }

    /// <summary>
    /// Gets the cached compilation for a project.
    /// </summary>
    public Compilation? GetCompilation(string projectPath)
    {
        return _compilations.TryGetValue(projectPath, out var compilation) ? compilation : null;
    }

    /// <summary>
    /// Gets the cached syntax tree for a file.
    /// </summary>
    public SyntaxTree? GetSyntaxTree(string filePath)
    {
        return _syntaxTrees.TryGetValue(filePath, out var tree) ? tree : null;
    }

    /// <summary>
    /// Replaces the syntax tree for a file and updates the compilation.
    /// Returns the updated compilation.
    /// </summary>
    public Compilation? UpdateFile(string filePath, string newContent)
    {
        if (!TryGetProjectPath(filePath, out var projectPath))
        {
            return null;
        }

        var compilation = GetCompilation(projectPath);
        if (compilation == null)
        {
            return null;
        }

        var oldTree = GetSyntaxTree(filePath);
        var parseOptions = oldTree?.Options as CSharpParseOptions;
        var newTree = CSharpSyntaxTree.ParseText(newContent, options: parseOptions, path: filePath);

        Compilation updatedCompilation;
        if (oldTree != null)
        {
            updatedCompilation = compilation.ReplaceSyntaxTree(oldTree, newTree);
        }
        else
        {
            // New file not previously in compilation — add it
            updatedCompilation = compilation.AddSyntaxTrees(newTree);
            _fileToProject[filePath] = projectPath;
        }

        _compilations[projectPath] = updatedCompilation;
        _syntaxTrees[filePath] = newTree;

        return updatedCompilation;
    }

    /// <summary>
    /// Clears all cached data. Called before a full rediscovery.
    /// </summary>
    public void Clear()
    {
        _fileToProject.Clear();
        _compilations.Clear();
        _syntaxTrees.Clear();
        _testProjects.Clear();
        _previousTests.Clear();
    }
}
