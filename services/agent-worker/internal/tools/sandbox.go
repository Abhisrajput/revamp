// Package tools provides a secure file/shell execution sandbox for agent tool calls.
//
// Ported from the TypeScript sandbox.ts with equivalent safety guarantees:
//   - Path traversal prevention (no ../ escapes)
//   - Symlink resolution to prevent escapes
//   - Safe command allowlist for shell execution
//   - File size limits
//   - Timeout enforcement
package tools

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const (
	MaxFileSize    = 5 * 1024 * 1024 // 5MB per file
	MaxOutputSize  = 1 * 1024 * 1024 // 1MB shell output
	DefaultTimeout = 30 * time.Second
)

// SafeCommands is the allowlist of shell commands agents can execute.
var SafeCommands = map[string]bool{
	"ls": true, "find": true, "grep": true, "wc": true, "head": true, "tail": true,
	"cat": true, "sort": true, "uniq": true, "diff": true, "tree": true,
	"npm": true, "npx": true, "node": true, "pnpm": true, "yarn": true,
	"go": true, "cargo": true, "rustc": true, "python3": true, "pip": true,
	"java": true, "javac": true, "mvn": true, "gradle": true,
	"git": true, "docker": true, "make": true, "cmake": true,
	"echo": true, "date": true, "pwd": true, "env": true, "which": true,
	"mkdir": true, "cp": true, "mv": true, "touch": true,
	"jq": true, "curl": true, "wget": true,
}

// DangerousPatterns that are never allowed in shell commands.
var DangerousPatterns = []string{
	"rm -rf /", "rm -rf /*", ":(){ :|:", "mkfs", "dd if=",
	"> /dev/", "chmod 777", "curl | sh", "wget | sh",
	"eval(", "sudo", "su -", "passwd",
}

// ResolveSafePath resolves a path within a workspace, preventing escapes.
func ResolveSafePath(workspace, requestedPath string) (string, error) {
	absWorkspace, err := filepath.Abs(workspace)
	if err != nil {
		return "", fmt.Errorf("invalid workspace path: %w", err)
	}
	// Resolve workspace symlinks too (macOS: /tmp → /private/tmp)
	if resolved, err := filepath.EvalSymlinks(absWorkspace); err == nil {
		absWorkspace = resolved
	}

	// Resolve the requested path relative to workspace
	var target string
	if filepath.IsAbs(requestedPath) {
		target = requestedPath
	} else {
		target = filepath.Join(absWorkspace, requestedPath)
	}

	// Resolve symlinks
	resolved, err := filepath.EvalSymlinks(filepath.Dir(target))
	if err != nil {
		// Parent dir might not exist yet (write_file to new path) — use clean path
		resolved = filepath.Clean(target)
	} else {
		resolved = filepath.Join(resolved, filepath.Base(target))
	}

	// Check the resolved path is within workspace
	if !strings.HasPrefix(resolved, absWorkspace) {
		return "", fmt.Errorf("path '%s' escapes workspace boundary", requestedPath)
	}

	return resolved, nil
}

// ReadFile reads a file's contents safely within the workspace.
func ReadFile(workspace, path string) (string, error) {
	safePath, err := ResolveSafePath(workspace, path)
	if err != nil {
		return "", err
	}

	info, err := os.Stat(safePath)
	if err != nil {
		return "", fmt.Errorf("file not found: %s", path)
	}
	if info.IsDir() {
		return "", fmt.Errorf("'%s' is a directory, not a file", path)
	}
	if info.Size() > MaxFileSize {
		return "", fmt.Errorf("file too large: %d bytes (max %d)", info.Size(), MaxFileSize)
	}

	data, err := os.ReadFile(safePath)
	if err != nil {
		return "", fmt.Errorf("failed to read file: %w", err)
	}
	return string(data), nil
}

