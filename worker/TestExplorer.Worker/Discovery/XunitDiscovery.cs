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
	private static readonly string[] XunitTestAttributes = [ "Fact", "Theory" ];
	private const string FactAttributeName = "FactAttribute";
    private const string TheoryAttributeName = "TheoryAttribute";
    private const string XunitNamespace = "Xunit";

    /// <summary>
    /// Discovers all xUnit tests in the specified project.
    /// </summary>
    /// <param name="project">The Roslyn project to scan for tests.</param>
    /// <param name="cancellationToken">Cancellation token for the operation.</param>
    /// <returns>Collection of discovered test metadata.</returns>
    public static async Task<IReadOnlyList<DiscoveredTest>> DiscoverTestsAsync(
        Project project,
        CancellationToken cancellationToken = default)
    {
        if (project == null) return Array.Empty<DiscoveredTest>();

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

            var testMethods = FindTestMethods( syntaxRoot, semanticModel, cancellationToken);
            
            foreach (var (methodDeclaration, methodSymbol, isTheory) in testMethods)
            {
                var test = CreateDiscoveredTest(
                    methodDeclaration, 
                    methodSymbol, 
                    document.FilePath ?? string.Empty,
                    project.FilePath ?? string.Empty,
                    isTheory);
                
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
    private static List<(MethodDeclarationSyntax Method, IMethodSymbol Symbol, bool IsTheory)> FindTestMethods(
        SyntaxNode syntaxRoot,
        SemanticModel semanticModel,
        CancellationToken cancellationToken)
    {
        var testMethods = new List<(MethodDeclarationSyntax, IMethodSymbol, bool)>();

        var methodDeclarations = syntaxRoot.DescendantNodes()
            .OfType<MethodDeclarationSyntax>();

        foreach (var methodDeclaration in methodDeclarations)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var (isTest, isTheory) = GetXunitAttributeInfo( methodDeclaration, semanticModel, cancellationToken);
            if (isTest)
            {
                var methodSymbol = semanticModel.GetDeclaredSymbol(methodDeclaration, cancellationToken);
                if (methodSymbol != null)
                {
                    testMethods.Add((methodDeclaration, methodSymbol, isTheory));
                }
            }
        }

        return testMethods;
    }

    /// <summary>
    /// Determines whether a method is an xUnit test and whether it is a theory.
    /// Primary detection uses semantic symbols; raw syntax fallback is used when symbol resolution fails.
    /// </summary>
    private static (bool IsTest, bool IsTheory) GetXunitAttributeInfo(
        MethodDeclarationSyntax methodDeclaration,
        SemanticModel semanticModel,
        CancellationToken cancellationToken)
    {
        if (methodDeclaration.AttributeLists.Count == 0)
        {
            return (false, false);
        }

        var hasFact = false;
        var hasTheory = false;

        foreach (var attributeList in methodDeclaration.AttributeLists)
        {
            foreach (var attribute in attributeList.Attributes)
            {
                cancellationToken.ThrowIfCancellationRequested();

                var symbolInfo = semanticModel.GetSymbolInfo(attribute, cancellationToken);
                var attributeSymbol = symbolInfo.Symbol ?? symbolInfo.CandidateSymbols.FirstOrDefault();
                var attributeType = attributeSymbol?.ContainingType;

                if (attributeType != null
                    && attributeType.ContainingNamespace?.ToDisplayString() == XunitNamespace)
                {
                    if (attributeType.Name == FactAttributeName)
                    {
                        hasFact = true;
                    }

                    if (attributeType.Name == TheoryAttributeName)
                    {
                        hasTheory = true;
                    }

                    if (hasFact || hasTheory)
                    {
                        continue;
                    }
                }

                var attributeName = attribute.Name.ToString();
                if (IsRawAttributeMatch(attributeName, "Fact"))
                {
                    hasFact = true;
                }
                else if (IsRawAttributeMatch(attributeName, "Theory"))
                {
                    hasTheory = true;
                }
            }
        }

        return (hasFact || hasTheory, hasTheory);
    }

    private static bool IsRawAttributeMatch(string attributeName, string expectedShortName)
    {
        if (string.IsNullOrWhiteSpace(attributeName))
        {
            return false;
        }

        var normalized = attributeName.Trim();

        if (normalized.StartsWith("global::", StringComparison.Ordinal))
        {
            normalized = normalized[ "global::".Length.. ];
        }

        var lastSegment = normalized.Split('.').LastOrDefault() ?? normalized;

        return lastSegment == expectedShortName
            || lastSegment == $"{expectedShortName}Attribute";
    }

    /// <summary>
    /// Creates a DiscoveredTest record from method declaration and symbol.
    /// </summary>
    private static DiscoveredTest? CreateDiscoveredTest(
        MethodDeclarationSyntax methodDeclaration,
        IMethodSymbol methodSymbol,
        string filePath,
        string projectPath,
        bool isTheory)
    {
        var fullyQualifiedName = SymbolId.GetFullyQualifiedName(methodSymbol);
        if (string.IsNullOrEmpty(fullyQualifiedName))
        {
            return null;
        }

        var location = GetPreferredMethodStartLocation(methodDeclaration) ?? methodDeclaration.GetLocation();
        if (!location.IsInSource)
        {
            return null;
        }

        var lineSpan = location.GetLineSpan();
        if (!lineSpan.IsValid)
        {
            return null;
        }

        var startLine = lineSpan.StartLinePosition.Line;
        var startColumn = lineSpan.StartLinePosition.Character;

        var endLineSpan = methodDeclaration.GetLocation().GetLineSpan();
        if (!endLineSpan.IsValid)
        {
            return null;
        }

        var endLine = endLineSpan.EndLinePosition.Line;
        var endColumn = endLineSpan.EndLinePosition.Character;

        return new DiscoveredTest(
            FullyQualifiedName: fullyQualifiedName,
            FilePath: filePath,
            StartLine: startLine,
            StartColumn: startColumn,
            EndLine: endLine,
            EndColumn: endColumn,
            ProjectPath: projectPath,
            IsTheory: isTheory);
    }

    private static Location? GetPreferredMethodStartLocation(MethodDeclarationSyntax methodDeclaration)
    {
        if (methodDeclaration.Body != null)
        {
            return methodDeclaration.Body.OpenBraceToken.GetLocation();
        }

        if (methodDeclaration.ExpressionBody != null)
        {
            return methodDeclaration.ExpressionBody.ArrowToken.GetLocation();
        }

        return methodDeclaration.Identifier.GetLocation();
    }
}

/// <summary>
/// Represents a discovered test with its location information.
/// </summary>
/// <param name="FullyQualifiedName">Fully qualified name of the test method (e.g., "MyNamespace.MyClass.MyTestMethod").</param>
/// <param name="FilePath">Absolute path to the source file containing the test.</param>
/// <param name="StartLine">Starting line number (0-indexed).</param>
/// <param name="StartColumn">Starting column number (0-indexed).</param>
/// <param name="EndLine">Ending line number (0-indexed).</param>
/// <param name="EndColumn">Ending column number (0-indexed).</param>
/// <param name="ProjectPath">Absolute path to the project file containing the test.</param>
public record DiscoveredTest(
    string FullyQualifiedName,
    string FilePath,
    int StartLine,
    int StartColumn,
    int EndLine,
    int EndColumn,
    string ProjectPath,
    bool IsTheory);
