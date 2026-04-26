package adapter

import (
	"fmt"
	"strings"

	"github.com/kr4t0n/argus/sidecar/internal/protocol"
)

// mapCursorLine handles cursor-agent's stream-json schema, which is similar
// to Claude Code's for `system`/`assistant`/`result` events but uses a
// different shape for tool calls:
//
//	{type:"system",   subtype:"init",     session_id:"..."}
//	{type:"assistant",message:{role:"assistant",content:[{type:"text",text:"..."}]}}
//	{type:"user",     message:{...}}                       (our own prompt — dropped)
//	{type:"tool_call",subtype:"started",  call_id:"...", tool_call:{<kind>ToolCall:{args:{...}}}}
//	{type:"tool_call",subtype:"completed",call_id:"...", tool_call:{<kind>ToolCall:{args:{...},result:{success|failure:{...}}}}}
//	{type:"result",   subtype:"success",  result:"...", session_id:"..."}
//
// Tool-call payloads are discriminated by a single key on `tool_call`
// (`shellToolCall`, `readToolCall`, `editToolCall`, …) rather than by an
// explicit `name`. We normalise that key into a Claude/Codex-style tool
// name (`Bash`, `Read`, `Edit`, …) so the dashboard's timeline pairs the
// started/completed pair into one card via the shared `id`/`toolResultFor`
// meta convention.
func mapCursorLine(line string, _ *fileEditState, _ string) []Chunk {
	ev := TryParseJSON(line)
	if ev == nil {
		return []Chunk{{Kind: protocol.KindDelta, Delta: line}}
	}
	t, _ := ev["type"].(string)
	switch t {
	case "system":
		if sub, _ := ev["subtype"].(string); sub == "init" {
			sid, _ := ev["session_id"].(string)
			if sid != "" {
				return []Chunk{{
					Kind:       protocol.KindProgress,
					Content:    "session initialised",
					Meta:       ev,
					ExternalID: sid,
				}}
			}
		}
		return []Chunk{{Kind: protocol.KindProgress, Content: t, Meta: ev}}

	case "assistant":
		msg, _ := ev["message"].(map[string]any)
		contents, _ := msg["content"].([]any)
		out := []Chunk{}
		for _, c := range contents {
			item, _ := c.(map[string]any)
			if item["type"] == "text" {
				if s, _ := item["text"].(string); s != "" {
					out = append(out, Chunk{Kind: protocol.KindDelta, Delta: s})
				}
			}
		}
		return out

	case "user":
		// cursor-agent echoes our own prompt back as a user event. Drop it —
		// the dashboard already shows the user turn from its own input box,
		// and emitting progress here would clutter the activity pill.
		return nil

	case "tool_call":
		return mapCursorToolCall(ev)

	case "result":
		sub, _ := ev["subtype"].(string)
		isErr, _ := ev["is_error"].(bool)
		if isErr || sub == "error" {
			msg, _ := ev["result"].(string)
			if msg == "" {
				msg, _ = ev["error"].(string)
			}
			return []Chunk{{Kind: protocol.KindError, Content: msg, Meta: ev, IsFinal: true}}
		}
		txt, _ := ev["result"].(string)
		return []Chunk{{Kind: protocol.KindFinal, Content: txt, Meta: ev, IsFinal: true}}
	}

	return nil // drop unknown events instead of emitting empty progress
}

// mapCursorToolCall turns one tool_call event (started or completed) into
// one Chunk. We pick the single `*ToolCall` key out of `tool_call`, derive
// a friendly tool name from it, and emit a tool/result chunk pair keyed by
// `call_id` so the UI's timeline assembler stitches them together.
func mapCursorToolCall(ev map[string]any) []Chunk {
	sub, _ := ev["subtype"].(string)
	callID, _ := ev["call_id"].(string)
	tc, _ := ev["tool_call"].(map[string]any)
	if tc == nil {
		return nil
	}
	kindKey, payload := pickCursorToolKind(tc)
	if kindKey == "" {
		return nil
	}
	args, _ := payload["args"].(map[string]any)
	toolName := cursorToolNameFromKey(kindKey)

	switch sub {
	case "started":
		display := cursorToolDisplay(kindKey, args)
		return []Chunk{{
			Kind:    protocol.KindTool,
			Content: strings.TrimSpace(toolName + " " + display),
			Meta: map[string]any{
				"tool":  toolName,
				"input": cursorPrunedInput(kindKey, args),
				"id":    callID,
			},
		}}

	case "completed":
		result, _ := payload["result"].(map[string]any)
		return cursorResultChunk(kindKey, callID, result)
	}
	return nil
}

