using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Tasks;
using System.Xml.Linq;
using Microsoft.CodeAnalysis;
using TestExplorer.Worker.Discovery;
using TestExplorer.Worker.Protocol;

namespace TestExplorer.Worker
{
    class Program
    {
        private static readonly JsonSerializerOptions JsonOptions = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            WriteIndented = false
        };

        static async Task Main(string[] args)
        {
            Console.Error.WriteLine("TestExplorer.Worker starting...");

            try
            {
                string? line;
                while ((line = Console.ReadLine()) != null)
                {
                    try
                    {
                        await ProcessRequestAsync(line);
                    }
                    catch (Exception ex)
                    {
                        Console.Error.WriteLine($"Error processing request: {ex.Message}");
                        Console.Error.WriteLine(ex.StackTrace);
                        // Send error response if we can't parse the request
                        var errorResponse = new BaseResponse("unknown", false, ex.Message);
                        WriteResponse(errorResponse);
                    }
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"Fatal error: {ex.Message}");
            }

            Console.Error.WriteLine("TestExplorer.Worker exiting...");
        }

        private static async Task ProcessRequestAsync(string line)
        {
            var jsonNode =  JsonSerializer.Deserialize<JsonNode>(line, JsonOptions) ?? throw new InvalidOperationException("Failed to parse JSON");
			var id = jsonNode["id"]?.GetValue<string>() ?? "unknown";
            var type = jsonNode["type"]?.GetValue<string>() ?? "unknown";

            object response = type switch
            {
                "ping" => new PingResponse(id, true, null) { Version = "0.1.0" },
                "discover" => await HandleDiscoverRequestAsync(jsonNode),
                _ => new BaseResponse(id, false, $"Unknown request type: {type}")
            };

            WriteResponse(response);
        }

