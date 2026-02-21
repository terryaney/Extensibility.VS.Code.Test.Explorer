# Relink Copilot Chat Sessions After Workspace Rename

Use this when renaming a workspace folder and wanting to preserve existing Copilot chat history.

## Step 1: Find the old workspace hash folder

Search all `workspace.json` files under:

```
%APPDATA%\Code\User\workspaceStorage\
```

Each subfolder has a `workspace.json` like:
```json
{ "folder": "file:///c%3A/BTR/Camelot/Extensibility/TestExplorer" }
```

Find the one matching the old path — the parent folder name (e.g., `a3f9b2c1...`) is the **old hash**.

## Step 2: Generate the new hash folder

1. Rename the workspace folder to the new name
2. Open it in VS Code
3. Create a throwaway chat message — just enough to force VS Code to initialize workspace storage

## Step 3: Find the new workspace hash folder

Same search as Step 1, but now look for the new path:

```
file:///c%3A/BTR/Camelot/Extensibility/VS.Code.Test.Explorer
```

The parent folder name is the **new hash**.

## Step 4: Copy the data

From the **old hash folder**, copy these into the **new hash folder** (overwrite):

- `state.vscdb` — SQLite database holding all extension storage, including Copilot chat history
- `state.vscdb.backup` — if present

**Do NOT copy** `workspace.json` — that file must remain as VS Code generated it for the new path.

## Step 5: Reload VS Code

Close and reopen the workspace. Chat history should be restored.

---

**Note:** `state.vscdb` stores data for all extensions on that workspace, not just Copilot Chat.
Overwriting it carries over all other extension state (breakpoints, etc.) from the old workspace as well.
