package adapter

import (
	"fmt"
	"regexp"
	"strings"
	"sync"
)

// This file reconstructs Claude Code's session task list from the new
// TaskCreate / TaskUpdate / TaskList tools (Claude Code ≥ 2.1.x) so the
// dashboard's TodoWindow keeps working. Unlike the old TodoWrite tool —
// where every call carried the FULL todos array in its input — the Task*
// tools are incremental:
//
//	TaskCreate  input  {subject, description, activeForm?, metadata?}
//	            result "Task #7 created successfully: <subject>"   ← id only here
//	TaskUpdate  input  {taskId, status?, subject?, activeForm?, owner?,
//	                    addBlocks?, addBlockedBy?, ...}
//	            status pending | in_progress | completed | deleted (= remove)
//	TaskList    input  {}
//	            result "#1 [in_progress] Subject (owner)\n#2 [pending] Subject [blocked by #1]"
//	            or     "No tasks found"
//
// No single event carries the whole list, so the mapper stashes each task
// tool_use, applies it when the matching (successful) tool_result arrives,
// and emits a synthesized TodoWrite-shaped chunk with the full snapshot.
// The web UI then renders it exactly like a native TodoWrite call — same
// path as cursor-agent's normalised todo tools (see cursorPrunedInput).
//
// TaskList results matter beyond display: on --resume the sidecar starts
// with empty state while the session already has tasks, and the first
// TaskList resyncs us. Subjects parsed from TaskList output are second
// class (the line may carry owner/blocked-by suffixes we can't always
// strip safely), so subjects learned from TaskCreate/TaskUpdate inputs are
// authoritative and never overwritten by a resync.
//
// Like fileEditState, the state lives for one Execute() only and all
// methods are nil-receiver safe so tests (and adapters without task
// support) can pass nil.

type taskEntry struct {
	subject    string
	activeForm string
	status     string
	// subjectKnown marks subjects learned from tool INPUTS (authoritative)
	// as opposed to parsed out of TaskList result text (best-effort).
	subjectKnown bool
}

type taskCall struct {
	tool  string
	input map[string]any
}

type taskListState struct {
	mu      sync.Mutex
	pending map[string]taskCall   // tool_use id → call awaiting its result
	tasks   map[string]*taskEntry // task id → entry
	order   []string              // task ids in creation / listed order
	synthID int                   // fallback ids when result parsing fails
}

func newTaskListState() *taskListState {
	return &taskListState{
		pending: map[string]taskCall{},
		tasks:   map[string]*taskEntry{},
	}
}

// isClaudeTaskTool reports whether a tool mutates or lists the session task
// list. TaskGet is deliberately absent: it reads a single task and its
// result adds nothing the snapshot needs.
func isClaudeTaskTool(name string) bool {
	switch name {
	case "TaskCreate", "TaskUpdate", "TaskList":
		return true
	}
	return false
}

// RememberCall stashes a task tool_use until its result arrives. We can't
// apply TaskCreate at call time because the assigned task id only appears
// in the result text, and applying TaskUpdate before the CLI confirms it
// would show state the agent may have failed to reach.
func (s *taskListState) RememberCall(toolUseID, tool string, input map[string]any) {
	if s == nil || toolUseID == "" || !isClaudeTaskTool(tool) {
		return
	}
	s.mu.Lock()
	s.pending[toolUseID] = taskCall{tool: tool, input: input}
	s.mu.Unlock()
}