// ReadFileRange reads lines [startLine, endLine] (1-indexed) from a file.
func ReadFileRange(workspace, path string, startLine, endLine int) (string, error) {
	content, err := ReadFile(workspace, path)
	if err != nil {
		return "", err
	}

	lines := strings.Split(content, "\n")
	if startLine < 1 {
		startLine = 1
	}
	if endLine > len(lines) || endLine < 1 {
		endLine = len(lines)
	}
	if startLine > len(lines) {
		return "", fmt.Errorf("start line %d exceeds file length %d", startLine, len(lines))
	}

	selected := lines[startLine-1 : endLine]
	result := make([]string, len(selected))
	for i, line := range selected {
		result[i] = fmt.Sprintf("%d\t%s", startLine+i, line)
	}
	return strings.Join(result, "\n"), nil
}

// WriteFile writes content to a file, creating directories as needed.
func WriteFile(workspace, path, content string) error {
	safePath, err := ResolveSafePath(workspace, path)
	if err != nil {
		return err
	}

	if len(content) > MaxFileSize {
		return fmt.Errorf("content too large: %d bytes (max %d)", len(content), MaxFileSize)
	}

	// Create parent directories
	dir := filepath.Dir(safePath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create directory: %w", err)
	}

	return os.WriteFile(safePath, []byte(content), 0644)
}

// EditFile applies a search-and-replace edit to a file.
func EditFile(workspace, path, oldText, newText string) (string, error) {
	content, err := ReadFile(workspace, path)
	if err != nil {
		return "", err
	}

	if !strings.Contains(content, oldText) {
		return "", fmt.Errorf("search text not found in file '%s'", path)
	}

	// Count occurrences
	count := strings.Count(content, oldText)
	if count > 1 {
		return "", fmt.Errorf("search text matches %d locations — provide more context to make it unique", count)
	}

	newContent := strings.Replace(content, oldText, newText, 1)

	safePath, err := ResolveSafePath(workspace, path)
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(safePath, []byte(newContent), 0644); err != nil {
		return "", err
	}

	return fmt.Sprintf("Edited '%s': replaced %d bytes with %d bytes", path, len(oldText), len(newText)), nil
}

// ListFiles lists files matching a glob pattern within the workspace.
func ListFiles(workspace, pattern string) ([]string, error) {
	absWorkspace, err := filepath.Abs(workspace)
	if err != nil {
		return nil, err
	}

	var matches []string
	err = filepath.WalkDir(absWorkspace, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}

		// Skip hidden dirs and common ignore patterns
		name := d.Name()
		if d.IsDir() && (strings.HasPrefix(name, ".") || name == "node_modules" || name == "__pycache__" || name == "target" || name == "dist" || name == "build") {
			return filepath.SkipDir
		}

		if d.IsDir() {
			return nil
		}

		relPath, _ := filepath.Rel(absWorkspace, path)

		// Apply glob pattern if provided
		if pattern != "" && pattern != "*" && pattern != "**/*" {
			matched, _ := filepath.Match(pattern, filepath.Base(path))
			if !matched {
				// Also try matching the full relative path
				matched, _ = filepath.Match(pattern, relPath)
			}
			if !matched {
				return nil
			}
		}

		matches = append(matches, relPath)
		return nil
	})

	return matches, err
}

// SearchCode searches for a pattern in files within the workspace.
func SearchCode(workspace, query string, maxResults int) ([]SearchResult, error) {
	absWorkspace, err := filepath.Abs(workspace)
	if err != nil {
		return nil, err
	}

	if maxResults <= 0 {
		maxResults = 50
	}

	var results []SearchResult
	queryLower := strings.ToLower(query)

	err = filepath.WalkDir(absWorkspace, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil || d.IsDir() {
			return nil
		}
		if len(results) >= maxResults {
			return filepath.SkipAll
		}

		// Skip binary/large files
		info, err := d.Info()
		if err != nil || info.Size() > MaxFileSize {
			return nil
		}

		data, err := os.ReadFile(path)
		if err != nil {
			return nil
		}

		content := string(data)
		lines := strings.Split(content, "\n")
		relPath, _ := filepath.Rel(absWorkspace, path)

		for i, line := range lines {
			if strings.Contains(strings.ToLower(line), queryLower) {
				results = append(results, SearchResult{
					File: relPath,
					Line: i + 1,
					Text: strings.TrimSpace(line),
				})
				if len(results) >= maxResults {
					return filepath.SkipAll
				}
			}
		}
		return nil
	})

	return results, err
}

