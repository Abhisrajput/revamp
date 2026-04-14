package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// ToolResult represents the result of executing a tool.
type ToolResult struct {
	ToolName   string `json:"tool_name"`
	Success    bool   `json:"success"`
	Output     string `json:"output"`
	Error      string `json:"error,omitempty"`
	DurationMs int64  `json:"duration_ms"`
}

// ExecuteTool dispatches a tool call to the appropriate handler.
func ExecuteTool(ctx context.Context, workspace, toolName string, arguments json.RawMessage) *ToolResult {
	start := time.Now()

	var args map[string]interface{}
	if err := json.Unmarshal(arguments, &args); err != nil {
		return &ToolResult{
			ToolName:   toolName,
			Success:    false,
			Error:      fmt.Sprintf("invalid arguments: %s", err),
			DurationMs: time.Since(start).Milliseconds(),
		}
	}

	var output string
	var execErr error

	switch toolName {
	case "read_file":
		path, _ := args["path"].(string)
		output, execErr = ReadFile(workspace, path)

	case "read_file_range":
		path, _ := args["path"].(string)
		startLine := int(getFloat(args, "start_line", 1))
		endLine := int(getFloat(args, "end_line", -1))
		output, execErr = ReadFileRange(workspace, path, startLine, endLine)

	case "write_file":
		path, _ := args["path"].(string)
		content, _ := args["content"].(string)
		execErr = WriteFile(workspace, path, content)
		if execErr == nil {
			output = fmt.Sprintf("Written %d bytes to %s", len(content), path)
		}

	case "edit_file":
		path, _ := args["path"].(string)
		oldText, _ := args["old_text"].(string)
		newText, _ := args["new_text"].(string)
		output, execErr = EditFile(workspace, path, oldText, newText)

	case "list_files":
		pattern, _ := args["pattern"].(string)
		files, err := ListFiles(workspace, pattern)
		if err != nil {
			execErr = err
		} else {
			output = fmt.Sprintf("%d files found\n%s", len(files), joinLines(files))
		}

	case "search_code":
		query, _ := args["query"].(string)
		maxResults := int(getFloat(args, "max_results", 50))
		results, err := SearchCode(workspace, query, maxResults)
		if err != nil {
			execErr = err
		} else {
			lines := make([]string, len(results))
			for i, r := range results {
				lines[i] = fmt.Sprintf("%s:%d: %s", r.File, r.Line, r.Text)
			}
			output = fmt.Sprintf("%d matches\n%s", len(results), joinLines(lines))
		}

	case "file_stats":
		path, _ := args["path"].(string)
		info, err := FileStats(workspace, path)
		if err != nil {
			execErr = err
		} else {
			data, _ := json.Marshal(info)
			output = string(data)
		}

	case "shell_exec":
		command, _ := args["command"].(string)
		output, execErr = ShellExec(ctx, workspace, command)

	case "batch_read_files":
		var paths []string
		if rawPaths, ok := args["paths"].([]interface{}); ok {
			for _, p := range rawPaths {
				if s, ok := p.(string); ok {
					paths = append(paths, s)
				}
			}
		}
		results := BatchReadFiles(workspace, paths)
		data, _ := json.Marshal(results)
		output = string(data)

	default:
		return &ToolResult{
			ToolName:   toolName,
			Success:    false,
			Error:      fmt.Sprintf("unknown tool: %s", toolName),
			DurationMs: time.Since(start).Milliseconds(),
		}
	}

	if execErr != nil {
		return &ToolResult{
			ToolName:   toolName,
			Success:    false,
			Output:     output,
			Error:      execErr.Error(),
			DurationMs: time.Since(start).Milliseconds(),
		}
	}

	return &ToolResult{
		ToolName:   toolName,
		Success:    true,
		Output:     output,
		DurationMs: time.Since(start).Milliseconds(),
	}
}

func getFloat(m map[string]interface{}, key string, defaultVal float64) float64 {
	if v, ok := m[key].(float64); ok {
		return v
	}
	return defaultVal
}

func joinLines(lines []string) string {
	if len(lines) == 0 {
		return "(none)"
	}
	result := ""
	for _, l := range lines {
		result += l + "\n"
	}
	return result
}
