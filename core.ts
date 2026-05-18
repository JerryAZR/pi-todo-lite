/**
 * core.ts — Pure logic. No pi dependencies. Testable in isolation.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Task {
	id: number;
	subject: string;
	description?: string;
	done: boolean;
	/** Monotonically increasing order when marked done. Used by the widget to show recently completed tasks. */
	completionOrder?: number;
}

export interface TaskState {
	tasks: Task[];
	nextId: number;
	/** Next completion order to assign (not a count). Reset on clear. */
	globalCompletions: number;
}

export interface TodoDetails {
	action: string;
	tasks: Task[];
	nextId: number;
	globalCompletions: number;
	error?: string;
}

// ---------------------------------------------------------------------------
// Reminder tracking — all state and decisions live in core
// ---------------------------------------------------------------------------

const REMINDER_INTERVAL = Number(process.env.PI_TODO_REMINDER_INTERVAL) || 4;

export interface ReminderState {
	turnsSinceAction: number;
	previousOldestId: number | null;
	lastTouchedId: number | null;
}

export function createReminderState(): ReminderState {
	return { turnsSinceAction: 0, previousOldestId: null, lastTouchedId: null };
}

function getOldestPendingId(state: TaskState): number | null {
	const pending = state.tasks.filter((t) => !t.done);
	return pending[0]?.id ?? null;
}

/** Sync reminder baseline after state reconstruction (replay, compact, tree). */
export function syncReminderState(reminder: ReminderState, state: TaskState): void {
	const oldestId = getOldestPendingId(state);
	if (oldestId !== reminder.previousOldestId) {
		reminder.previousOldestId = oldestId;
		reminder.turnsSinceAction = 0;
		reminder.lastTouchedId = null;
	}
}

/** Record that a todo tool acted on a specific task. Called from execute handlers. */
export function markTodoTouched(reminder: ReminderState, taskId: number): void {
	reminder.lastTouchedId = taskId;
}

/** Called at the end of an agent turn. Updates state and returns a reminder string, or null. */
export function checkReminder(reminder: ReminderState, state: TaskState): string | null {
	const oldestId = getOldestPendingId(state);

	// Oldest task changed — reset baseline
	if (oldestId !== reminder.previousOldestId) {
		reminder.previousOldestId = oldestId;
		reminder.turnsSinceAction = 0;
		reminder.lastTouchedId = null;
		return null;
	}

	// No pending tasks — nothing to remind about
	if (oldestId === null) {
		reminder.turnsSinceAction = 0;
		reminder.lastTouchedId = null;
		return null;
	}

	// Oldest task was touched this turn — reset counter
	if (reminder.lastTouchedId === oldestId) {
		reminder.turnsSinceAction = 0;
		reminder.lastTouchedId = null;
		return null;
	}

	// Count idle turns
	reminder.turnsSinceAction++;
	reminder.lastTouchedId = null;

	// Fire reminder if threshold reached
	if (reminder.turnsSinceAction >= REMINDER_INTERVAL) {
		const oldest = state.tasks.find((t) => t.id === oldestId)!;
		reminder.turnsSinceAction = 0;
		return (
			`<system-reminder>\n` +
			`Task #${oldest.id} "${oldest.subject}" is still pending. ` +
			`If you've completed it, call todo_update with id: ${oldest.id}, done: true. ` +
			`If you are actively working on it but requirements or progress have changed, ` +
			`update the task or add a note with todo_update accordingly.\n` +
			`</system-reminder>`
		);
	}

	return null;
}

export type TaskAction = "create" | "update" | "list" | "get" | "delete" | "clear";

export interface ApplyResult {
	state: TaskState;
	content: string;
	error?: string;
}

export const EMPTY_STATE: TaskState = { tasks: [], nextId: 1, globalCompletions: 0 };

// ---------------------------------------------------------------------------
// Tool names for replay
// ---------------------------------------------------------------------------

export const TODO_TOOL_NAMES = new Set([
	"todo_create",
	"todo_update",
	"todo_list",
	"todo_get",
	"todo_delete",
	"todo_clear",
]);

