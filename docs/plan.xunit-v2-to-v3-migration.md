# xUnit v2 → v3 Migration Plan

**Source version:** xUnit 2.9.3  
**Target version:** xUnit v3 (xunit.v3 3.2.2)  
**Scope:** xUnit-related packages only. FluentAssertions 7.1.0 is **not touched**.

---

## 1. Package Changes

### Remove

| Package | Reason |
|---------|--------|
| `xunit` 2.9.3 | Replaced by `xunit.v3` |
| `xunit.abstractions` | No longer needed; the runner is now in-process |

### Add / Replace

| Old Package | New Package | Version |
|-------------|-------------|---------|
| `xunit` 2.9.3 | `xunit.v3` | **3.2.2** |
| _(none)_ | _(xunit.analyzers pulled in transitively)_ | via `xunit.v3` |

### Unchanged (keep as-is)

| Package | Version | Notes |
|---------|---------|-------|
| `xunit.runner.visualstudio` | 3.1.5 | Already on 3.x — compatible with v3 core |
| `Microsoft.NET.Test.Sdk` | 18.0.1 | No change required |
| `coverlet.msbuild` | 6.0.4 | No change required |
| `FluentAssertions` | 7.1.0 | **Do not change** |

### Final `.csproj` package references

```xml
<PackageReference Include="xunit.v3" Version="3.2.2" />
<PackageReference Include="xunit.runner.visualstudio" Version="3.1.5" />
<PackageReference Include="Microsoft.NET.Test.Sdk" Version="18.0.1" />
<PackageReference Include="coverlet.msbuild" Version="6.0.4" />
<PackageReference Include="FluentAssertions" Version="7.1.0" />
```

---

## 2. Project File Changes

### Required: Change `OutputType` to `Exe`

xUnit v3 test projects are stand-alone executables. The `OutputType` must be changed:

```xml
<PropertyGroup>
  <OutputType>Exe</OutputType>   <!-- was Library, or absent -->
  <TargetFramework>net8.0</TargetFramework>
</PropertyGroup>
```

> **`xunit.v3.core`** (pulled in by `xunit.v3`) injects the entry point via MSBuild.  
> You do **not** write a `Main` method — the package handles it.

### Required: Target framework

Minimum supported frameworks in v3:
- .NET 8 (or later)
- .NET Framework 4.7.2 (or later)

If currently targeting `net6.0` or `net7.0`, update to `net8.0`.

---

## 3. Breaking API Changes

### 3.1 `IAsyncLifetime` — **High impact**

In v2, `IAsyncLifetime` defined its own `DisposeAsync()` returning `Task`.  
In v3, `IAsyncLifetime` inherits from `IAsyncDisposable`, and both methods return `ValueTask`.

| v2 signature | v3 signature |
|---|---|
| `Task InitializeAsync()` | `ValueTask InitializeAsync()` |
| `Task DisposeAsync()` (own definition) | `ValueTask DisposeAsync()` (from `IAsyncDisposable`) |

**Code change required:**

```csharp
// v2
public class MyFixture : IAsyncLifetime
{
    public Task InitializeAsync() { ... }
    public Task DisposeAsync() { ... }
}

// v3
public class MyFixture : IAsyncLifetime
{
    public ValueTask InitializeAsync() { ... }
    public ValueTask DisposeAsync() { ... }
}
```

**Disposal rule change:** In v2, if a class implemented both `IAsyncLifetime` and `IDisposable`, xUnit called **both** `DisposeAsync` and `Dispose`. In v3, when an object implements both `IAsyncDisposable` and `IDisposable`, xUnit calls **only** `DisposeAsync`. If you relied on `Dispose` also running, consolidate cleanup into `DisposeAsync`.

---

### 3.2 `async void` tests — **Breaking at runtime**

`async void` test methods are no longer supported and will **fail fast at runtime**.

```csharp
// v2 (worked, but was unreliable)
[Fact]
public async void MyTest() { ... }

// v3 — must use Task or ValueTask
[Fact]
public async Task MyTest() { ... }

// v3 — ValueTask also accepted
[Fact]
public async ValueTask MyTest() { ... }
```

Search for `async void` in test files and update all occurrences.

---

### 3.3 `ITestOutputHelper` namespace change

| v2 | v3 |
|---|---|
| `using Xunit.Abstractions;` | `using Xunit;` |
| `Xunit.Abstractions.ITestOutputHelper` | `Xunit.ITestOutputHelper` |

The interface and constructor injection pattern are otherwise identical:

```csharp
// v3 — only the using changes
using Xunit;

public class MyTests(ITestOutputHelper output)
{
    [Fact]
    public void SomeTest()
    {
        output.WriteLine("still works the same");
    }
}
```

---

### 3.4 `PropertyDataAttribute` removed

`PropertyDataAttribute` was deprecated in v2 and is fully removed in v3.  
Replace with `MemberDataAttribute`:

```csharp
// v2
[Theory]
[PropertyData("MyData")]
public void Test(int x) { ... }

// v3
[Theory]
[MemberData(nameof(MyData))]
public void Test(int x) { ... }
```

---

### 3.5 `AssemblyTraitAttribute` removed

`AssemblyTraitAttribute` is removed. Use `TraitAttribute` directly on the assembly:

```csharp
// v2
[assembly: AssemblyTrait("Category", "Integration")]

// v3
[assembly: Trait("Category", "Integration")]
```

---

### 3.6 Attributes that took type name + assembly name strings