        private static async Task<DiscoverResponse> HandleDiscoverRequestAsync(JsonNode requestNode)
        {
            var id = requestNode["id"]?.GetValue<string>() ?? "unknown";
            
            try
            {
                // Parse workspace folders from request
                var workspaceFoldersNode = requestNode["workspaceFolders"];
                var workspaceFolders = workspaceFoldersNode?.Deserialize<string[]>(JsonOptions) ?? [];

                if (workspaceFolders.Length == 0)
                {
                    return new DiscoverResponse(id, true, null) { Projects = [] };
                }

                Console.Error.WriteLine($"Discovering projects in {workspaceFolders.Length} workspace folder(s)...");

                // Register MSBuild
                WorkspaceLoader.RegisterMSBuild();

                // Find all projects
                var locator = new ProjectLocator();
                var projectPaths = await locator.FindProjectsAsync(workspaceFolders);
                
                Console.Error.WriteLine($"Found {projectPaths.Count} project(s), filtering for test projects...");

                // Load and filter test projects
                var testProjects = new System.Collections.Generic.List<TestProjectDto>();
                using (var loader = new WorkspaceLoader())
                {
                    foreach (var projectPath in projectPaths)
                    {
                        try
                        {
                            var project = await loader.LoadProjectAsync(projectPath);
                            if (locator.IsTestProject(project))
                            {
                                Console.Error.WriteLine($"  ✓ Test project: {projectPath}");
                                
                                // Discover tests in this project
                                var discovery = new XunitDiscovery();
                                var discoveredTests = await XunitDiscovery.DiscoverTestsAsync( project);

                                Dictionary<string, List<TestCaseDto>>? theoryCasesByMethod = null;
                                var theoryListingAvailable = false;

                                if (discoveredTests.Any(test => test.IsTheory))
                                {
                                    (theoryListingAvailable, theoryCasesByMethod) = await TryListTheoryCasesAsync(projectPath, discoveredTests);
                                }
                                
                                Console.Error.WriteLine($"    Found {discoveredTests.Count} test(s) in {project.Name}");
                                
                                // Build hierarchical DTO
                                var projectDto = BuildProjectDto(project, projectPath, discoveredTests, theoryListingAvailable, theoryCasesByMethod);
                                testProjects.Add(projectDto);
                            }
                            else
                            {
                                Console.Error.WriteLine($"  - Skipped (not a test project): {projectPath}");
                            }
                        }
                        catch (Exception ex)
                        {
                            Console.Error.WriteLine($"  ✗ Error loading {projectPath}: {ex.Message}");
                        }
                    }

                    // Log diagnostics if any
                    if (loader.Diagnostics.Any())
                    {
                        Console.Error.WriteLine($"Workspace diagnostics ({loader.Diagnostics.Count}):");
                        foreach (var diag in loader.Diagnostics.Take(10))
                        {
                            Console.Error.WriteLine($"  {diag.Kind}: {diag.Message}");
                        }
                    }
                }

                Console.Error.WriteLine($"Discovery complete: {testProjects.Count} test project(s) found.");

                return new DiscoverResponse(id, true, null) 
                { 
                    Projects = [ .. testProjects ]
				};
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"Discovery failed: {ex.Message}");
                return new DiscoverResponse(id, false, ex.Message);
            }
        }

        /// <summary>
        /// Builds a TestProjectDto from a list of discovered tests, organizing them into a hierarchy:
        /// Project → Namespace → Class → Method
        /// </summary>
        private static TestProjectDto BuildProjectDto(
            Project project,
            string projectPath,
            IReadOnlyList<DiscoveredTest> tests,
            bool theoryListingAvailable,
            Dictionary<string, List<TestCaseDto>>? theoryCasesByMethod)
        {
            var projectName = Path.GetFileNameWithoutExtension(projectPath);
            var targetFramework = ResolveTargetFramework(project, projectPath);
            
            // Group tests by namespace → class → method
            var namespaceGroups = tests
                .GroupBy(t => ExtractNamespace(t.FullyQualifiedName))
                .OrderBy(g => g.Key);

            var namespaces = new System.Collections.Generic.List<TestNamespaceDto>();

            foreach (var nsGroup in namespaceGroups)
            {
                var namespaceName = nsGroup.Key;
                
                // Group by class within this namespace
                var classGroups = nsGroup
                    .GroupBy(t => ExtractClassName(t.FullyQualifiedName))
                    .OrderBy(g => g.Key);

                var classes = new System.Collections.Generic.List<TestClassDto>();

                foreach (var classGroup in classGroups)
                {
                    var className = classGroup.Key;
                    
                    // Create method DTOs for this class
                    var methods = classGroup
                        .Select(t =>
                        {
                            IReadOnlyList<TestCaseDto>? cases = null;

                            if (t.IsTheory)
                            {
                                if (theoryListingAvailable)
                                {
                                    if (theoryCasesByMethod != null
                                        && theoryCasesByMethod.TryGetValue(t.FullyQualifiedName, out var mappedCases)
                                        && mappedCases.Count > 0)
                                    {
                                        cases = mappedCases;
                                    }
                                    else
                                    {
                                        cases = Array.Empty<TestCaseDto>();
                                    }
                                }
                                else
                                {
                                    cases = null;
                                }
                            }

                            return new TestMethodDto(
                                Id: t.FullyQualifiedName,
                                Name: ExtractMethodName(t.FullyQualifiedName),
                                FullyQualifiedName: t.FullyQualifiedName,
                                Location: new TestLocation(
                                    t.FilePath,
                                    t.StartLine,
                                    t.StartColumn,
                                    t.EndLine,
                                    t.EndColumn),
                                IsTheory: t.IsTheory,
                                Cases: cases);
                        })
                        .OrderBy(m => m.Name)
                        .ToArray();

                    // For class location, use the first method's file path (we don't have class-level location)
                    var classLocation = methods.Length > 0 
                        ? new TestLocation(methods[0].Location.FilePath, 0, 0, 0, 0)
                        : null;

                    classes.Add(new TestClassDto(
                        Name: className,
                        Methods: methods,
                        Location: classLocation));
                }

                namespaces.Add(new TestNamespaceDto(
                    Name: namespaceName,
                    Classes: [ .. classes ] ) );
            }

            return new TestProjectDto(
                Name: projectName,
                ProjectPath: projectPath,
                TargetFramework: targetFramework,
                Namespaces: [ .. namespaces ] );
        }

        private static async Task<(bool ListingAvailable, Dictionary<string, List<TestCaseDto>> CasesByMethod)> TryListTheoryCasesAsync(
            string projectPath,
            IReadOnlyList<DiscoveredTest> discoveredTests)
        {
            var theoryMethods = discoveredTests
                .Where(test => test.IsTheory)
                .Select(test => test.FullyQualifiedName)
                .Distinct(StringComparer.Ordinal)
                .OrderByDescending(name => name.Length)
                .ToArray();

            if (theoryMethods.Length == 0)
            {
                return (false, new Dictionary<string, List<TestCaseDto>>(StringComparer.Ordinal));
            }

            var projectDirectory = Path.GetDirectoryName(projectPath);
            if (string.IsNullOrWhiteSpace(projectDirectory) || !Directory.Exists(projectDirectory))
            {
                Console.Error.WriteLine($"    Warning: Cannot list theory cases; invalid project directory for {projectPath}");
                return (false, new Dictionary<string, List<TestCaseDto>>(StringComparer.Ordinal));
            }

            try
            {
                var startInfo = new ProcessStartInfo
                {
                    FileName = "dotnet",
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WorkingDirectory = projectDirectory
                };

                startInfo.ArgumentList.Add("test");
                startInfo.ArgumentList.Add(projectPath);
                startInfo.ArgumentList.Add("-t");
                startInfo.ArgumentList.Add("--no-build");
                startInfo.ArgumentList.Add("--nologo");

                using var process = new Process { StartInfo = startInfo };
                process.Start();

                var stdoutLines = new List<string>();
                string? stdoutLine;
                while ((stdoutLine = await process.StandardOutput.ReadLineAsync()) != null)
                {
                    stdoutLines.Add(stdoutLine);
                }

                var stderr = await process.StandardError.ReadToEndAsync();
                await process.WaitForExitAsync();

                if (process.ExitCode != 0)
                {
                    Console.Error.WriteLine($"    Warning: dotnet test -t failed for {projectPath} with exit code {process.ExitCode}");
                    if (!string.IsNullOrWhiteSpace(stderr))
                    {
                        Console.Error.WriteLine($"    dotnet test -t stderr: {stderr.Trim()}");
                    }

                    return (false, new Dictionary<string, List<TestCaseDto>>(StringComparer.Ordinal));
                }

                var displayNames = ParseTestCaseDisplayNames(stdoutLines);
                if (displayNames.Count == 0)
                {
                    Console.Error.WriteLine($"    Warning: dotnet test -t produced no usable case list for {projectPath}");
                    return (false, new Dictionary<string, List<TestCaseDto>>(StringComparer.Ordinal));
                }

                var mappedCases = new Dictionary<string, List<TestCaseDto>>(StringComparer.Ordinal);

                foreach (var displayName in displayNames)
                {
                    var matchedMethod = theoryMethods.FirstOrDefault(method =>
                        displayName.StartsWith(method, StringComparison.Ordinal));

                    if (matchedMethod == null)
                    {
                        continue;
                    }

                    if (!mappedCases.TryGetValue(matchedMethod, out var methodCases))
                    {
                        methodCases = [];
                        mappedCases[matchedMethod] = methodCases;
                    }

                    methodCases.Add(new TestCaseDto(
                        FullyQualifiedName: matchedMethod,
                        DisplayName: displayName,
                        IsTheory: true));
                }

                return (true, mappedCases);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"    Warning: Failed to list theory cases for {projectPath}: {ex.Message}");
                return (false, new Dictionary<string, List<TestCaseDto>>(StringComparer.Ordinal));
            }
        }

        private static List<string> ParseTestCaseDisplayNames(IReadOnlyList<string> stdoutLines)
        {
            var displayNames = new List<string>();
            var collecting = false;

            foreach (var line in stdoutLines)
            {
                var trimmed = line?.Trim();
                if (string.IsNullOrWhiteSpace(trimmed))
                {
                    continue;
                }

                if (!collecting)
                {
                    if (trimmed.Contains("available", StringComparison.OrdinalIgnoreCase))
                    {
                        collecting = true;
                        continue;
                    }

                    if (!LooksLikeTestDisplayName(trimmed))
                    {
                        continue;
                    }

                    collecting = true;
                }

                var candidate = NormalizeDisplayName(trimmed);
                if (string.IsNullOrWhiteSpace(candidate) || !LooksLikeTestDisplayName(candidate))
                {
                    continue;
                }

                displayNames.Add(candidate);
            }

            return displayNames;
        }

        private static string NormalizeDisplayName(string value)
        {
            var normalized = value.TrimStart();
            normalized = normalized.TrimStart('-', '*', '•', '>');
            return normalized.Trim();
        }

        private static bool LooksLikeTestDisplayName(string value)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                return false;
            }

            return !value.StartsWith("Build", StringComparison.OrdinalIgnoreCase)
                && !value.StartsWith("Microsoft", StringComparison.OrdinalIgnoreCase)
                && !value.StartsWith("warning", StringComparison.OrdinalIgnoreCase)
                && !value.StartsWith("error", StringComparison.OrdinalIgnoreCase)
                && !value.StartsWith("info", StringComparison.OrdinalIgnoreCase)
                && !value.StartsWith("Determining projects", StringComparison.OrdinalIgnoreCase)
                && !value.StartsWith("Restore", StringComparison.OrdinalIgnoreCase)
                && !value.StartsWith("Test run", StringComparison.OrdinalIgnoreCase)
                && !value.StartsWith("The following Tests are available", StringComparison.OrdinalIgnoreCase);
        }

        private static string ResolveTargetFramework(Project project, string projectPath)
        {
            var fromProjectProperties = TryGetTargetFrameworkFromProjectProperties(project);
            if (!string.IsNullOrWhiteSpace(fromProjectProperties))
            {
                return fromProjectProperties;
            }

            var fromProjectFile = TryGetTargetFrameworkFromProjectFile(projectPath);
            if (!string.IsNullOrWhiteSpace(fromProjectFile))
            {
                return fromProjectFile;
            }

            return string.Empty;
        }

        private static string TryGetTargetFrameworkFromProjectProperties(Project project)
        {
            try
            {
                var globalOptions = project.AnalyzerOptions.AnalyzerConfigOptionsProvider.GlobalOptions;

                if (globalOptions.TryGetValue("build_property.TargetFramework", out var targetFramework)
                    && !string.IsNullOrWhiteSpace(targetFramework))
                {
                    return targetFramework.Trim();
                }

                if (globalOptions.TryGetValue("build_property.TargetFrameworks", out var targetFrameworks)
                    && !string.IsNullOrWhiteSpace(targetFrameworks))
                {
                    return targetFrameworks
                        .Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                        .FirstOrDefault() ?? string.Empty;
                }
            }
            catch
            {
                // Fall through to project file parsing.
            }

            return string.Empty;
        }

        private static string TryGetTargetFrameworkFromProjectFile(string projectPath)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(projectPath) || !File.Exists(projectPath))
                {
                    return string.Empty;
                }

                var projectXml = XDocument.Load(projectPath);

                var targetFramework = projectXml
                    .Descendants()
                    .FirstOrDefault(element => element.Name.LocalName == "TargetFramework")?
                    .Value;

                if (!string.IsNullOrWhiteSpace(targetFramework))
                {
                    return targetFramework.Trim();
                }

                var targetFrameworks = projectXml
                    .Descendants()
                    .FirstOrDefault(element => element.Name.LocalName == "TargetFrameworks")?
                    .Value;

                if (!string.IsNullOrWhiteSpace(targetFrameworks))
                {
                    return targetFrameworks
                        .Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                        .FirstOrDefault() ?? string.Empty;
                }
            }
            catch
            {
                // Return empty when TFM cannot be determined.
            }

            return string.Empty;
        }

        /// <summary>
        /// Extracts the namespace from a fully qualified name.
        /// Example: "MyApp.Tests.MyClass.MyMethod" → "MyApp.Tests"
        /// </summary>
        private static string ExtractNamespace(string fullyQualifiedName)
        {
            var parts = fullyQualifiedName.Split('.');
            if (parts.Length <= 2)
            {
                return string.Empty; // No namespace or only class.method
            }
            
            // Namespace is everything except the last two parts (Class.Method)
            return string.Join(".", parts.Take(parts.Length - 2));
        }

        /// <summary>
        /// Extracts the class name from a fully qualified name.
        /// Example: "MyApp.Tests.MyClass.MyMethod" → "MyClass"
        /// </summary>
        private static string ExtractClassName(string fullyQualifiedName)
        {
            var parts = fullyQualifiedName.Split('.');
            if (parts.Length < 2)
            {
                return fullyQualifiedName; // Fallback
            }
            
            // Class is the second-to-last part
            return parts[^2];
        }

        /// <summary>
        /// Extracts the method name from a fully qualified name.
        /// Example: "MyApp.Tests.MyClass.MyMethod" → "MyMethod"
        /// </summary>
        private static string ExtractMethodName(string fullyQualifiedName)
        {
            var parts = fullyQualifiedName.Split('.');
            
            // Method is the last part
            return parts[^1];
        }

        private static void WriteResponse(object response)
        {
            var json = JsonSerializer.Serialize(response, JsonOptions);
            Console.WriteLine(json);
            Console.Out.Flush();
        }
    }
}
