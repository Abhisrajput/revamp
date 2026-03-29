// Package stages implements the 8-stage modernization pipeline orchestrators.
//
// Each stage is executed by the Go engine, which manages the full workflow:
// LLM calls → tool execution → validation → result composition.
//
// Stages:
//   0. SCAN    — Codebase inventory (multi-agent: scout → director → specialists → compose)
//   1. DECODE  — Intent extraction (business rules, data flows, workflows)
//   2. BLUEPRINT — Business capability mapping
//   3. SPEC_LOCK — BDD/Gherkin behavior lock-in
//   4. ARCHITECT — Modernization approach + target architecture
//   5. FORGE   — Code generation (agentic tool loop)
//   6. SHADOW_RUN — Parallel validation
//   7. EVOLVE  — Continuous modernization
package stages

import "time"

// StagePhase represents a named phase within stage execution.
type StagePhase string

const (
	PhaseContextRetrieval StagePhase = "context_retrieval"
	PhaseAgentAssigned    StagePhase = "agent_assigned"
	PhaseGenerating       StagePhase = "generating"
	PhaseValidating       StagePhase = "validating"
	PhaseRefining         StagePhase = "refining"
	PhaseCompleted        StagePhase = "completed"
	PhaseFailed           StagePhase = "failed"
	PhaseScoutAssessment  StagePhase = "scout_assessment"
	PhaseDirectorPlanning StagePhase = "director_planning"
	PhaseSubtaskExecuting StagePhase = "subtask_executing"
	PhaseComposing        StagePhase = "composing"
	PhaseFileGenerated    StagePhase = "file_generated"
)

// StageEvent is emitted during stage execution for SSE streaming.
type StageEvent struct {
	Phase     StagePhase             `json:"phase"`
	StageName string                 `json:"stage_name"`
	StageIdx  int                    `json:"stage_index"`
	Timestamp string                 `json:"timestamp"`
	Data      map[string]interface{} `json:"data,omitempty"`
}

// StageRunResult is the result of executing a pipeline stage.
type StageRunResult struct {
	StageName       string              `json:"stage_name"`
	StageIndex      int                 `json:"stage_index"`
	Output          string              `json:"output"`
	Validation      *ValidationResult   `json:"validation,omitempty"`
	RefinementCount int                 `json:"refinement_count"`
	DurationMs      int64               `json:"duration_ms"`
	TokensUsed      int                 `json:"tokens_used"`
	CostCents       float64             `json:"cost_cents"`
	FilesGenerated  int                 `json:"files_generated,omitempty"`
	Aborted         bool                `json:"aborted"`
}

// ValidationResult from stage validation.
type ValidationResult struct {
	Passed          bool    `json:"passed"`
	ConfidenceScore int     `json:"confidence_score"` // 0-100
	Issues          []Issue `json:"issues,omitempty"`
}

// Issue found during validation.
type Issue struct {
	Severity    string `json:"severity"` // error, warn, info
	Code        string `json:"code"`
	Title       string `json:"title"`
	Description string `json:"description"`
}

// PriorOutput contains output from a previously completed stage.
type PriorOutput struct {
	StageName string `json:"stage_name"`
	Output    string `json:"output"`
}

// StageConfig holds configuration for a stage execution.
type StageConfig struct {
	PipelineRunID   string        `json:"pipeline_run_id"`
	ProjectID       string        `json:"project_id"`
	StageName       string        `json:"stage_name"`
	StageIndex      int           `json:"stage_index"`
	Model           string        `json:"model"`
	EvaluatorModel  string        `json:"evaluator_model"`
	MaxTokens       int           `json:"max_tokens"`
	StagePrompt     string        `json:"stage_prompt"`
	ValidationPrompt string       `json:"validation_prompt"`
	PriorOutputs    []PriorOutput `json:"prior_outputs"`
	WorkspacePath   string        `json:"workspace_path"`
	TargetStack     string        `json:"target_stack"`
	TargetCloud     string        `json:"target_cloud"`
	BudgetCents     int           `json:"budget_cents"`
	SkipValidation  bool          `json:"skip_validation"`
}

// OnStageEvent is a callback for stage events.
type OnStageEvent func(event StageEvent)

// OnDelta is a callback for streaming text deltas.
type OnDelta func(text string)

// NewEvent creates a StageEvent with the current timestamp.
func NewEvent(phase StagePhase, stageName string, stageIdx int, data map[string]interface{}) StageEvent {
	return StageEvent{
		Phase:     phase,
		StageName: stageName,
		StageIdx:  stageIdx,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Data:      data,
	}
}
