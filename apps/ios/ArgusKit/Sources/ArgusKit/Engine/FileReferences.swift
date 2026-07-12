import Foundation

/// File-path plumbing for the transcript's file-preview flow — a pure
/// port of the web's `FileChips.tsx` helpers (`extractFiles`,
/// `displayPath`, `splitLineSuffix`, `toAgentRelative`). Keep the
/// semantics identical: which chips appear, how paths abbreviate, and
/// which `path:line` citations count must match across clients.
public enum FileReferences {
    /// Tools whose path argument is a directory or a command line — not
    /// an openable file preview.
    private static let skippedTools: Set<String> = [
        "bash", "shell", "ls", "list_dir", "glob", "grep",
    ]

    /// Pull file paths out of tool inputs (`file_path`, `path`,
    /// `filename`, `files[]`, …), deduped in first-seen order — the
    /// artefacts the agent actually touched.
    public static func extractFiles(_ chunks: [ResultChunk]) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for chunk in chunks where chunk.kind == .tool {
            let meta = chunk.meta ?? [:]
            let tool = (meta["tool"]?.string ?? "").lowercased()
            if skippedTools.contains(tool) { continue }
            let input = meta["input"]?.object ?? [:]

            var candidates: [String] = []
            for key in ["file_path", "filePath", "path", "filename", "file"] {
                if let value = input[key]?.string { candidates.append(value) }
            }
            for key in ["files", "paths"] {
                for value in input[key]?.array ?? [] {
                    if let string = value.string { candidates.append(string) }
                }
            }

            for path in candidates where !path.isEmpty && !seen.contains(path) {
                seen.insert(path)
                out.append(path)
            }
        }
        return out
    }

    /// Strip the agent's workingDir prefix off an absolute path so chips
    /// show the part that changes. Falls back to the absolute form when
    /// there's no workingDir, the path is already relative, or it lives
    /// OUTSIDE the workspace (then the absolute path IS the signal).
    /// The `dir + "/"` boundary check stops `/work/proj` from matching
    /// `/work/projx/file.ts`.
    public static func displayPath(_ absolute: String, workingDir: String?) -> String {
        guard let workingDir, !workingDir.isEmpty else { return absolute }
        guard absolute.hasPrefix("/") else { return absolute }
        let dir = workingDir.hasSuffix("/") ? String(workingDir.dropLast()) : workingDir
        if absolute == dir { return "." }
        if absolute.hasPrefix(dir + "/") { return String(absolute.dropFirst(dir.count + 1)) }
        return absolute
    }

    /// Split a `path:line` / `path:line:col` citation (the form CLI
    /// agents use, e.g. `src/foo.go:123`) into path + line. The path
    /// part must contain `.` or `/` to count — that keeps URI schemes
    /// (`tel:123`) and bare words out; `Makefile:12` is the accepted
    /// miss (indistinguishable from a scheme). Columns parse but drop —
    /// the viewer scrolls to lines.
    public static func splitLineSuffix(_ path: String) -> (path: String, line: Int?) {
        // Lazy match so `src/foo.go:123:45` splits at the FIRST numeric
        // suffix (line 123, col 45).
        guard let match = path.firstMatch(of: #/^(.+?):([0-9]+)(?::[0-9]+)?$/#) else {
            return (path, nil)
        }
        let bare = String(match.1)
        guard bare.contains(".") || bare.contains("/") else { return (path, nil) }
        return (bare, Int(match.2))
    }

    /// Convert a chip path to the form `fs/read` accepts — relative to
    /// the agent's workingDir, and not a directory. nil = unopenable
    /// (outside the workspace, or directory-shaped).
    public static func toAgentRelative(_ path: String, workingDir: String?) -> String? {
        var relative: String
        if path.hasPrefix("/") {
            relative = displayPath(path, workingDir: workingDir)
            if relative == path { return nil }
        } else {
            relative = path
        }
        if relative.isEmpty || relative == "." || relative.hasSuffix("/") { return nil }
        return relative
    }
}