export function isTodoTool(name: string | undefined): boolean {
	return !!name && TODO_TOOL_NAMES.has(name);
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function applyAction(
	current: TaskState,
	action: TaskAction,
	params: Record<string, unknown>,
): ApplyResult {
	switch (action) {
		case "create": {
			const subject = String(params.subject ?? "").trim();
			if (!subject) return error(current, "subject required");

			const task: Task = {
				id: current.nextId,
				subject,
				done: false,
			};
			if (params.description) task.description = String(params.description);

			return ok(
				{ tasks: [...current.tasks, task], nextId: current.nextId + 1, globalCompletions: current.globalCompletions },
				`Created #${task.id}: ${task.subject}`,
			);
		}

		case "update": {
			const id = Number(params.id);
			const idx = current.tasks.findIndex((t) => t.id === id);
			if (idx === -1) return error(current, `#${id} not found`);

			const old = current.tasks[idx];
			const hasMutation =
				params.subject !== undefined ||
				params.description !== undefined ||
				params.appendNote !== undefined ||
				params.done !== undefined;
			if (!hasMutation) return error(current, "update requires at least one field");

			const updated: Task = { ...old };
			let nextGlobalCompletions = current.globalCompletions;

			if (params.subject !== undefined) updated.subject = String(params.subject).trim();
			if (params.description !== undefined) {
				const desc = String(params.description).trim();
				updated.description = desc || undefined;
			}
			if (params.appendNote !== undefined) {
				const note = String(params.appendNote).trim();
				if (note) {
					updated.description = updated.description ? `${updated.description}\n\n${note}` : note;
				}
			}
			if (params.done !== undefined) {
				const wasDone = old.done;
				updated.done = Boolean(params.done);
				if (!wasDone && updated.done) {
					updated.completionOrder = nextGlobalCompletions++;
				} else if (wasDone && !updated.done) {
					updated.completionOrder = undefined;
				}
			}

			const next = { tasks: [...current.tasks], nextId: current.nextId, globalCompletions: nextGlobalCompletions };
			next.tasks[idx] = updated;
			return ok(next, `Updated #${id}`);
		}

		case "list": {
			let view = current.tasks;
			if (params.filter === "done") view = view.filter((t) => t.done);
			else if (params.filter === "pending") view = view.filter((t) => !t.done);

			const lines = view.map(formatTaskLine);
			return ok(current, lines.length ? lines.join("\n") : "No tasks");
		}

		case "get": {
			const id = Number(params.id);
			const task = current.tasks.find((t) => t.id === id);
			if (!task) return error(current, `#${id} not found`);
			return ok(current, formatTaskDetail(task));
		}

		case "delete": {
			const id = Number(params.id);
			const idx = current.tasks.findIndex((t) => t.id === id);
			if (idx === -1) return error(current, `#${id} not found`);
			const subject = current.tasks[idx].subject;
			const next = { tasks: [...current.tasks], nextId: current.nextId, globalCompletions: current.globalCompletions };
			next.tasks.splice(idx, 1);
			return ok(next, `Deleted #${id}: ${subject}`);
		}

		case "clear": {
			return ok({ tasks: [], nextId: 1, globalCompletions: 0 }, `Cleared ${current.tasks.length} tasks`);
		}

		default:
			return error(current, `unknown action: ${action}`);
	}
}

function ok(state: TaskState, content: string): ApplyResult {
	return { state, content };
}

function error(state: TaskState, message: string): ApplyResult {
	return { state, content: "", error: message };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatTaskLine(t: Task): string {
	const prefix = t.done ? "[done]" : "[pending]";
	return `${prefix} #${t.id} ${t.subject}`;
}

export function formatTaskDetail(t: Task): string {
	const lines = [`#${t.id} [${t.done ? "done" : "pending"}] ${t.subject}`];
	if (t.description) lines.push(`  ${t.description.replace(/\n/g, "\n  ")}`);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Replay from session branch
// ---------------------------------------------------------------------------

export interface BranchEntry {
	type?: string;
	message?: {
		role?: string;
		toolName?: string;
		details?: unknown;
	};
}

export function replayFromBranch(entries: Iterable<BranchEntry>): TaskState {
	let result: TaskState = { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (!msg || msg.role !== "toolResult" || !isTodoTool(msg.toolName)) continue;
		const details = msg.details as TodoDetails | undefined;
		if (details && Array.isArray(details.tasks) && typeof details.nextId === "number") {
			result = {
				tasks: details.tasks.map((t) => ({ ...t })),
				nextId: details.nextId,
				globalCompletions: details.globalCompletions ?? 0,
			};
		}
	}
	return result;
}