// cursorResultChunk renders the `result.{success|failure|error}` payload of
// a completed tool call into one result chunk slotted under the matching
// tool card via `toolResultFor`. The three shapes mean different things:
//
//   - success: tool ran normally, render its typed payload.
//   - failure: tool ran but reported a non-zero outcome (used by shell to
//     report exit codes; payload is the SAME shape as success, just with
//     exitCode != 0). We render it through the same per-tool formatter so
//     the user still sees the command, stdout, stderr.
//   - error:   tool couldn't run at all (used by read for missing files,
//     etc). Payload is `{errorMessage: "..."}`. We render as a stderr
//     chunk so the UI shows it as a red error block under the card.
//
// For edit-style tools we lean on the CLI-provided `diffString` so the UI
// shows a real diff card identical to Claude / Codex output.
func cursorResultChunk(kindKey, callID string, result map[string]any) []Chunk {
	if result == nil {
		return nil
	}

	if errPayload, ok := result["error"].(map[string]any); ok {
		body := firstString(errPayload, "errorMessage", "message", "error")
		if body == "" {
			body, _ = marshal(errPayload)
		}
		return []Chunk{{
			Kind:    protocol.KindStderr,
			Content: body,
			Meta:    map[string]any{"toolResultFor": callID, "failure": true},
		}}
	}

	payload, _ := result["success"].(map[string]any)
	failed := false
	if payload == nil {
		if f, ok := result["failure"].(map[string]any); ok {
			payload = f
			failed = true
		}
	}
	if payload == nil {
		return nil
	}

	switch kindKey {
	case "shellToolCall":
		body := firstString(payload, "stdout", "interleavedOutput", "output")
		if body == "" {
			body = firstString(payload, "stderr")
		}
		exit := exitCodeFromItem(payload)
		kind := protocol.KindStdout
		if exit != 0 || failed {
			kind = protocol.KindStderr
		}
		return []Chunk{{
			Kind:    kind,
			Content: body,
			Meta: map[string]any{
				"toolResultFor": callID,
				"exitCode":      exit,
			},
		}}

	case "editToolCall", "writeToolCall", "createToolCall", "deleteToolCall":
		path := firstString(payload, "path", "file_path")
		diff := firstString(payload, "diffString", "diff")
		if diff != "" {
			return []Chunk{{
				Kind:    protocol.KindStdout,
				Content: truncateDiff(diff, maxDiffLines),
				Meta: map[string]any{
					"toolResultFor": callID,
					"isDiff":        true,
					"filePath":      path,
					"changeKind":    cursorChangeKindFromKey(kindKey),
				},
			}}
		}
		body := firstString(payload, "message")
		if body == "" {
			body = fmt.Sprintf("%s %s", cursorChangeKindFromKey(kindKey), path)
		}
		return []Chunk{{
			Kind:    protocol.KindStdout,
			Content: body,
			Meta:    map[string]any{"toolResultFor": callID, "filePath": path},
		}}

	case "readToolCall":
		body := firstString(payload, "content")
		if body == "" {
			body, _ = marshal(payload)
		}
		return []Chunk{{
			Kind:    protocol.KindStdout,
			Content: body,
			Meta: map[string]any{
				"toolResultFor": callID,
				"filePath":      firstString(payload, "path", "file_path"),
			},
		}}

	case "globToolCall":
		// payload: {path, pattern, files: [...], totalFiles, ...}
		// Render as a one-file-per-line listing so it reads like real
		// Glob output instead of a JSON dump.
		files := toAnySlice(payload["files"])
		lines := make([]string, 0, len(files))
		for _, f := range files {
			if s, ok := f.(string); ok {
				lines = append(lines, s)
			}
		}
		body := strings.Join(lines, "\n")
		if body == "" {
			body = "(no matches)"
		}
		return []Chunk{{
			Kind:    protocol.KindStdout,
			Content: body,
			Meta: map[string]any{
				"toolResultFor": callID,
				"matchCount":    len(lines),
			},
		}}

	case "grepToolCall", "searchToolCall":
		// Best-effort: most search results are either a `matches` array of
		// {file,line,text} or a flat `output` string. Try both.
		if matches := toAnySlice(payload["matches"]); len(matches) > 0 {
			lines := make([]string, 0, len(matches))
			for _, m := range matches {
				mm := toMap(m)
				if mm == nil {
					continue
				}
				file := firstString(mm, "file", "path")
				line := firstString(mm, "line")
				text := firstString(mm, "text", "content")
				lines = append(lines, strings.TrimSpace(fmt.Sprintf("%s:%s %s", file, line, text)))
			}
			return []Chunk{{
				Kind:    protocol.KindStdout,
				Content: strings.Join(lines, "\n"),
				Meta:    map[string]any{"toolResultFor": callID, "matchCount": len(lines)},
			}}
		}
		body := firstString(payload, "output", "stdout", "content")
		if body == "" {
			body, _ = marshal(payload)
		}
		return []Chunk{{
			Kind:    protocol.KindStdout,
			Content: body,
			Meta:    map[string]any{"toolResultFor": callID},
		}}
	}

	// Generic tool: JSON-stringify the payload so we never hide a result,
	// even if cursor adds a new tool type tomorrow.
	body, _ := marshal(payload)
	return []Chunk{{
		Kind:    protocol.KindStdout,
		Content: body,
		Meta:    map[string]any{"toolResultFor": callID},
	}}
}