// ApplyResult applies the call stashed under toolUseID now that its result
// body arrived. Returns (todos snapshot, true) when this was a successful
// task tool result — the caller should emit a synthesized TodoWrite chunk.
// Errored results still clear the pending slot but mutate nothing.
func (s *taskListState) ApplyResult(toolUseID, body string, isErr bool) ([]any, bool) {
	if s == nil || toolUseID == "" {
		return nil, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	call, ok := s.pending[toolUseID]
	if !ok {
		return nil, false
	}
	delete(s.pending, toolUseID)
	if isErr {
		return nil, false
	}
	switch call.tool {
	case "TaskCreate":
		s.applyCreate(call.input, body)
	case "TaskUpdate":
		s.applyUpdate(call.input)
	case "TaskList":
		s.resyncFromList(body)
	}
	return s.todos(), true
}

// taskCreatedIDRe pulls the assigned id out of the TaskCreate result text
// ("Task #7 created successfully: <subject>").
var taskCreatedIDRe = regexp.MustCompile(`(?i)task #([0-9A-Za-z_-]+) created`)

func (s *taskListState) applyCreate(input map[string]any, body string) {
	id := ""
	if m := taskCreatedIDRe.FindStringSubmatch(body); m != nil {
		id = m[1]
	}
	if id == "" {
		// Result text drifted; keep the task under a synthetic id so it
		// still renders. A later TaskList resync replaces the whole list
		// (synthetic ids never appear there) and heals the bookkeeping.
		s.synthID++
		id = fmt.Sprintf("synth-%d", s.synthID)
	}
	e := s.ensure(id)
	if subj, _ := input["subject"].(string); subj != "" {
		e.subject = subj
		e.subjectKnown = true
	}
	if af, _ := input["activeForm"].(string); af != "" {
		e.activeForm = af
	}
	e.status = "pending"
}

func (s *taskListState) applyUpdate(input map[string]any) {
	id, _ := input["taskId"].(string)
	if id == "" {
		return
	}
	status, _ := input["status"].(string)
	if status == "deleted" {
		s.remove(id)
		return
	}
	// Updates to ids we never saw created happen after --resume (the task
	// predates this run). ensure() shows a "Task #<id>" placeholder until
	// a TaskList resync supplies the real subject.
	e := s.ensure(id)
	if status != "" {
		e.status = normaliseTaskStatus(status)
	}
	if subj, _ := input["subject"].(string); subj != "" {
		e.subject = subj
		e.subjectKnown = true
	}
	if af, _ := input["activeForm"].(string); af != "" {
		e.activeForm = af
	}
}

// taskListLineRe matches one TaskList result line:
//
//	#<id> [<status>] <subject>[ (owner)][ [blocked by #N, ...]]
var taskListLineRe = regexp.MustCompile(`^#([0-9A-Za-z_-]+) \[([a-z_]+)\] (.+)$`)

// taskBlockedSuffixRe strips the trailing "[blocked by #1, #2]" annotation.
// The "(owner)" suffix is NOT stripped — it's indistinguishable from a
// subject that legitimately ends in parentheses, and it only ever shows on
// placeholder rows (authoritative subjects from inputs win over parsed ones).
var taskBlockedSuffixRe = regexp.MustCompile(`\s*\[blocked by [^\]]*\]$`)

// resyncFromList rebuilds the list from TaskList output: listed order wins,
// ids missing from the output were deleted, ids we already track keep their
// authoritative subject/activeForm and only take the status.
func (s *taskListState) resyncFromList(body string) {
	type row struct{ id, status, subject string }
	rows := []row{}
	for _, line := range strings.Split(body, "\n") {
		m := taskListLineRe.FindStringSubmatch(strings.TrimSpace(line))
		if m == nil {
			continue
		}
		subject := strings.TrimSpace(taskBlockedSuffixRe.ReplaceAllString(m[3], ""))
		rows = append(rows, row{id: m[1], status: normaliseTaskStatus(m[2]), subject: subject})
	}
	if len(rows) == 0 {
		// "No tasks found" (or any unparseable body) — only trust an
		// explicit empty marker; otherwise keep current state rather than
		// wiping the panel on a format change.
		if strings.Contains(body, "No tasks") {
			s.tasks = map[string]*taskEntry{}
			s.order = nil
		}
		return
	}
	tasks := make(map[string]*taskEntry, len(rows))
	order := make([]string, 0, len(rows))
	for _, r := range rows {
		e := s.tasks[r.id]
		if e == nil || !e.subjectKnown {
			e = &taskEntry{subject: r.subject}
			if old := s.tasks[r.id]; old != nil {
				e.activeForm = old.activeForm
			}
		}
		e.status = r.status
		tasks[r.id] = e
		order = append(order, r.id)
	}
	s.tasks = tasks
	s.order = order
}

func (s *taskListState) ensure(id string) *taskEntry {
	if e := s.tasks[id]; e != nil {
		return e
	}
	e := &taskEntry{subject: "Task #" + id, status: "pending"}
	s.tasks[id] = e
	s.order = append(s.order, id)
	return e
}

func (s *taskListState) remove(id string) {
	if _, ok := s.tasks[id]; !ok {
		return
	}
	delete(s.tasks, id)
	for i, v := range s.order {
		if v == id {
			s.order = append(s.order[:i], s.order[i+1:]...)
			break
		}
	}
}

// todos renders the current state in TodoWrite input shape —
// [{content, status, activeForm?}] — which is what TodoWindow expects.
// Caller must hold s.mu.
func (s *taskListState) todos() []any {
	out := make([]any, 0, len(s.order))
	for _, id := range s.order {
		e := s.tasks[id]
		if e == nil {
			continue
		}
		row := map[string]any{"content": e.subject, "status": e.status}
		if e.activeForm != "" {
			row["activeForm"] = e.activeForm
		}
		out = append(out, row)
	}
	return out
}

// normaliseTaskStatus clamps to TodoWrite's three statuses; unknown values
// render as pending rather than dropping the row (mirrors the cursor
// adapter's normaliseCursorTodoStatus).
func normaliseTaskStatus(s string) string {
	switch strings.ToLower(s) {
	case "completed", "in_progress", "pending":
		return strings.ToLower(s)
	}
	return "pending"
}
