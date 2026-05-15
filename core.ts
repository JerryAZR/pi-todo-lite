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
}

export interface TaskState {
	tasks: Task[];
	nextId: number;
}

export interface TodoDetails {
	action: string;
	tasks: Task[];
	nextId: number;
	error?: string;
}

// ---------------------------------------------------------------------------
// Reminder tracking
// ---------------------------------------------------------------------------

export const REMINDER_INTERVAL = 3;

export interface ReminderState {
	turnsSinceAction: number;
	previousOldestId: number | null;
	wasResetThisTurn: boolean;
}

export function createReminderState(): ReminderState {
	return { turnsSinceAction: 0, previousOldestId: null, wasResetThisTurn: false };
}

function getOldestPendingId(state: TaskState): number | null {
	const pending = state.tasks.filter((t) => !t.done);
	return pending[0]?.id ?? null;
}

export function updateReminderState(
	reminder: ReminderState,
	state: TaskState,
	touchedId?: number,
	setFlag = true,
): void {
	const oldestId = getOldestPendingId(state);

	if (oldestId !== reminder.previousOldestId) {
		reminder.previousOldestId = oldestId;
		reminder.turnsSinceAction = 0;
		if (setFlag) reminder.wasResetThisTurn = true;
		return;
	}

	if (oldestId !== null && touchedId === oldestId) {
		reminder.turnsSinceAction = 0;
		if (setFlag) reminder.wasResetThisTurn = true;
		return;
	}

	if (oldestId === null) {
		reminder.turnsSinceAction = 0;
		if (setFlag) reminder.wasResetThisTurn = true;
		return;
	}
}

export function incrementReminderCounter(reminder: ReminderState): void {
	reminder.turnsSinceAction++;
}

export function shouldFireReminder(reminder: ReminderState): boolean {
	return reminder.turnsSinceAction >= REMINDER_INTERVAL;
}

export type TaskAction = "create" | "update" | "list" | "get" | "delete" | "clear";

export interface ApplyResult {
	state: TaskState;
	content: string;
	error?: string;
}

export const EMPTY_STATE: TaskState = { tasks: [], nextId: 1 };

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
				{ tasks: [...current.tasks, task], nextId: current.nextId + 1 },
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
			if (params.done !== undefined) updated.done = Boolean(params.done);

			const next = { tasks: [...current.tasks], nextId: current.nextId };
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
			const next = { tasks: [...current.tasks], nextId: current.nextId };
			next.tasks.splice(idx, 1);
			return ok(next, `Deleted #${id}: ${subject}`);
		}

		case "clear": {
			return ok({ tasks: [], nextId: 1 }, `Cleared ${current.tasks.length} tasks`);
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
			};
		}
	}
	return result;
}