// SearchResult represents a code search match.
type SearchResult struct {
	File string `json:"file"`
	Line int    `json:"line"`
	Text string `json:"text"`
}

// FileStats returns statistics about a file or directory.
func FileStats(workspace, path string) (*FileInfo, error) {
	safePath, err := ResolveSafePath(workspace, path)
	if err != nil {
		return nil, err
	}

	info, err := os.Stat(safePath)
	if err != nil {
		return nil, fmt.Errorf("path not found: %s", path)
	}

	result := &FileInfo{
		Path:    path,
		IsDir:   info.IsDir(),
		Size:    info.Size(),
		ModTime: info.ModTime(),
	}

	if !info.IsDir() {
		data, _ := os.ReadFile(safePath)
		result.Lines = strings.Count(string(data), "\n") + 1
		result.Extension = filepath.Ext(path)
	} else {
		// Count files in directory
		count := 0
		filepath.WalkDir(safePath, func(_ string, d fs.DirEntry, _ error) error {
			if !d.IsDir() {
				count++
			}
			return nil
		})
		result.FileCount = count
	}

	return result, nil
}

// FileInfo contains file/directory metadata.
type FileInfo struct {
	Path      string    `json:"path"`
	IsDir     bool      `json:"is_dir"`
	Size      int64     `json:"size"`
	Lines     int       `json:"lines,omitempty"`
	Extension string    `json:"extension,omitempty"`
	FileCount int       `json:"file_count,omitempty"`
	ModTime   time.Time `json:"mod_time"`
}

// ShellExec executes a shell command safely within the workspace.
func ShellExec(ctx context.Context, workspace, command string) (string, error) {
	// Validate command against allowlist
	parts := strings.Fields(command)
	if len(parts) == 0 {
		return "", fmt.Errorf("empty command")
	}

	baseCmd := filepath.Base(parts[0])
	if !SafeCommands[baseCmd] {
		return "", fmt.Errorf("command '%s' is not in the safe command allowlist", baseCmd)
	}

	// Check for dangerous patterns
	cmdLower := strings.ToLower(command)
	for _, pattern := range DangerousPatterns {
		if strings.Contains(cmdLower, strings.ToLower(pattern)) {
			return "", fmt.Errorf("command contains dangerous pattern: '%s'", pattern)
		}
	}

	// Set timeout
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, DefaultTimeout)
		defer cancel()
	}

	cmd := exec.CommandContext(ctx, "sh", "-c", command)
	cmd.Dir = workspace
	cmd.Env = append(os.Environ(),
		"HOME="+os.Getenv("HOME"),
		"PATH="+os.Getenv("PATH"),
	)

	output, err := cmd.CombinedOutput()
	if len(output) > MaxOutputSize {
		output = output[:MaxOutputSize]
	}

	if err != nil {
		return string(output), fmt.Errorf("command failed: %w\nOutput: %s", err, string(output))
	}

	return string(output), nil
}

// BatchReadFiles reads multiple files and returns their contents.
func BatchReadFiles(workspace string, paths []string) map[string]string {
	results := make(map[string]string, len(paths))
	for _, path := range paths {
		content, err := ReadFile(workspace, path)
		if err != nil {
			results[path] = fmt.Sprintf("ERROR: %s", err.Error())
		} else {
			results[path] = content
		}
	}
	return results
}
