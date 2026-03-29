// Package tools defines all available agent tools with JSON schemas
// and provides stage-based filtering.
package tools

// ToolDefinition describes a tool available to agents.
type ToolDefinition struct {
	Name        string      `json:"name"`
	Description string      `json:"description"`
	InputSchema interface{} `json:"input_schema"`
	WriteAccess bool        `json:"-"` // internal: does this tool modify state?
}

// AllTools returns all available tool definitions.
func AllTools() []ToolDefinition {
	return []ToolDefinition{
		{
			Name:        "read_file",
			Description: "Read the contents of a file. Returns the full text content.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"path": map[string]interface{}{"type": "string", "description": "File path relative to workspace root"},
				},
				"required": []string{"path"},
			},
		},
		{
			Name:        "read_file_range",
			Description: "Read specific line range from a file. Returns numbered lines.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"path":       map[string]interface{}{"type": "string", "description": "File path"},
					"start_line": map[string]interface{}{"type": "integer", "description": "First line (1-indexed)"},
					"end_line":   map[string]interface{}{"type": "integer", "description": "Last line (1-indexed)"},
				},
				"required": []string{"path", "start_line", "end_line"},
			},
		},
		{
			Name:        "write_file",
			Description: "Create or overwrite a file with the given content. Creates parent directories automatically.",
			WriteAccess: true,
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"path":    map[string]interface{}{"type": "string", "description": "File path to write"},
					"content": map[string]interface{}{"type": "string", "description": "Complete file content"},
				},
				"required": []string{"path", "content"},
			},
		},
		{
			Name:        "edit_file",
			Description: "Apply a search-and-replace edit to an existing file. The search text must be unique in the file.",
			WriteAccess: true,
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"path":     map[string]interface{}{"type": "string", "description": "File path to edit"},
					"old_text": map[string]interface{}{"type": "string", "description": "Exact text to find (must be unique)"},
					"new_text": map[string]interface{}{"type": "string", "description": "Replacement text"},
				},
				"required": []string{"path", "old_text", "new_text"},
			},
		},
		{
			Name:        "list_files",
			Description: "List files in the workspace, optionally filtered by glob pattern.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"pattern": map[string]interface{}{"type": "string", "description": "Glob pattern (e.g., '*.java', '**/*.ts'). Default: all files"},
				},
			},
		},
		{
			Name:        "search_code",
			Description: "Search for a text pattern across all source files. Returns matching lines with file paths and line numbers.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"query":       map[string]interface{}{"type": "string", "description": "Search text (case-insensitive)"},
					"max_results": map[string]interface{}{"type": "integer", "description": "Maximum results (default: 50)"},
				},
				"required": []string{"query"},
			},
		},
		{
			Name:        "file_stats",
			Description: "Get metadata about a file or directory: size, line count, modification time.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"path": map[string]interface{}{"type": "string", "description": "File or directory path"},
				},
				"required": []string{"path"},
			},
		},
		{
			Name:        "shell_exec",
			Description: "Execute a shell command in the workspace. Only allowlisted commands (ls, find, grep, npm, go, git, etc.).",
			WriteAccess: true,
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"command": map[string]interface{}{"type": "string", "description": "Shell command to execute"},
				},
				"required": []string{"command"},
			},
		},
		{
			Name:        "batch_read_files",
			Description: "Read multiple files at once. More efficient than individual read_file calls.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"paths": map[string]interface{}{
						"type":  "array",
						"items": map[string]interface{}{"type": "string"},
						"description": "Array of file paths to read",
					},
				},
				"required": []string{"paths"},
			},
		},
	}
}

// ToolsForStage returns tools available for a given pipeline stage.
// Read-only stages (SCAN, DECODE) get only read tools.
// Write stages (FORGE, EVOLVE) get all tools.
func ToolsForStage(stageIndex int) []ToolDefinition {
	all := AllTools()

	// Stages 0-4 (SCAN, DECODE, BLUEPRINT, SPEC_LOCK, ARCHITECT): read-only
	if stageIndex <= 4 {
		var readOnly []ToolDefinition
		for _, t := range all {
			if !t.WriteAccess {
				readOnly = append(readOnly, t)
			}
		}
		return readOnly
	}

	// Stages 5+ (FORGE, SHADOW_RUN, EVOLVE): full access
	return all
}

// ToolsByPermission filters tools by a permission list.
func ToolsByPermission(permissions []string) []ToolDefinition {
	permSet := make(map[string]bool)
	for _, p := range permissions {
		permSet[p] = true
	}

	all := AllTools()
	var filtered []ToolDefinition
	for _, t := range all {
		// Map tool names to permission categories
		switch {
		case t.Name == "read_file" || t.Name == "read_file_range" || t.Name == "batch_read_files":
			if permSet["read_code"] {
				filtered = append(filtered, t)
			}
		case t.Name == "write_file" || t.Name == "edit_file":
			if permSet["write_code"] {
				filtered = append(filtered, t)
			}
		case t.Name == "search_code" || t.Name == "list_files" || t.Name == "file_stats":
			if permSet["search_code"] || permSet["read_code"] {
				filtered = append(filtered, t)
			}
		case t.Name == "shell_exec":
			if permSet["shell_exec"] {
				filtered = append(filtered, t)
			}
		}
	}
	return filtered
}