// pickCursorToolKind returns the first `*ToolCall` key on the tool_call
// envelope and its payload. There's typically only ever one such key.
func pickCursorToolKind(tc map[string]any) (string, map[string]any) {
	for k, v := range tc {
		if !strings.HasSuffix(k, "ToolCall") {
			continue
		}
		if m, ok := v.(map[string]any); ok {
			return k, m
		}
	}
	return "", nil
}

// cursorToolNameFromKey converts e.g. "shellToolCall" → "Bash" for the
// well-known tools, or falls back to a Title-cased prefix ("foo" → "Foo").
// We pick names that match Claude/Codex equivalents so the UI's per-tool
// styling (icons, colors) lights up uniformly across adapters.
func cursorToolNameFromKey(key string) string {
	switch key {
	case "shellToolCall":
		return "Bash"
	case "readToolCall":
		return "Read"
	case "editToolCall":
		return "Edit"
	case "writeToolCall", "createToolCall":
		return "Write"
	case "deleteToolCall":
		return "Delete"
	case "globToolCall":
		return "Glob"
	case "grepToolCall", "searchToolCall":
		return "Grep"
	case "listToolCall", "listDirectoryToolCall", "lsToolCall":
		return "LS"
	case "webSearchToolCall":
		return "WebSearch"
	case "webFetchToolCall":
		return "WebFetch"
	case "todoToolCall", "todoWriteToolCall":
		return "TodoWrite"
	}
	prefix := strings.TrimSuffix(key, "ToolCall")
	if prefix == "" {
		return "Tool"
	}
	return strings.ToUpper(prefix[:1]) + prefix[1:]
}

func cursorChangeKindFromKey(key string) string {
	switch key {
	case "writeToolCall", "createToolCall":
		return "add"
	case "deleteToolCall":
		return "delete"
	default:
		return "update"
	}
}

// cursorToolDisplay produces the dim-monospace argument suffix shown next
// to the tool name on the started chunk. We hand-pick concise summaries
// per tool so the pill stays scannable.
func cursorToolDisplay(kindKey string, args map[string]any) string {
	if args == nil {
		return ""
	}
	switch kindKey {
	case "shellToolCall":
		if d := firstString(args, "description"); d != "" {
			return d
		}
		return firstString(args, "command")
	case "readToolCall", "editToolCall", "writeToolCall",
		"createToolCall", "deleteToolCall":
		return firstString(args, "path", "file_path", "filePath")
	case "globToolCall":
		pat := firstString(args, "globPattern", "pattern", "glob")
		dir := firstString(args, "targetDirectory", "path", "directory")
		switch {
		case pat != "" && dir != "":
			return pat + " in " + dir
		case pat != "":
			return pat
		default:
			return dir
		}
	case "grepToolCall", "searchToolCall":
		return firstString(args, "pattern", "query", "regex")
	case "listToolCall", "listDirectoryToolCall", "lsToolCall":
		return firstString(args, "path", "directory", "targetDirectory")
	case "webSearchToolCall":
		return firstString(args, "query", "search_term")
	case "webFetchToolCall":
		return firstString(args, "url")
	}
	return FormatToolArgs(args)
}

// cursorPrunedInput strips fields that would bloat the meta blob without
// helping the UI (e.g. shellToolCall.parsingResult, the full file content
// in editToolCall.streamContent). The pruned map is what we serialise into
// the chunk meta so the dashboard can show "input" details without the
// noise.
func cursorPrunedInput(kindKey string, args map[string]any) map[string]any {
	if args == nil {
		return nil
	}
	out := map[string]any{}
	switch kindKey {
	case "shellToolCall":
		for _, k := range []string{"command", "description", "workingDirectory", "timeout", "isBackground"} {
			if v, ok := args[k]; ok {
				out[k] = v
			}
		}
	case "editToolCall", "writeToolCall", "createToolCall":
		for _, k := range []string{"path", "file_path"} {
			if v, ok := args[k]; ok {
				out[k] = v
			}
		}
		// Intentionally drop streamContent / contents — we'd rather render
		// the diff in the result chunk than inflate the started chunk with
		// the full new file contents.
	default:
		for k, v := range args {
			out[k] = v
		}
	}
	return out
}
