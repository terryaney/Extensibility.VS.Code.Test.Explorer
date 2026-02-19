using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace TestExplorer.Worker.Discovery;

/// <summary>
/// Discovers xUnit tests in a project using Roslyn symbol scanning.
/// Supports xUnit v2 and v3 (Fact and Theory attributes).
/// </summary>
public sealed class XunitDiscovery
{
    private static readonly string[] XunitTestAttributes = { "Fact", "Theory" };

    /// <summary>
    /// Discovers all xUnit tests in the specified project.
    /// </summary>
    /// <param name="project">The Roslyn project to scan for tests.</param>
    /// <param name="cancellationToken">Cancellation token for the operation.</param>
    /// <returns>Collection of discovered test metadata.</returns>
    public async Task<IReadOnlyList<DiscoveredTest>> DiscoverTestsAsync(
        Project project,
        CancellationToken cancellationToken = default)
    {
        if (project == null)
        {
            return Array.Empty<DiscoveredTest>();
        }

        var compilation = await project.GetCompilationAsync(cancellationToken);
        if (compilation == null)
        {
            return Array.Empty<DiscoveredTest>();
        }

        var discoveredTests = new List<DiscoveredTest>();

        foreach (var document in project.Documents)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var semanticModel = await document.GetSemanticModelAsync(cancellationToken);
            if (semanticModel == null)
            {
                continue;
            }

            var syntaxRoot = await document.GetSyntaxRootAsync(cancellationToken);
            if (syntaxRoot == null)
            {
                continue;
            }

            var testMethods = FindTestMethods(syntaxRoot, semanticModel, cancellationToken);
            
            foreach (var (methodDeclaration, methodSymbol) in testMethods)
            {
                var test = CreateDiscoveredTest(
                    methodDeclaration, 
                    methodSymbol, 
                    document.FilePath ?? string.Empty,
                    project.FilePath ?? string.Empty);
                
                if (test != null)
                {
                    discoveredTests.Add(test);
                }
            }
        }

        return discoveredTests;
    }

    /// <summary>
    /// Finds all method declarations with xUnit test attributes.
    /// </summary>
    private List<(MethodDeclarationSyntax Method, IMethodSymbol Symbol)> FindTestMethods(
        SyntaxNode syntaxRoot,
        SemanticModel semanticModel,
        CancellationToken cancellationToken)
    {
        var testMethods = new List<(MethodDeclarationSyntax, IMethodSymbol)>();

        var methodDeclarations = syntaxRoot.DescendantNodes()
            .OfType<MethodDeclarationSyntax>();

        foreach (var methodDeclaration in methodDeclarations)
        {
            cancellationToken.ThrowIfCancellationRequested();

            if (HasXunitTestAttribute(methodDeclaration))
            {
                var methodSymbol = semanticModel.GetDeclaredSymbol(methodDeclaration, cancellationToken) as IMethodSymbol;
                if (methodSymbol != null)
                {
                    testMethods.Add((methodDeclaration, methodSymbol));
                }
            }
        }

        return testMethods;
    }

    /// <summary>
    /// Checks if a method has a Fact or Theory attribute (xUnit test).
    /// Detects attributes by name to avoid requiring xUnit assemblies.
    /// </summary>
    private bool HasXunitTestAttribute(MethodDeclarationSyntax methodDeclaration)
    {
        if (methodDeclaration.AttributeLists.Count == 0)
        {
            return false;
        }

        foreach (var attributeList in methodDeclaration.AttributeLists)
        {
            foreach (var attribute in attributeList.Attributes)
            {
                var attributeName = attribute.Name.ToString();
                
                // Handle both "Fact" and "FactAttribute" forms
                foreach (var testAttributeName in XunitTestAttributes)
                {
                    if (attributeName == testAttributeName || 
                        attributeName == $"{testAttributeName}Attribute")
                    {
                        return true;
                    }
                }
            }
        }

        return false;
    }

    /// <summary>
    /// Creates a DiscoveredTest record from method declaration and symbol.
    /// </summary>
    private DiscoveredTest? CreateDiscoveredTest(
        MethodDeclarationSyntax methodDeclaration,
        IMethodSymbol methodSymbol,
        string filePath,
        string projectPath)
    {
        var fullyQualifiedName = SymbolId.GetFullyQualifiedName(methodSymbol);
        if (string.IsNullOrEmpty(fullyQualifiedName))
        {
            return null;
        }

        var location = methodDeclaration.GetLocation();
        if (!location.IsInSource)
        {
            return null;
        }

        var lineSpan = location.GetLineSpan();
        if (!lineSpan.IsValid)
        {
            return null;
        }

        // LinePosition is 0-indexed, convert to 1-indexed for VS Code
        var startLine = lineSpan.StartLinePosition.Line + 1;
        var startColumn = lineSpan.StartLinePosition.Character + 1;
        var endLine = lineSpan.EndLinePosition.Line + 1;
        var endColumn = lineSpan.EndLinePosition.Character + 1;

        return new DiscoveredTest(
            FullyQualifiedName: fullyQualifiedName,
            FilePath: filePath,
            StartLine: startLine,
            StartColumn: startColumn,
            EndLine: endLine,
            EndColumn: endColumn,
            ProjectPath: projectPath);
    }
}

/// <summary>
/// Represents a discovered test with its location information.
/// </summary>
/// <param name="FullyQualifiedName">Fully qualified name of the test method (e.g., "MyNamespace.MyClass.MyTestMethod").</param>
/// <param name="FilePath">Absolute path to the source file containing the test.</param>
/// <param name="StartLine">Starting line number (1-indexed).</param>
/// <param name="StartColumn">Starting column number (1-indexed).</param>
/// <param name="EndLine">Ending line number (1-indexed).</param>
/// <param name="EndColumn">Ending column number (1-indexed).</param>
/// <param name="ProjectPath">Absolute path to the project file containing the test.</param>
public record DiscoveredTest(
    string FullyQualifiedName,
    string FilePath,
    int StartLine,
    int StartColumn,
    int EndLine,
    int EndColumn,
    string ProjectPath);
