# @jerryan/pi-todo-lite

A lightweight task tracker for the [pi coding agent](https://github.com/badlogic/pi-mono).

## Design philosophy: intentional minimalism

The pi ecosystem already has capable task tracking extensions (`rpiv-todo`, `@tintinweb/pi-tasks`). This extension exists for a different user: someone who wants task tracking **without** the architectural weight.

### What "lite" means

| Heavy approaches (rpiv-todo, pi-tasks) | pi-todo-lite |
|---|---|
| `pending → in_progress → completed` status machine | Boolean `done` — LLMs rarely explicitly mark tasks "in-progress" |
| `blockedBy` dependency graphs with cycle detection | Dropped — LLMs execute tasks in order naturally |
| Subagent execution, background process tracking | Not needed for most single-session work |
| File-backed persistence with locking, shared lists | Session branch replay only — no external files |
| i18n (8 locales) | English only |
| `owner`, `metadata`, `activeForm` fields | Dropped — only `subject` + `description` |
| 7 tools, 2000+ lines | 6 tools, ~750 lines |
| Massive prompt descriptions (Claude Code-style) | One-sentence descriptions, tight schemas |

### What was kept (the good parts)

- **Multi-tool design** — `todo_create`, `todo_update`, `todo_list`, `todo_get`, `todo_delete`, `todo_clear`. Each has a tight schema with no dead-weight parameters.
- **Persistent overlay widget** — Shows tasks above the editor, hides completed after each turn to stay compact.
- **Branch-aware replay** — State stored in tool result `details`, reconstructed from the session branch on start/tree/compact. Forking and tree navigation always show the correct task list for that point in history.
- **Custom TUI rendering** — Compact `renderCall`/`renderResult` with status glyphs.
- **`/todos` command** — Quick user inspection grouped by pending/done.
- **`appendNote`** — Add paragraphs without replacing the full description.
- **Periodic reminder** — Injects `<system-reminder>` when pending tasks are idle for 4 turns, so the agent doesn't forget to mark tasks done.

### When to use this

- You want task tracking but don't want 7 tools competing for the LLM's attention.
- Your work fits in a single session and doesn't need cross-session persistence.
- You find `in_progress` states and dependency graphs create more ceremony than value.

### When to use something else

- You need subagent execution or background process tracking → `@tintinweb/pi-tasks`
- You need shared task lists across multiple sessions → `@tintinweb/pi-tasks`
- You need full status machines, dependency graphs, or i18n → `rpiv-todo`

## Install

```bash
pi install npm:@jerryan/pi-todo-lite
```

Or test directly:

```bash
pi -e ./extension.ts
```

## Usage

The LLM can call the todo tools automatically. You can also prompt it explicitly:

> "Track these tasks: refactor auth, update tests, deploy"

### Reminder system

If pending tasks exist and no todo tool has been used for 4 agent turns, a `<system-reminder>` nudge is injected to prompt the agent to mark done tasks or update progress. This prevents tasks from being forgotten during long discussions or non-todo work.

Override the interval with the environment variable:

```bash
PI_TODO_REMINDER_INTERVAL=6 pi -e ./extension.ts
```

User commands:

- `/todos` — Show all tasks grouped by status

## Project structure

```
pi-todo-lite/
├── core.ts           # Pure logic — types, reducer, replay, formatting (no pi deps)
├── extension.ts      # Pi integration — widget, event handlers, tool/command reg
├── core.test.ts      # Vitest tests for the reducer
├── package.json
└── vitest.config.ts
```

## Running tests

```bash
npm install
npm test
```

## License

MIT
