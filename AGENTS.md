# Pi Extension Development — Quick Reference

## Official documentation (local)

| Topic | Path |
|-------|------|
| **Extensions API** | `~\AppData\Roaming\npm\node_modules\@mariozechner\pi-coding-agent\docs\extensions.md` |
| **TUI / Custom rendering** | `~\AppData\Roaming\npm\node_modules\@mariozechner\pi-coding-agent\docs\tui.md` |
| **Themes** | `~\AppData\Roaming\npm\node_modules\@mariozechner\pi-coding-agent\docs\themes.md` |
| **Keybindings** | `~\AppData\Roaming\npm\node_modules\@mariozechner\pi-coding-agent\docs\keybindings.md` |
| **Sessions / branching** | `~\AppData\Roaming\npm\node_modules\@mariozechner\pi-coding-agent\docs\sessions.md` |
| **Examples** | `~\AppData\Roaming\npm\node_modules\@mariozechner\pi-coding-agent\examples\extensions\` |

The **extensions.md** doc is the canonical reference for:
- All lifecycle events (`session_start`, `tool_call`, `tool_result`, `agent_start`, etc.)
- `ExtensionAPI` methods (`registerTool`, `registerCommand`, `on`, `sendMessage`, etc.)
- `ExtensionContext` properties (`ctx.ui`, `ctx.sessionManager`, `ctx.signal`, etc.)
- Custom tool definition, custom rendering, custom UI components
- State management patterns (`appendEntry`, tool-result `details`)

The **tui.md** doc covers:
- `Text`, `Container`, `Box` components
- `setWidget`, `setStatus`, `setFooter`, `setWorkingIndicator`
- `ctx.ui.custom()` for modal/overlays
- Theme colors and `keyHint()`

## Key examples (local)

| Example | What it demonstrates | Path |
|---------|---------------------|------|
| `todo.ts` | Stateful tool with persistence, `renderCall`/`renderResult`, `/command` | `~\AppData\Roaming\npm\node_modules\@mariozechner\pi-coding-agent\examples\extensions\todo.ts` |
| `dynamic-tools.ts` | Register tools after startup | `~\AppData\Roaming\npm\node_modules\@mariozechner\pi-coding-agent\examples\extensions\dynamic-tools.ts` |
| `widget-placement.ts` | Widget above/below editor | `~\AppData\Roaming\npm\node_modules\@mariozechner\pi-coding-agent\examples\extensions\widget-placement.ts` |
| `permission-gate.ts` | `tool_call` event blocking | `~\AppData\Roaming\npm\node_modules\@mariozechner\pi-coding-agent\examples\extensions\permission-gate.ts` |
| `custom-compaction.ts` | `session_before_compact` / `session_compact` | `~\AppData\Roaming\npm\node_modules\@mariozechner\pi-coding-agent\examples\extensions\custom-compaction.ts` |

## Project-specific notes

### Architecture

```
core.ts       → Pure logic: types, reducer, replay, formatting. Zero pi deps. Unit-testable.
extension.ts  → Pi integration: event handlers, tool/command registration, widget.
core.test.ts  → Vitest tests for the reducer.
```

### Multi-tool pattern

This extension uses **6 separate tools** (`todo_create`, `todo_update`, `todo_list`, `todo_get`, `todo_delete`, `todo_clear`) instead of a single `action`-switch tool. Each has a tight schema with no dead-weight parameters. See `extension.ts` for the registration pattern.

### State persistence

State is stored in **tool result `details`** (full task array snapshot) and reconstructed by replaying the session branch on `session_start` / `session_compact` / `session_tree`. See `core.ts:replayFromBranch()` and `extension.ts:syncState()`.

### Render sharing

All 6 tools share `renderTodoResult()` and `buildToolResult()` helpers, but each has its own `renderCall` for per-tool glyph display.

## Running this extension locally

```bash
# Quick test
pi -e ./extension.ts

# Or install to global extensions
mkdir -p ~/.pi/agent/extensions
cp extension.ts ~/.pi/agent/extensions/
```

## Running tests

```bash
npm install
npm test
```
