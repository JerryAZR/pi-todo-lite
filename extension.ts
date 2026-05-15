/**
 * extension.ts — Pi integration layer. Wires core logic into the agent.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext, Theme } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth, type TUI } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import {
	applyAction,
	createReminderState,
	formatTaskLine,
	incrementReminderCounter,
	isTodoTool,
	replayFromBranch,
	shouldFireReminder,
	updateReminderState,
	type Task,
	type TaskState,
	type TodoDetails,
} from "./core.js";

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let state: TaskState = { tasks: [], nextId: 1 };

export function replaceState(next: TaskState): void {
	state = next;
}

export function commitState(next: TaskState): void {
	state = next;
}

// ---------------------------------------------------------------------------
// Reminder state (managed by core.ts)
// ---------------------------------------------------------------------------

const reminder = createReminderState();

function findSubject(id: number): string {
	return state.tasks.find((t) => t.id === id)?.subject ?? `#${id}`;
}

// ---------------------------------------------------------------------------
// Overlay widget
// ---------------------------------------------------------------------------

const WIDGET_KEY = "todo-lite";
const MAX_LINES = 10;

class TodoOverlay {
	private uiCtx?: ExtensionUIContext;
	private registered = false;
	private tui?: TUI;
	private hiddenDone = new Set<number>();

	setUICtx(ctx: ExtensionUIContext): void {
		if (ctx !== this.uiCtx) {
			this.uiCtx = ctx;
			this.registered = false;
			this.tui = undefined;
		}
	}

	update(): void {
		if (!this.uiCtx) return;
		const visible = this.visibleTasks();
		if (visible.length === 0) {
			if (this.registered) {
				this.uiCtx.setWidget(WIDGET_KEY, undefined);
				this.registered = false;
				this.tui = undefined;
			}
			return;
		}
		if (!this.registered) {
			this.uiCtx.setWidget(
				WIDGET_KEY,
				(tui, theme) => {
					this.tui = tui;
					return {
						render: (width: number) => this.renderWidget(theme, width),
						invalidate: () => {
							this.registered = false;
							this.tui = undefined;
						},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.registered = true;
		} else {
			this.tui?.requestRender();
		}
	}

	hideDoneFromPreviousTurn(): void {
		for (const t of state.tasks) {
			if (t.done) this.hiddenDone.add(t.id);
		}
		this.tui?.requestRender();
	}

	reset(): void {
		this.hiddenDone.clear();
	}

	dispose(): void {
		this.uiCtx?.setWidget(WIDGET_KEY, undefined);
		this.registered = false;
		this.tui = undefined;
		this.uiCtx = undefined;
		this.reset();
	}

	private visibleTasks(): Task[] {
		return state.tasks.filter((t) => !this.hiddenDone.has(t.id));
	}

	private renderWidget(theme: Theme, width: number): string[] {
		const all = this.visibleTasks();
		if (all.length === 0) return [];

		const done = all.filter((t) => t.done).length;
		const hasPending = all.some((t) => !t.done);
		const color = hasPending ? "accent" : "dim";
		const icon = hasPending ? "●" : "○";
		const heading = truncateToWidth(
			`${theme.fg(color, icon)} ${theme.fg(color, `Todos (${done}/${all.length})`)}`,
			width,
		);

		const lines: string[] = [heading];
		const budget = MAX_LINES - 1;
		const slice = all.slice(0, budget);
		const overflow = all.length - slice.length;

		for (let i = 0; i < slice.length; i++) {
			const isLast = i === slice.length - 1 && overflow === 0;
			const prefix = theme.fg("dim", isLast ? "└─" : "├─");
			lines.push(truncateToWidth(`${prefix} ${formatWidgetTask(slice[i], theme)}`, width));
		}

		if (overflow > 0) {
			lines.push(
				truncateToWidth(`${theme.fg("dim", "└─")} ${theme.fg("dim", `+${overflow} more`)}`, width),
			);
		}

		return lines;
	}
}

function formatWidgetTask(t: Task, theme: Theme): string {
	const glyph = t.done ? theme.fg("success", "✓") : theme.fg("dim", "○");
	const subject = t.done ? theme.strikethrough(theme.fg("dim", t.subject)) : t.subject;
	return `${glyph} ${subject}`;
}

// ---------------------------------------------------------------------------
// Shared result builder
// ---------------------------------------------------------------------------

function buildToolResult(
	action: string,
	result: ReturnType<typeof applyAction>,
): { content: Array<{ type: "text"; text: string }>; details: TodoDetails } {
	const details: TodoDetails = {
		action,
		tasks: result.state.tasks,
		nextId: result.state.nextId,
		...(result.error ? { error: result.error } : {}),
	};
	return {
		content: [{ type: "text", text: result.error ? `Error: ${result.error}` : result.content }],
		details,
	};
}

function renderTodoResult(result: { details?: unknown }, theme: Theme): Text {
	const details = result.details as TodoDetails | undefined;
	if (details?.error) {
		return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
	}
	return new Text(theme.fg("success", "✓"), 0, 0);
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let overlay: TodoOverlay | undefined;

	const syncState = (ctx: ExtensionContext) => {
		replaceState(replayFromBranch(ctx.sessionManager.getBranch()));
		updateReminderState(reminder, state, undefined, false);
		overlay?.reset();
		overlay?.update();
	};

	pi.on("session_start", async (_event, ctx) => {
		syncState(ctx);
		if (ctx.hasUI) {
			overlay ??= new TodoOverlay();
			overlay.setUICtx(ctx.ui);
			overlay.update();
		}
	});

	pi.on("session_compact", async (_event, ctx) => {
		syncState(ctx);
		overlay?.update();
	});

	pi.on("session_tree", async (_event, ctx) => {
		syncState(ctx);
		overlay?.update();
	});

	pi.on("session_shutdown", async () => {
		overlay?.dispose();
		overlay = undefined;
	});

	pi.on("agent_start", async () => {
		overlay?.hideDoneFromPreviousTurn();
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!reminder.wasResetThisTurn) {
			incrementReminderCounter(reminder);
		}
		reminder.wasResetThisTurn = false;

		if (shouldFireReminder(reminder) && !ctx.hasPendingMessages()) {
			const pending = state.tasks.filter((t) => !t.done);
			const oldest = pending[0] ?? null;
			if (oldest) {
				pi.sendUserMessage(
					`Reminder: Task #${oldest.id} "${oldest.subject}" is still pending. ` +
						`If you've completed it, call todo_update with id: ${oldest.id}, done: true.`,
					{ deliverAs: "followUp" },
				);
				reminder.turnsSinceAction = 0;
			}
		}
	});

	pi.on("tool_execution_end", async (event) => {
		if (!isTodoTool(event.toolName) || event.isError) return;
		overlay?.update();
	});

	// --- todo_create ---

	pi.registerTool({
		name: "todo_create",
		label: "Todo Create",
		description: "Create a new task. Subject should be short and imperative.",
		promptSnippet: "Create a task in the todo list",
		promptGuidelines: [
			"Use the todo tools when the user gives you a list of tasks, or when tracking complex multi-step work. Skip them for single trivial tasks and purely conversational requests.",
		],
		parameters: Type.Object({
			subject: Type.String({ description: "Short imperative subject line" }),
			description: Type.Optional(Type.String({ description: "Long-form task description" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const result = applyAction(state, "create", params as Record<string, unknown>);
			commitState(result.state);
			updateReminderState(reminder, result.state);
			return buildToolResult("create", result);
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("todo_create ")) + theme.fg("muted", "+");
			if (args.subject) text += ` ${theme.fg("dim", String(args.subject))}`;
			return new Text(text, 0, 0);
		},

		renderResult: renderTodoResult,
	});

	// --- todo_update ---

	pi.registerTool({
		name: "todo_update",
		label: "Todo Update",
		description:
			"Update a task's subject, description, or done status. Use todo_update's appendNote parameter to add a paragraph without replacing existing text. Batch multiple fields in a single call.",
		promptSnippet: "Update a task in the todo list",
		promptGuidelines: [
			"When you finish a task, call todo_update with id and done: true.",
		],
		parameters: Type.Object({
			id: Type.Number({ description: "Task id to update" }),
			subject: Type.Optional(Type.String({ description: "Replace the subject line" })),
			description: Type.Optional(Type.String({ description: "Replace the entire description" })),
			appendNote: Type.Optional(
				Type.String({ description: "Append a paragraph to the existing description" }),
			),
			done: Type.Optional(Type.Boolean({ description: "Mark task as done or not done" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const result = applyAction(state, "update", params as Record<string, unknown>);
			commitState(result.state);
			updateReminderState(reminder, result.state, params.id as number);
			return buildToolResult("update", result);
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("todo_update ")) + theme.fg("muted", "→");
			if (args.id !== undefined) {
				text += ` ${theme.fg("accent", findSubject(Number(args.id)))}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult: renderTodoResult,
	});

	// --- todo_list ---

	pi.registerTool({
		name: "todo_list",
		label: "Todo List",
		description: "List all tasks, or filter by done or pending status.",
		promptSnippet: "List tasks in the todo list",
		parameters: Type.Object({
			filter: Type.Optional(
				StringEnum(["done", "pending"] as const, { description: "Filter by status" }),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const result = applyAction(state, "list", params as Record<string, unknown>);
			commitState(result.state);
			return buildToolResult("list", result);
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("todo_list ")) + theme.fg("muted", "☰");
			if (args.filter) text += ` ${theme.fg("muted", String(args.filter))}`;
			return new Text(text, 0, 0);
		},

		renderResult: renderTodoResult,
	});

	// --- todo_get ---

	pi.registerTool({
		name: "todo_get",
		label: "Todo Get",
		description: "Get full details of a single task including its description.",
		parameters: Type.Object({
			id: Type.Number({ description: "Task id" }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const result = applyAction(state, "get", params as Record<string, unknown>);
			commitState(result.state);
			updateReminderState(reminder, result.state, params.id as number);
			return buildToolResult("get", result);
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("todo_get ")) + theme.fg("muted", "›");
			if (args.id !== undefined) {
				text += ` ${theme.fg("accent", findSubject(Number(args.id)))}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult: renderTodoResult,
	});

	// --- todo_delete ---

	pi.registerTool({
		name: "todo_delete",
		label: "Todo Delete",
		description: "Permanently delete a task by id.",
		parameters: Type.Object({
			id: Type.Number({ description: "Task id to delete" }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const result = applyAction(state, "delete", params as Record<string, unknown>);
			commitState(result.state);
			updateReminderState(reminder, result.state, params.id as number);
			return buildToolResult("delete", result);
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("todo_delete ")) + theme.fg("muted", "×");
			if (args.id !== undefined) {
				text += ` ${theme.fg("accent", findSubject(Number(args.id)))}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult: renderTodoResult,
	});

	// --- todo_clear ---

	pi.registerTool({
		name: "todo_clear",
		label: "Todo Clear",
		description: "Delete all tasks and reset the list.",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			const result = applyAction(state, "clear", {});
			commitState(result.state);
			updateReminderState(reminder, result.state);
			return buildToolResult("clear", result);
		},

		renderCall(_args, theme, _context) {
			const text = theme.fg("toolTitle", theme.bold("todo_clear ")) + theme.fg("muted", "∅");
			return new Text(text, 0, 0);
		},

		renderResult: renderTodoResult,
	});

	// --- Command ---

	pi.registerCommand("todos", {
		description: "Show all todos on the current branch",
		handler: async (_args, ctx) => {
			if (state.tasks.length === 0) {
				ctx.ui.notify("No todos yet. Ask the agent to add some!", "info");
				return;
			}
			const pending = state.tasks.filter((t) => !t.done);
			const done = state.tasks.filter((t) => t.done);

			const headerParts: string[] = [];
			if (done.length > 0) headerParts.push(`${done.length} done`);
			if (pending.length > 0) headerParts.push(`${pending.length} pending`);

			const lines: string[] = [headerParts.join(" · ")];
			if (pending.length > 0) {
				lines.push("── Pending ──");
				for (const t of pending) lines.push(`  ○ ${formatTaskLine(t)}`);
			}
			if (done.length > 0) {
				lines.push("── Done ──");
				for (const t of done) lines.push(`  ✓ ${formatTaskLine(t)}`);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
