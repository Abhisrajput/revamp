package stages

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/revamp-io/llm-orchestrator/internal/orchestrator"
	"github.com/revamp-io/llm-orchestrator/internal/providers"
	"github.com/revamp-io/llm-orchestrator/internal/tools"
	"go.uber.org/zap"
)

// GeneratedFile represents a file created during FORGE.
type GeneratedFile struct {
	Path        string `json:"path"`
	Language    string `json:"language"`
	Size        int    `json:"size"`
	Description string `json:"description"`
}

// RunForgeStage executes the FORGE (Co-Create) stage using the agentic tool loop.
// The LLM autonomously explores the codebase, plans, and writes code files.
func RunForgeStage(
	ctx context.Context,
	engine *orchestrator.Engine,
	config StageConfig,
	onEvent OnStageEvent,
	onDelta OnDelta,
	logger *zap.Logger,
) (*StageRunResult, error) {
	start := time.Now()
	var generatedFiles []GeneratedFile

	emit := func(phase StagePhase, data map[string]interface{}) {
		if onEvent != nil {
			onEvent(NewEvent(phase, config.StageName, config.StageIndex, data))
		}
	}

	// ── 1. Build context ────────────────────────────────────────
	emit(PhaseContextRetrieval, map[string]interface{}{"message": "Loading prior stage outputs..."})

	var priorContext strings.Builder
	for _, prior := range config.PriorOutputs {
		maxLen := 6000
		output := prior.Output
		if len(output) > maxLen {
			output = output[:maxLen] + "\n..."
		}
		priorContext.WriteString(fmt.Sprintf("## %s\n%s\n\n", prior.StageName, output))
	}

	// ── 2. Build system prompt ──────────────────────────────────
	systemPrompt := config.StagePrompt
	if systemPrompt == "" {
		systemPrompt = `You are a Senior Full-Stack Engineer generating production-ready code for a legacy modernization project.

Use the available tools to:
1. First, explore the legacy codebase to understand the existing code
2. Then write modernized code files using write_file
3. Create complete, production-ready files (no stubs or TODOs)

Follow the target architecture from the ARCHITECT stage output.
Implement all business rules from the DECODE stage output.`
	}

	userPrompt := fmt.Sprintf(`Generate the modernized codebase based on the following prior analysis:

Target Stack: %s
Target Cloud: %s

%s

Start by reading key legacy files, then generate the modernized code.
Write each file using the write_file tool.
After writing all files, provide a summary of what was generated.`,
		config.TargetStack, config.TargetCloud, priorContext.String())

	// ── 3. Get tools for FORGE (read + write access) ────────────
	forgeTools := tools.ToolsForStage(5) // Stage 5 = FORGE, gets all tools

	// Convert to provider tool definitions
	providerTools := make([]providers.ToolDefinition, len(forgeTools))
	for i, t := range forgeTools {
		providerTools[i] = providers.ToolDefinition{
			Name:        t.Name,
			Description: t.Description,
			InputSchema: t.InputSchema,
		}
	}

	// ── 4. Run agentic tool loop ────────────────────────────────
	emit(PhaseGenerating, map[string]interface{}{
		"message": "Starting code generation with tool loop...",
		"tools":   len(providerTools),
	})

	loopConfig := tools.LoopConfig{
		Messages: []providers.Message{
			{Role: "system", Content: systemPrompt},
			{Role: "user", Content: userPrompt},
		},
		Tools:         providerTools,
		WorkspacePath: config.WorkspacePath,
		Model:         config.Model,
		MaxTokens:     config.MaxTokens,
		Temperature:   0.2,
		MaxToolRounds: 20,
		BudgetCents:   config.BudgetCents,
	}

	if loopConfig.MaxTokens <= 0 {
		loopConfig.MaxTokens = 8192
	}

	result, err := tools.RunToolLoop(ctx, engine, loopConfig, func(event tools.LoopEvent) {
		switch event.Type {
		case "tool_call":
			data, _ := event.Data.(map[string]interface{})
			toolName, _ := data["tool_name"].(string)
			emit(PhaseSubtaskExecuting, map[string]interface{}{
				"message":   fmt.Sprintf("Tool: %s", toolName),
				"tool_name": toolName,
			})

			// Track write_file calls
			if toolName == "write_file" {
				if input, ok := data["input"].(map[string]interface{}); ok {
					if path, ok := input["path"].(string); ok {
						content, _ := input["content"].(string)
						ext := ""
						if idx := strings.LastIndex(path, "."); idx >= 0 {
							ext = path[idx+1:]
						}
						generatedFiles = append(generatedFiles, GeneratedFile{
							Path:     path,
							Language: ext,
							Size:     len(content),
						})
						emit(PhaseFileGenerated, map[string]interface{}{
							"path":     path,
							"language": ext,
							"size":     len(content),
						})
					}
				}
			}

		case "tool_result":
			data, _ := event.Data.(map[string]interface{})
			emit(PhaseSubtaskExecuting, map[string]interface{}{
				"message": fmt.Sprintf("Tool result: %v", data["tool_name"]),
				"success": data["success"],
			})

		case "delta":
			if data, ok := event.Data.(map[string]string); ok {
				if onDelta != nil {
					onDelta(data["text"])
				}
			}
		}
	}, logger)

	if err != nil {
		emit(PhaseFailed, map[string]interface{}{"error": err.Error()})
		return &StageRunResult{
			StageName: config.StageName, StageIndex: config.StageIndex,
			DurationMs: time.Since(start).Milliseconds(),
		}, err
	}

	// ── 5. Compose output ───────────────────────────────────────
	output := result.Content
	if output == "" {
		output = "Code generation completed via tool loop."
	}

	// Prepend file summary
	var summary strings.Builder
	summary.WriteString(fmt.Sprintf("# FORGE: Code Generation Complete\n\n"))
	summary.WriteString(fmt.Sprintf("**Files generated**: %d\n", len(generatedFiles)))
	summary.WriteString(fmt.Sprintf("**Tool rounds**: %d\n", result.ToolRounds))
	summary.WriteString(fmt.Sprintf("**Tools executed**: %d\n", len(result.ToolsExecuted)))
	summary.WriteString(fmt.Sprintf("**Tokens used**: %d\n\n", result.TokensUsed))

	if len(generatedFiles) > 0 {
		summary.WriteString("## Generated Files\n\n")
		summary.WriteString("| File | Language | Size |\n|------|----------|------|\n")
		for _, f := range generatedFiles {
			summary.WriteString(fmt.Sprintf("| `%s` | %s | %d bytes |\n", f.Path, f.Language, f.Size))
		}
		summary.WriteString("\n")
	}

	summary.WriteString("## Agent Output\n\n")
	summary.WriteString(output)

	composedOutput := summary.String()

	emit(PhaseComposing, map[string]interface{}{
		"message":    fmt.Sprintf("Generated %d files", len(generatedFiles)),
		"totalFiles": len(generatedFiles),
		"totalSize":  func() int { s := 0; for _, f := range generatedFiles { s += f.Size }; return s }(),
	})

	// ── 6. Validate ─────────────────────────────────────────────
	var validation *ValidationResult
	if !config.SkipValidation && config.ValidationPrompt != "" {
		emit(PhaseValidating, map[string]interface{}{"message": "Validating generated code..."})
		validation = validateWithLLM(ctx, engine, config, composedOutput, logger)
	}

	emit(PhaseCompleted, map[string]interface{}{
		"outputLength":   len(composedOutput),
		"filesGenerated": len(generatedFiles),
	})

	return &StageRunResult{
		StageName:      config.StageName,
		StageIndex:     config.StageIndex,
		Output:         composedOutput,
		Validation:     validation,
		DurationMs:     time.Since(start).Milliseconds(),
		TokensUsed:     result.TokensUsed,
		CostCents:      result.CostCents,
		FilesGenerated: len(generatedFiles),
	}, nil
}
