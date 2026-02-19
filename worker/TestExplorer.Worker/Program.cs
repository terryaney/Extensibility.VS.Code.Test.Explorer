using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Tasks;
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
            var jsonNode = JsonSerializer.Deserialize<JsonNode>(line, JsonOptions);
            if (jsonNode == null)
            {
                throw new InvalidOperationException("Failed to parse JSON");
            }

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
                var workspaceFolders = workspaceFoldersNode?.Deserialize<string[]>(JsonOptions) ?? Array.Empty<string>();

                if (workspaceFolders.Length == 0)
                {
                    return new DiscoverResponse(id, true, null) { Projects = Array.Empty<TestProjectDto>() };
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
                                var discoveredTests = await discovery.DiscoverTestsAsync(project);
                                
                                Console.Error.WriteLine($"    Found {discoveredTests.Count} test(s) in {project.Name}");
                                
                                // Build hierarchical DTO
                                var projectDto = BuildProjectDto(projectPath, discoveredTests);
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
                    Projects = testProjects.ToArray() 
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
            string projectPath,
            IReadOnlyList<DiscoveredTest> tests)
        {
            var projectName = System.IO.Path.GetFileNameWithoutExtension(projectPath);
            
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
                        .Select(t => new TestMethodDto(
                            Id: t.FullyQualifiedName,
                            Name: ExtractMethodName(t.FullyQualifiedName),
                            FullyQualifiedName: t.FullyQualifiedName,
                            Location: new TestLocation(
                                t.FilePath,
                                t.StartLine,
                                t.StartColumn,
                                t.EndLine,
                                t.EndColumn)))
                        .OrderBy(m => m.Name)
                        .ToArray();

                    // For class location, use the first method's file path (we don't have class-level location)
                    TestLocation? classLocation = methods.Length > 0 
                        ? new TestLocation(methods[0].Location.FilePath, 0, 0, 0, 0)
                        : null;

                    classes.Add(new TestClassDto(
                        Name: className,
                        Methods: methods,
                        Location: classLocation));
                }

                namespaces.Add(new TestNamespaceDto(
                    Name: namespaceName,
                    Classes: classes.ToArray()));
            }

            return new TestProjectDto(
                Name: projectName,
                ProjectPath: projectPath,
                Namespaces: namespaces.ToArray());
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
