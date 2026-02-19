using Microsoft.CodeAnalysis;

namespace TestExplorer.Worker.Discovery;

/// <summary>
/// Provides methods for generating fully qualified names from Roslyn symbols.
/// </summary>
public static class SymbolId
{
    private static readonly SymbolDisplayFormat FullyQualifiedFormat = new(
        globalNamespaceStyle: SymbolDisplayGlobalNamespaceStyle.Omitted,
        typeQualificationStyle: SymbolDisplayTypeQualificationStyle.NameAndContainingTypesAndNamespaces,
        genericsOptions: SymbolDisplayGenericsOptions.IncludeTypeParameters,
        memberOptions: SymbolDisplayMemberOptions.IncludeContainingType,
        parameterOptions: SymbolDisplayParameterOptions.None,
        miscellaneousOptions: SymbolDisplayMiscellaneousOptions.EscapeKeywordIdentifiers |
                               SymbolDisplayMiscellaneousOptions.UseSpecialTypes);

    /// <summary>
    /// Gets the fully qualified name for a symbol.
    /// Handles nested classes and generic types correctly.
    /// </summary>
    /// <param name="symbol">The symbol to get the fully qualified name for.</param>
    /// <returns>Fully qualified name (e.g., "MyNamespace.MyClass.MyMethod" or "MyNamespace.MyClass&lt;T&gt;.MyMethod").</returns>
    public static string GetFullyQualifiedName(ISymbol symbol)
    {
        if (symbol == null)
        {
            return string.Empty;
        }

        return symbol.ToDisplayString(FullyQualifiedFormat);
    }
}
