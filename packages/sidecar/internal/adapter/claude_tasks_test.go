package adapter

import (
	"fmt"
	"testing"

	"github.com/kr4t0n/argus/sidecar/internal/protocol"
)

// Helpers to build the stream-json lines Claude Code emits for task tools.
// Shapes captured from claude 2.1.170 (`--output-format stream-json`).

func taskUseLine(id, name, inputJSON string) string {
	return fmt.Sprintf(
		`{"type":"assistant","message":{"content":[{"type":"tool_use","id":%q,"name":%q,"input":%s}]}}`,
		id, name, inputJSON)
}

func taskResultLine(id, body string, isErr bool) string {
	return fmt.Sprintf(
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":%q,"is_error":%t,"content":%q}]}}`,
		id, isErr, body)
}

// lastSynthesizedTodos feeds lines through mapClaudeLine with a shared task
// state and returns the todos array of the last synthesized TodoWrite chunk.
func lastSynthesizedTodos(t *testing.T, lines []string) []any {
	t.Helper()
	tasks := newTaskListState()
	var todos []any
	for _, line := range lines {
		for _, c := range mapClaudeLine(line, nil, tasks, "") {
			if c.Kind != protocol.KindTool {
				continue
			}
			if c.Meta["tool"] != "TodoWrite" || c.Meta["synthesized"] != true {
				continue
			}
			input, _ := c.Meta["input"].(map[string]any)
			todos, _ = input["todos"].([]any)
		}
	}
	return todos
}

func todoAt(t *testing.T, todos []any, i int) map[string]any {
	t.Helper()
	if i >= len(todos) {
		t.Fatalf("want todo at index %d, only %d todos: %+v", i, len(todos), todos)
	}
	row, _ := todos[i].(map[string]any)
	if row == nil {
		t.Fatalf("todo %d is not a map: %+v", i, todos[i])
	}
	return row
}

// TestClaudeTaskCreateSynthesizesTodoWrite verifies the core flow: a
// TaskCreate result (which carries the assigned id) produces a synthesized
// full-list TodoWrite chunk, and the chunk for the tool_use itself stays
// untouched (real tool name, real id) so the timeline pairing still works.
func TestClaudeTaskCreateSynthesizesTodoWrite(t *testing.T) {
	tasks := newTaskListState()

	use := mapClaudeLine(
		taskUseLine("tu-1", "TaskCreate",
			`{"subject":"Set up project","description":"d","activeForm":"Setting up project"}`),
		nil, tasks, "")
	if len(use) != 1 || use[0].Meta["tool"] != "TaskCreate" {
		t.Fatalf("tool_use chunk should pass through unmodified, got %+v", use)
	}

	res := mapClaudeLine(
		taskResultLine("tu-1", "Task #1 created successfully: Set up project", false),
		nil, tasks, "")
	if len(res) != 2 {
		t.Fatalf("want result + synthesized chunk, got %d: %+v", len(res), res)
	}
	if res[0].Meta["toolResultFor"] != "tu-1" {
		t.Fatalf("first chunk should be the plain result, got %+v", res[0])
	}
	synth := res[1]
	if synth.Kind != protocol.KindTool || synth.Meta["tool"] != "TodoWrite" {
		t.Fatalf("want synthesized TodoWrite tool chunk, got %+v", synth)
	}
	if synth.Meta["id"] != "tu-1:todos" {
		t.Fatalf("synthesized id must not collide with the real tool_use id, got %v", synth.Meta["id"])
	}
	input, _ := synth.Meta["input"].(map[string]any)
	todos, _ := input["todos"].([]any)
	row := todoAt(t, todos, 0)
	if row["content"] != "Set up project" || row["status"] != "pending" ||
		row["activeForm"] != "Setting up project" {
		t.Fatalf("unexpected todo row: %+v", row)
	}
}

// TestClaudeTaskLifecycle walks create → in_progress → completed → delete
// and checks each synthesized snapshot reflects the whole list.
func TestClaudeTaskLifecycle(t *testing.T) {
	todos := lastSynthesizedTodos(t, []string{
		taskUseLine("tu-1", "TaskCreate", `{"subject":"Alpha","description":"d","activeForm":"Doing Alpha"}`),
		taskResultLine("tu-1", "Task #1 created successfully: Alpha", false),
		taskUseLine("tu-2", "TaskCreate", `{"subject":"Beta","description":"d"}`),
		taskResultLine("tu-2", "Task #2 created successfully: Beta", false),
		taskUseLine("tu-3", "TaskUpdate", `{"taskId":"1","status":"in_progress"}`),
		taskResultLine("tu-3", "Updated task #1 status", false),
	})
	if len(todos) != 2 {
		t.Fatalf("want 2 todos, got %+v", todos)
	}
	if r := todoAt(t, todos, 0); r["status"] != "in_progress" || r["content"] != "Alpha" {
		t.Fatalf("unexpected first row: %+v", r)
	}
	if r := todoAt(t, todos, 1); r["status"] != "pending" || r["content"] != "Beta" {
		t.Fatalf("unexpected second row: %+v", r)
	}

	// status:"deleted" permanently removes the task from the snapshot.
	todos = lastSynthesizedTodos(t, []string{
		taskUseLine("tu-1", "TaskCreate", `{"subject":"Alpha","description":"d"}`),
		taskResultLine("tu-1", "Task #1 created successfully: Alpha", false),
		taskUseLine("tu-2", "TaskCreate", `{"subject":"Beta","description":"d"}`),
		taskResultLine("tu-2", "Task #2 created successfully: Beta", false),
		taskUseLine("tu-3", "TaskUpdate", `{"taskId":"2","status":"deleted"}`),
		taskResultLine("tu-3", "Updated task #2 deleted", false),
	})
	if len(todos) != 1 {
		t.Fatalf("deleted task should be removed, got %+v", todos)
	}
	if r := todoAt(t, todos, 0); r["content"] != "Alpha" {
		t.Fatalf("unexpected survivor: %+v", r)
	}
}

