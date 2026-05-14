# Pi Extension Development Guide

A quick reference for developing [pi](https://github.com/badlogic/pi-mono) extensions, based on the patterns used in `pi-todo-lite`.

## Extension basics

An extension is a TypeScript module that exports a **default factory function** receiving `ExtensionAPI`:

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // Subscribe to events, register tools, commands, etc.
}
```

Extensions are loaded via [jiti](https://github.com/unjs/jiti) — no build step needed. Put them in:
- `~/.pi/agent/extensions/*.ts` (global)
- `./.pi/extensions/*.ts` (project-local)

## Core concepts

### ExtensionAPI

The `pi` object provides:

| Method | Purpose |
|--------|---------|
| `pi.on(event, handler)` | Subscribe to lifecycle events |
| `pi.registerTool(def)` | Register a tool callable by the LLM |
| `pi.registerCommand(name, opts)` | Register a `/slash` command |
| `pi.registerShortcut(key, opts)` | Register a keyboard shortcut |
| `pi.registerFlag(name, opts)` | Register a CLI flag |
| `pi.sendMessage(msg, opts)` | Inject a message into the session |
| `pi.sendUserMessage(text, opts)` | Inject a user message (triggers a turn) |
| `pi.appendEntry(type, data)` | Persist extension state in the session file |
| `pi.events.on/emit` | Inter-extension event bus |

### ExtensionContext

All event handlers receive `ctx: ExtensionContext`:

| Property | Purpose |
|----------|---------|
| `ctx.ui` | TUI interaction (select, confirm, input, notify, setWidget, etc.) |
| `ctx.hasUI` | `false` in print/JSON mode — check before using UI methods |
| `ctx.sessionManager` | Read session entries, get branch, labels |
| `ctx.cwd` | Current working directory |
| `ctx.signal` | AbortSignal for the current turn (use for fetch, etc.) |
| `ctx.getSystemPrompt()` | Current system prompt string |
| `ctx.getContextUsage()` | Current token usage estimate |

## Events

Key lifecycle events (see [extensions.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md) for full list):

```
session_start           → Extension loaded, reconstruct state
session_compact         → Compaction finished, re-scan branch
session_tree            → Tree navigation, re-scan branch
session_shutdown        → Cleanup, save state

agent_start             → New user prompt, hide old completed tasks
agent_end               → Turn finished

tool_execution_start    → Tool about to run
tool_execution_end      → Tool finished (success or error)
tool_call               → Can block or mutate args before execution
tool_result             → Can modify result before it reaches LLM

before_agent_start      → Can inject messages, modify system prompt
```

## Tools

### Registration

```typescript
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";

pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "What this tool does — shown to LLM",
  promptSnippet: "One-line summary for Available tools section",
  promptGuidelines: [
    "When to use this tool — flat bullets appended to system prompt Guidelines",
  ],
  parameters: Type.Object({
    action: StringEnum(["list", "add"] as const),
    text: Type.Optional(Type.String()),
  }),

  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // Return result
    return {
      content: [{ type: "text", text: "Done" }],
      details: { data: "opaque" },
    };
  },

  renderCall(args, theme, context) {
    // Custom TUI rendering for the tool call row
    return new Text(theme.fg("toolTitle", "my_tool"), 0, 0);
  },

  renderResult(result, { expanded, isPartial }, theme, context) {
    // Custom TUI rendering for the result row
    return new Text(theme.fg("success", "✓"), 0, 0);
  },
});
```

### Return shape

```typescript
{
  content: [{ type: "text", text: "Visible to LLM" }],
  details: { /* Opaque — for rendering & state persistence, NOT visible to LLM */ },
}
```

- `content` — goes into LLM context as the tool result
- `details` — stored in session file, passed to `renderResult()`, used for replay

### Multi-tool vs single-tool

**Single tool with mode switch** (smaller prompt footprint):
```typescript
pi.registerTool({ name: "todo", parameters: { action: StringEnum(["create", "update", ...]) } })
```

**Multi-tool** (tighter schemas, clearer per-tool descriptions):
```typescript
pi.registerTool({ name: "todo_create", parameters: { subject: Type.String() } })
pi.registerTool({ name: "todo_update", parameters: { id: Type.Number(), done: Type.Optional(Type.Boolean()) } })
// ...
```

Use **multi-tool** when:
- Schemas are sparse (different actions need different params)
- Per-tool "when to use" guidance is distinct
- You want the LLM to see action names in the tool list

## State persistence

### Pattern: tool result details

Store the full state snapshot in every tool's `details`. On lifecycle events, replay from the session branch:

```typescript
function replayFromBranch(ctx: ExtensionContext) {
  let state = EMPTY_STATE;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "my_tool") {
      const details = entry.message.details as MyDetails | undefined;
      if (details?.tasks) state = { tasks: details.tasks, nextId: details.nextId };
    }
  }
  return state;
}

pi.on("session_start", async (_event, ctx) => {
  state = replayFromBranch(ctx);
});
```

**Pros:** Survives branching, forking, tree navigation. No external files.
**Cons:** If ALL tool results are compacted away, state resets to empty.

### Pattern: appendEntry

For data that must survive compaction:

```typescript
pi.appendEntry("my-state", { count: 42 });

// Restore:
for (const entry of ctx.sessionManager.getBranch()) {
  if (entry.type === "custom" && entry.customType === "my-state") {
    state = entry.data;
  }
}
```

`appendEntry` writes to the session file but does NOT participate in LLM context.

## Widgets

Persistent UI above/below the editor:

```typescript
ctx.ui.setWidget("my-widget", (tui, theme) => ({
  render(width: number): string[] {
    return [theme.fg("accent", "Hello")];
  },
  invalidate() {},
}), { placement: "aboveEditor" });

// Remove:
ctx.ui.setWidget("my-widget", undefined);
```

Use `tui.requestRender()` to refresh without re-registering.

## Commands

```typescript
pi.registerCommand("my-cmd", {
  description: "What this does",
  handler: async (args, ctx) => {
    ctx.ui.notify("Hello!", "info");
  },
});
```

Invoked as `/my-cmd` or `/my-cmd args`.

## Key imports

| Package | What | Example |
|---------|------|---------|
| `@mariozechner/pi-coding-agent` | Extension types, events, `isToolCallEventType` | `ExtensionAPI`, `ExtensionContext` |
| `@mariozechner/pi-ai` | `StringEnum` for Google-compatible enums | `StringEnum(["a", "b"] as const)` |
| `@mariozechner/pi-tui` | TUI components | `Text`, `Container`, `truncateToWidth` |
| `typebox` | Schema definitions | `Type.Object({ ... })` |

## Testing

Test pure logic without loading pi:

```typescript
import { describe, it, expect } from "vitest";
import { applyAction } from "./core.js";

describe("create", () => {
  it("adds a task", () => {
    const result = applyAction(EMPTY_STATE, "create", { subject: "Fix bug" });
    expect(result.state.tasks).toHaveLength(1);
  });
});
```

Keep pi-dependent code (`extension.ts`) thin. Put business logic in a pure module (`core.ts`) with zero pi imports.

## Official docs

- [extensions.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md) — Full event reference, API, examples
- [tui.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/tui.md) — Custom components, widgets, rendering
- [examples/extensions/](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions) — Working code (todo.ts, plan-mode, ssh, etc.)