Several attributes that previously accepted `(string typeName, string assemblyName)` now require `typeof(...)`:

Affected attributes:
- `CollectionBehaviorAttribute`
- `TestCaseOrdererAttribute`
- `TestCollectionOrdererAttribute`
- `TestFrameworkAttribute`

```csharp
// v2
[assembly: CollectionBehavior("MyNamespace.MyFactory", "MyAssembly")]
[assembly: TestCaseOrderer("MyNamespace.MyOrderer", "MyAssembly")]

// v3
[assembly: CollectionBehavior(typeof(MyFactory))]
[assembly: TestCaseOrderer(typeof(MyOrderer))]
```

---

## 4. Test Base Class and Trait Changes

### `IClassFixture<T>` / `ICollectionFixture<T>`

Unchanged. Same pattern works in v3.

### `[Collection]` and `[CollectionDefinition]`

Unchanged.

### `[Trait]`

Unchanged. Additionally, `[Trait]` can now be applied at the assembly level (replaces the removed `AssemblyTraitAttribute`).

### Custom `ITestCaseOrderer` / `ITestCollectionOrderer`

If you have custom orderers, their interface locations changed:
- `ITestCaseOrderer` moved from `Xunit.Sdk` → `Xunit.v3`
- `ITestCollectionOrderer` moved from `Xunit` → `Xunit.v3`
- `OrderTestCases` now accepts and returns `IReadOnlyCollection<TTestCase>` instead of `IEnumerable<TTestCase>`

---

## 5. Async Test Changes Summary

| Scenario | v2 | v3 |
|---|---|---|
| `async void` test | Ran (unreliably) | **Fails fast at runtime** |
| `async Task` test | Supported | Supported (unchanged) |
| `async ValueTask` test | Not fully supported | **Fully supported** |
| `IAsyncLifetime.InitializeAsync` return type | `Task` | `ValueTask` |
| `IAsyncLifetime.DisposeAsync` return type | `Task` | `ValueTask` |
| `Record.ExceptionAsync` | Accepted `Task` lambdas | Accepts `Task` and `ValueTask` lambdas |

---

## 6. `ITestOutputHelper` Changes

No behavioral changes — injection and usage are identical. **Only the namespace changes** (see §3.3 above).

---

## 7. Assertion Library Changes

The v3 assertion library is a **superset** of v2 2.9. Existing `Assert.*` calls should compile and behave identically.

Potential issues:
- New overloads introduced in v3 may create **ambiguous overload** compiler errors if you have extension methods on `Assert` that conflict with new built-in overloads. Resolve by qualifying or renaming the conflicting methods.
- `FluentAssertions` is not affected — it does not depend on the xUnit assertion library.

---

## 8. What Stays the Same

- `[Fact]`, `[Theory]`, `[InlineData]`, `[MemberData]`, `[ClassData]` — **unchanged**
- `[Skip]` parameter on `[Fact]`/`[Theory]` — **unchanged**
- `[Collection]`, `[CollectionDefinition]`, `IClassFixture<T>`, `ICollectionFixture<T>` — **unchanged**
- `[Trait]` — **unchanged** (plus new assembly-level support)
- `Assert.*` methods — **unchanged** (v3 is a superset)
- `ITestOutputHelper` usage (constructor injection) — **unchanged** (namespace only)
- `xunit.runner.visualstudio` runner — **already on 3.x**, no action required
- `dotnet test` and VS Test Explorer integration — **unchanged**
- `FluentAssertions` — **not touched**

---

## 9. Migration Checklist

- [ ] Replace `<PackageReference Include="xunit" Version="2.9.3" />` with `<PackageReference Include="xunit.v3" Version="3.2.2" />`
- [ ] Remove any reference to `xunit.abstractions`
- [ ] Add/update `<OutputType>Exe</OutputType>` in the test project's `<PropertyGroup>`
- [ ] Verify target framework is `net8.0` (or `net472` for .NET Framework projects)
- [ ] Update `IAsyncLifetime` implementations: change `Task` return types to `ValueTask`
- [ ] Confirm disposal: if previously relying on both `DisposeAsync` + `Dispose` being called, consolidate into `DisposeAsync`
- [ ] Replace all `async void` test methods with `async Task` or `async ValueTask`
- [ ] Replace `using Xunit.Abstractions;` with `using Xunit;` where `ITestOutputHelper` is referenced
- [ ] Replace `PropertyDataAttribute` with `MemberDataAttribute` (if used)
- [ ] Replace `AssemblyTraitAttribute` with `TraitAttribute` (if used)
- [ ] Update any `CollectionBehaviorAttribute` / `TestCaseOrdererAttribute` / `TestCollectionOrdererAttribute` to use `typeof(...)` instead of string names (if used)
- [ ] Update custom `ITestCaseOrderer` / `ITestCollectionOrderer` implementations (if present): fix namespace + change `IEnumerable<T>` to `IReadOnlyCollection<T>` in `OrderTestCases`
- [ ] Build and check for **ambiguous overload** errors on `Assert.*` methods
- [ ] Run tests and verify pass/fail counts match expectations

---

## 10. References

- [Official v2→v3 migration guide](https://xunit.net/docs/getting-started/v3/migration)
- [What's new in xUnit v3](https://xunit.net/docs/getting-started/v3/whats-new)
- [xUnit v3 NuGet packages reference](https://xunit.net/docs/nuget-packages-v3)
- [xunit.v3 on NuGet](https://www.nuget.org/packages/xunit.v3)