// TestClaudeTaskListResync verifies TaskList output rebuilds the snapshot —
// the resume case where tasks were created before this sidecar run. Owner
// "(agent-1)" stays in the parsed subject (we can't strip it safely), but
// the "[blocked by #N]" suffix is removed; statuses come from the listing.
func TestClaudeTaskListResync(t *testing.T) {
	todos := lastSynthesizedTodos(t, []string{
		taskUseLine("tu-1", "TaskList", `{}`),
		taskResultLine("tu-1",
			"#1 [in_progress] Alpha (agent-1)\n#2 [pending] Beta [blocked by #1]\n#3 [completed] Gamma",
			false),
	})
	if len(todos) != 3 {
		t.Fatalf("want 3 todos, got %+v", todos)
	}
	if r := todoAt(t, todos, 0); r["status"] != "in_progress" || r["content"] != "Alpha (agent-1)" {
		t.Fatalf("unexpected row 0: %+v", r)
	}
	if r := todoAt(t, todos, 1); r["status"] != "pending" || r["content"] != "Beta" {
		t.Fatalf("blocked-by suffix should be stripped, got %+v", r)
	}
	if r := todoAt(t, todos, 2); r["status"] != "completed" || r["content"] != "Gamma" {
		t.Fatalf("unexpected row 2: %+v", r)
	}
}

// TestClaudeTaskListResyncKeepsAuthoritativeSubjects verifies a resync does
// not clobber subjects learned from TaskCreate inputs (the listing's subject
// can carry owner suffixes), while a task absent from the listing is dropped.
func TestClaudeTaskListResyncKeepsAuthoritativeSubjects(t *testing.T) {
	todos := lastSynthesizedTodos(t, []string{
		taskUseLine("tu-1", "TaskCreate", `{"subject":"Alpha","description":"d","activeForm":"Doing Alpha"}`),
		taskResultLine("tu-1", "Task #1 created successfully: Alpha", false),
		taskUseLine("tu-2", "TaskCreate", `{"subject":"Beta","description":"d"}`),
		taskResultLine("tu-2", "Task #2 created successfully: Beta", false),
		taskUseLine("tu-3", "TaskList", `{}`),
		// Beta missing (deleted elsewhere); Alpha shows an owner suffix.
		taskResultLine("tu-3", "#1 [in_progress] Alpha (agent-1)", false),
	})
	if len(todos) != 1 {
		t.Fatalf("unlisted task should be dropped, got %+v", todos)
	}
	r := todoAt(t, todos, 0)
	if r["content"] != "Alpha" {
		t.Fatalf("authoritative subject should survive resync, got %+v", r)
	}
	if r["status"] != "in_progress" || r["activeForm"] != "Doing Alpha" {
		t.Fatalf("status should resync and activeForm persist, got %+v", r)
	}
}

// TestClaudeTaskUpdateUnknownIDPlaceholder verifies a TaskUpdate for a task
// created before this run (post --resume) renders a placeholder row instead
// of being dropped, and an empty TaskList clears the snapshot.
func TestClaudeTaskUpdateUnknownIDPlaceholder(t *testing.T) {
	todos := lastSynthesizedTodos(t, []string{
		taskUseLine("tu-1", "TaskUpdate", `{"taskId":"7","status":"in_progress"}`),
		taskResultLine("tu-1", "Updated task #7 status", false),
	})
	if len(todos) != 1 {
		t.Fatalf("want placeholder todo, got %+v", todos)
	}
	if r := todoAt(t, todos, 0); r["content"] != "Task #7" || r["status"] != "in_progress" {
		t.Fatalf("unexpected placeholder: %+v", r)
	}

	todos = lastSynthesizedTodos(t, []string{
		taskUseLine("tu-1", "TaskList", `{}`),
		taskResultLine("tu-1", "No tasks found", false),
	})
	if len(todos) != 0 {
		t.Fatalf(`"No tasks found" should clear the snapshot, got %+v`, todos)
	}
}

// TestClaudeTaskErrorResultMutatesNothing verifies an is_error result clears
// the pending slot without applying the mutation or emitting a snapshot.
func TestClaudeTaskErrorResultMutatesNothing(t *testing.T) {
	tasks := newTaskListState()
	mapClaudeLine(taskUseLine("tu-1", "TaskCreate", `{"subject":"Alpha","description":"d"}`), nil, tasks, "")
	res := mapClaudeLine(taskResultLine("tu-1", "Error: task list unavailable", true), nil, tasks, "")
	if len(res) != 1 {
		t.Fatalf("errored result must not emit a synthesized chunk, got %+v", res)
	}
	if res[0].Kind != protocol.KindStderr {
		t.Fatalf("want stderr result chunk, got %+v", res[0])
	}
	if len(tasks.tasks) != 0 || len(tasks.pending) != 0 {
		t.Fatalf("state must stay empty after errored create: %+v", tasks)
	}
}

// TestClaudeNonTaskResultNoSnapshot pins that ordinary tool results (Bash,
// Read, …) don't grow a synthesized chunk even with task state present.
func TestClaudeNonTaskResultNoSnapshot(t *testing.T) {
	tasks := newTaskListState()
	mapClaudeLine(taskUseLine("tu-1", "Bash", `{"command":"ls"}`), nil, tasks, "")
	res := mapClaudeLine(taskResultLine("tu-1", "file.txt", false), nil, tasks, "")
	if len(res) != 1 {
		t.Fatalf("non-task result should emit exactly one chunk, got %+v", res)
	}
}
