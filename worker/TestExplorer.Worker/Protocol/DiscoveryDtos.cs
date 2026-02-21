using System.Collections.Generic;

namespace TestExplorer.Worker.Protocol;

/// <summary>
/// Represents a test location in source code.
/// </summary>
/// <param name="FilePath">Absolute path to the source file.</param>
/// <param name="StartLine">Starting line number (0-indexed).</param>
/// <param name="StartColumn">Starting column number (0-indexed).</param>
/// <param name="EndLine">Ending line number (0-indexed).</param>
/// <param name="EndColumn">Ending column number (0-indexed).</param>
public record TestLocation(
    string FilePath,
    int StartLine,
    int StartColumn,
    int EndLine,
    int EndColumn);

/// <summary>
/// Represents an individual discovered test case, typically a theory data row.
/// </summary>
/// <param name="FullyQualifiedName">Fully qualified name of the parent test method.</param>
/// <param name="DisplayName">Display name emitted by the test platform.</param>
/// <param name="IsTheory">Indicates the case belongs to a theory test.</param>
public record TestCaseDto(
    string FullyQualifiedName,
    string DisplayName,
    bool IsTheory);

/// <summary>
/// Represents a test method.
/// </summary>
/// <param name="Id">Unique identifier (typically the FullyQualifiedName).</param>
/// <param name="Name">Simple method name (e.g., "MyTestMethod").</param>
/// <param name="FullyQualifiedName">Fully qualified name (e.g., "MyNamespace.MyClass.MyTestMethod").</param>
/// <param name="Location">Source location of the test method.</param>
/// <param name="IsTheory">Indicates whether the method is an xUnit theory.</param>
/// <param name="Cases">Optional discovered theory cases. Null for non-theory or unavailable listing.</param>
public record TestMethodDto(
    string Id,
    string Name,
    string FullyQualifiedName,
    TestLocation Location,
    bool IsTheory,
    IReadOnlyList<TestCaseDto>? Cases);

/// <summary>
/// Represents a test class containing test methods.
/// </summary>
/// <param name="Name">Simple class name (e.g., "MyClass").</param>
/// <param name="Methods">Array of test methods in this class.</param>
/// <param name="Location">Optional source location of the class (may be null for classes inferred from namespaces).</param>
public record TestClassDto(
    string Name,
    TestMethodDto[] Methods,
    TestLocation? Location);

/// <summary>
/// Represents a namespace containing test classes.
/// </summary>
/// <param name="Name">Namespace name (e.g., "MyNamespace" or "MyNamespace.SubNamespace").</param>
/// <param name="Classes">Array of test classes in this namespace.</param>
public record TestNamespaceDto(
    string Name,
    TestClassDto[] Classes);

/// <summary>
/// Represents a test project containing namespaces, classes, and tests.
/// </summary>
/// <param name="Name">Simple project name (without path or extension).</param>
/// <param name="ProjectPath">Absolute path to the project file.</param>
/// <param name="TargetFramework">Target framework moniker (for example, "net8.0"). Empty when not determinable.</param>
/// <param name="Namespaces">Array of namespaces in this project.</param>
public record TestProjectDto(
    string Name,
    string ProjectPath,
    string TargetFramework,
    TestNamespaceDto[] Namespaces);
