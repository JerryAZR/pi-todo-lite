/**
 * core.test.ts — Tests for pure logic.
 */

import { describe, expect, it } from "vitest";
import {
	applyAction,
	checkReminder,
	createReminderState,
	EMPTY_STATE,
	formatTaskDetail,
	formatTaskLine,
	markTodoTouched,
	replayFromBranch,
	syncReminderState,
	type BranchEntry,
	type TaskState,
} from "./core.js";

function state(tasks: TaskState["tasks"], nextId: number, globalCompletions = 0): TaskState {
	return { tasks, nextId, globalCompletions };
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe("create", () => {
	it("adds a task", () => {
		const result = applyAction(EMPTY_STATE, "create", { subject: "Fix bug" });
		expect(result.error).toBeUndefined();
		expect(result.state.tasks).toHaveLength(1);
		expect(result.state.tasks[0]).toEqual({ id: 1, subject: "Fix bug", done: false });
		expect(result.state.nextId).toBe(2);
		expect(result.content).toBe("Created #1: Fix bug");
	});

	it("requires subject", () => {
		const result = applyAction(EMPTY_STATE, "create", {});
		expect(result.error).toBe("subject required");
		expect(result.state.tasks).toHaveLength(0);
	});

	it("trims subject", () => {
		const result = applyAction(EMPTY_STATE, "create", { subject: "  Fix bug  " });
		expect(result.state.tasks[0].subject).toBe("Fix bug");
	});

	it("accepts description", () => {
		const result = applyAction(EMPTY_STATE, "create", { subject: "Fix bug", description: "Details here" });
		expect(result.state.tasks[0].description).toBe("Details here");
	});
});

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

describe("update", () => {
	const base = state([{ id: 1, subject: "A", done: false }], 2);

	it("updates subject", () => {
		const result = applyAction(base, "update", { id: 1, subject: "B" });
		expect(result.error).toBeUndefined();
		expect(result.state.tasks[0].subject).toBe("B");
		expect(result.content).toBe("Updated #1");
	});

	it("updates done", () => {
		const result = applyAction(base, "update", { id: 1, done: true });
		expect(result.state.tasks[0].done).toBe(true);
	});

	it("updates description", () => {
		const result = applyAction(base, "update", { id: 1, description: "New desc" });
		expect(result.state.tasks[0].description).toBe("New desc");
	});

	it("appends note", () => {
		const s = state([{ id: 1, subject: "A", description: "First", done: false }], 2);
		const result = applyAction(s, "update", { id: 1, appendNote: "Second" });
		expect(result.state.tasks[0].description).toBe("First\n\nSecond");
	});

	it("appends note when no existing description", () => {
		const result = applyAction(base, "update", { id: 1, appendNote: "Note" });
		expect(result.state.tasks[0].description).toBe("Note");
	});

	it("batches multiple fields", () => {
		const result = applyAction(base, "update", { id: 1, subject: "B", done: true, description: "Desc" });
		expect(result.state.tasks[0]).toEqual({ id: 1, subject: "B", done: true, description: "Desc", completionOrder: 0 });
		expect(result.state.globalCompletions).toBe(1);
	});

	it("rejects missing id", () => {
		const result = applyAction(base, "update", { subject: "B" });
		expect(result.error).toBe("#NaN not found");
	});

	it("rejects nonexistent id", () => {
		const result = applyAction(base, "update", { id: 99, subject: "B" });
		expect(result.error).toBe("#99 not found");
	});

	it("rejects empty mutation", () => {
		const result = applyAction(base, "update", { id: 1 });
		expect(result.error).toBe("update requires at least one field");
	});
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe("list", () => {
	const base = state(
		[
			{ id: 1, subject: "A", done: true },
			{ id: 2, subject: "B", done: false },
		],
		3,
	);

	it("lists all tasks", () => {
		const result = applyAction(base, "list", {});
		expect(result.content).toBe("[done] #1 A\n[pending] #2 B");
	});

	it("filters done", () => {
		const result = applyAction(base, "list", { filter: "done" });
		expect(result.content).toBe("[done] #1 A");
	});

	it("filters pending", () => {
		const result = applyAction(base, "list", { filter: "pending" });
		expect(result.content).toBe("[pending] #2 B");
	});

	it("returns message when empty", () => {
		const result = applyAction(EMPTY_STATE, "list", {});
		expect(result.content).toBe("No tasks");
	});
});

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

describe("get", () => {
	const base = state([{ id: 1, subject: "A", description: "Desc", done: false }], 2);

	it("returns task details", () => {
		const result = applyAction(base, "get", { id: 1 });
		expect(result.content).toBe("#1 [pending] A\n  Desc");
	});

	it("rejects missing task", () => {
		const result = applyAction(base, "get", { id: 99 });
		expect(result.error).toBe("#99 not found");
	});
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

describe("delete", () => {
	const base = state(
		[
			{ id: 1, subject: "A", done: false },
			{ id: 2, subject: "B", done: false },
		],
		3,
	);

	it("removes task permanently", () => {
		const result = applyAction(base, "delete", { id: 1 });
		expect(result.error).toBeUndefined();
		expect(result.state.tasks).toHaveLength(1);
		expect(result.state.tasks[0].id).toBe(2);
		expect(result.content).toBe("Deleted #1: A");
	});

	it("rejects missing task", () => {
		const result = applyAction(base, "delete", { id: 99 });
		expect(result.error).toBe("#99 not found");
	});
});

// ---------------------------------------------------------------------------
// clear
// ---------------------------------------------------------------------------

describe("clear", () => {
	it("wipes all tasks", () => {
		const base = state([{ id: 1, subject: "A", done: false }], 2);
		const result = applyAction(base, "clear", {});
		expect(result.state.tasks).toHaveLength(0);
		expect(result.state.nextId).toBe(1);
		expect(result.content).toBe("Cleared 1 tasks");
	});
});

// ---------------------------------------------------------------------------
// replay
// ---------------------------------------------------------------------------

describe("replayFromBranch", () => {
	function makeEntry(toolName: string, details: object): BranchEntry {
		return { type: "message", message: { role: "toolResult", toolName, details } };
	}

	it("reconstructs from last valid todo tool result", () => {
		const entries = [
			makeEntry("todo_create", { action: "create", tasks: [{ id: 1, subject: "A", done: false }], nextId: 2 }),
			makeEntry("todo_create", { action: "create", tasks: [{ id: 1, subject: "A", done: false }, { id: 2, subject: "B", done: true }], nextId: 3 }),
		];
		const result = replayFromBranch(entries);
		expect(result.tasks).toHaveLength(2);
		expect(result.nextId).toBe(3);
	});

	it("skips malformed details", () => {
		const entries = [
			makeEntry("todo_create", { action: "create", tasks: "bad", nextId: 2 }),
			makeEntry("todo_create", { action: "create", tasks: [{ id: 1, subject: "A", done: false }], nextId: 2 }),
		];
		const result = replayFromBranch(entries);
		expect(result.tasks).toHaveLength(1);
	});

	it("returns empty state when no entries", () => {
		const result = replayFromBranch([]);
		expect(result.tasks).toHaveLength(0);
		expect(result.nextId).toBe(1);
	});

	it("returns empty state when no todo tool results", () => {
		const entries = [
			{ type: "message", message: { role: "toolResult", toolName: "bash", details: {} } },
		];
		const result = replayFromBranch(entries);
		expect(result.tasks).toHaveLength(0);
	});

	it("ignores old single-tool todo entries", () => {
		const entries = [
			makeEntry("todo", { action: "create", tasks: [{ id: 1, subject: "A", done: false }], nextId: 2 }),
		];
		const result = replayFromBranch(entries);
		expect(result.tasks).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

describe("formatTaskLine", () => {
	it("formats pending task", () => {
		expect(formatTaskLine({ id: 1, subject: "A", done: false })).toBe("[pending] #1 A");
	});

	it("formats done task", () => {
		expect(formatTaskLine({ id: 2, subject: "B", done: true })).toBe("[done] #2 B");
	});
});

describe("formatTaskDetail", () => {
	it("includes description", () => {
		const t = { id: 1, subject: "A", description: "Line 1\nLine 2", done: false };
		expect(formatTaskDetail(t)).toBe("#1 [pending] A\n  Line 1\n  Line 2");
	});

	it("omits description when absent", () => {
		const t = { id: 1, subject: "A", done: true };
		expect(formatTaskDetail(t)).toBe("#1 [done] A");
	});
});

// ---------------------------------------------------------------------------
// reminder
// ---------------------------------------------------------------------------

describe("syncReminderState", () => {
	it("resets counter when oldest changes", () => {
		const r = createReminderState();
		r.turnsSinceAction = 2;
		const s = state([{ id: 1, subject: "A", done: false }], 2);
		syncReminderState(r, s);
		expect(r.previousOldestId).toBe(1);
		expect(r.turnsSinceAction).toBe(0);
	});

	it("preserves counter when oldest unchanged", () => {
		const r = createReminderState();
		r.previousOldestId = 1;
		r.turnsSinceAction = 2;
		const s = state([{ id: 1, subject: "A", done: false }], 2);
		syncReminderState(r, s);
		expect(r.turnsSinceAction).toBe(2);
	});
});

describe("markTodoTouched", () => {
	it("records the touched task id", () => {
		const r = createReminderState();
		markTodoTouched(r, 5);
		expect(r.lastTouchedId).toBe(5);
	});
});

describe("checkReminder", () => {
	it("returns null and resets when no pending tasks", () => {
		const r = createReminderState();
		r.turnsSinceAction = 5;
		const s = state([], 1);
		expect(checkReminder(r, s)).toBeNull();
		expect(r.turnsSinceAction).toBe(0);
	});

	it("returns null and resets when oldest changes", () => {
		const r = createReminderState();
		r.previousOldestId = 1;
		r.turnsSinceAction = 5;
		const s = state([{ id: 2, subject: "B", done: false }], 3);
		expect(checkReminder(r, s)).toBeNull();
		expect(r.previousOldestId).toBe(2);
		expect(r.turnsSinceAction).toBe(0);
	});

	it("returns null and resets when oldest was touched this turn", () => {
		const r = createReminderState();
		r.previousOldestId = 1;
		r.lastTouchedId = 1;
		r.turnsSinceAction = 5;
		const s = state([{ id: 1, subject: "A", done: false }], 2);
		expect(checkReminder(r, s)).toBeNull();
		expect(r.turnsSinceAction).toBe(0);
		expect(r.lastTouchedId).toBeNull();
	});

	it("increments counter on idle turns", () => {
		const r = createReminderState();
		r.previousOldestId = 1;
		const s = state([{ id: 1, subject: "A", done: false }], 2);
		expect(checkReminder(r, s)).toBeNull();
		expect(r.turnsSinceAction).toBe(1);
		expect(checkReminder(r, s)).toBeNull();
		expect(r.turnsSinceAction).toBe(2);
	});

	it("fires reminder after 4 idle turns and resets counter", () => {
		const r = createReminderState();
		r.previousOldestId = 1;
		r.turnsSinceAction = 3;
		const s = state([{ id: 1, subject: "A", done: false }], 2);
		const text = checkReminder(r, s);
		expect(text).not.toBeNull();
		expect(text).toContain("Task #1 \"A\" is still pending");
		expect(text).toContain("<system-reminder>");
		expect(text).toContain("</system-reminder>");
		expect(r.turnsSinceAction).toBe(0);
	});

	it("does not fire when a non-oldest task was touched", () => {
		const r = createReminderState();
		r.previousOldestId = 1;
		r.lastTouchedId = 2;
		r.turnsSinceAction = 5;
		const s = state(
			[
				{ id: 1, subject: "A", done: false },
				{ id: 2, subject: "B", done: false },
			],
			3,
		);
		expect(checkReminder(r, s)).not.toBeNull();
		expect(r.turnsSinceAction).toBe(0);
	});
});
