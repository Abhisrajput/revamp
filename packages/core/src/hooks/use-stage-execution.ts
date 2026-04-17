import { useState, useCallback, useRef, useEffect } from 'react';
import { usePipelineStore } from '../stores/pipeline-store';
import { usePipelineActivityStore } from '../stores/pipeline-activity-store';
import { stageRequiresApproval } from '../types/stage';
import { getApiClient } from '../api/types';
import { getNotifier } from '../api/notifications';
import { getWSManager } from '../api/ws';
import { getSessionStorage } from '../api/storage';

/** Flash an error via platform notification adapter */
function flashError(stageName: string, message: string) {
  getNotifier().error(`${stageName} failed`, message, { stage: stageName });
}

/** Flash a success via platform notification adapter */
function flashSuccess(stageName: string, message: string) {
  getNotifier().success(`${stageName} completed`, message, { stage: stageName });
}

function getBaseUrl(): string {
  const client = getApiClient();
  return (client as any).getBaseUrl?.() || 'http://localhost:8787';
}

/**
 * Classify a raw error message into an actionable user-facing message.
 * Covers all LLM providers, network errors, and common failure modes.
 * One function, all stages — no hardcoded phase-name checks needed.
 */
function classifyStageError(raw: string): string {
  // Auth / credentials
  if (/403|401|unauthorized|forbidden|security.?token.*invalid|credentials.*invalid|access.?denied/i.test(raw)) {
    if (/bedrock|aws|sso/i.test(raw)) {
      return 'AWS credentials expired — run "aws sso login --profile tavant-bedrock" and retry';
    }
    if (/anthropic/i.test(raw)) return 'Anthropic API key invalid or expired — check Settings';
    if (/openai/i.test(raw)) return 'OpenAI API key invalid or expired — check Settings';
    if (/google|gemini|vertex/i.test(raw)) return 'Google API key invalid or expired — check Settings';
    if (/azure/i.test(raw)) return 'Azure credentials invalid or expired — check Settings';
    return 'Authentication failed — check your API credentials in Settings';
  }

  // Rate limits
  if (/429|rate.?limit|too many requests|throttl|quota/i.test(raw)) {
    return 'Rate limit hit — wait a moment and retry, or switch to a different model';
  }

  // Overloaded / server errors
  if (/529|overloaded|503|service.?unavailable|502|bad.?gateway/i.test(raw)) {
    return 'LLM provider is temporarily overloaded — retry in a few minutes';
  }

  // Timeout
  if (/timeout|timed?.?out|econnaborted|deadline/i.test(raw)) {
    return 'Request timed out — the model may be overloaded. Try again or use a faster model';
  }

  // Network / connection
  if (/econnrefused|enotfound|enetunreach|network|socket|connection.*reset/i.test(raw)) {
    return 'Network error — check your internet connection and retry';
  }

  // Budget
  if (/budget.*exceeded|spending.*limit/i.test(raw)) {
    return 'Project budget exceeded — increase the budget in Settings or contact your admin';
  }

  // Model not found
  if (/model.*not.?found|invalid.*model|unknown.*model/i.test(raw)) {
    return 'Model not available — check model configuration in Settings';
  }

  // Fallback — show the raw error but keep it concise
  const concise = raw.length > 120 ? raw.slice(0, 120) + '...' : raw;
  return concise;
}

interface ExecuteOptions {
  skipLlmEval?: boolean;
  promptOverride?: string;
  validationFeedback?: Array<{ name: string; passed: boolean; score: number; feedback: string; severity?: string }>;
  /** Override execution model for this stage */
  model?: string;
  /** Override director/composition model for this stage */
  composerModel?: string;
  /** Override evaluator/validation model for this stage */
  evaluatorModel?: string;
  /** Max output tokens */
  maxTokens?: number;
}

interface UseStageExecutionReturn {
  executeStage: (pipelineRunId: string, stageName: string, options?: ExecuteOptions) => void;
  isExecuting: boolean;
  abort: () => void;
  currentPhase: string | null;
  progress: number;
  output: string;
}

const EXECUTING_KEY = 'revamp:executing_stage';
const SUBTASKS_KEY = 'revamp:executing_subtasks';

/** Persist running stage info to sessionStorage so we can reconnect after refresh */
function saveExecutingState(pipelineRunId: string, stageName: string, stageIndex: number) {
  try {
    getSessionStorage().setItem(EXECUTING_KEY, JSON.stringify({ pipelineRunId, stageName, stageIndex, startedAt: Date.now() }));
  } catch { /* non-fatal */ }
}

function clearExecutingState() {
  try {
    getSessionStorage().removeItem(EXECUTING_KEY);
    getSessionStorage().removeItem(SUBTASKS_KEY);
  } catch { /* non-fatal */ }
}

/** Save subtasks to sessionStorage so bot grid survives refresh */
function saveSubtasks(subtasks: any[]) {
  try {
    getSessionStorage().setItem(SUBTASKS_KEY, JSON.stringify(subtasks));
  } catch { /* non-fatal */ }
}

function loadSubtasks(): any[] | null {
  try {
    const raw = getSessionStorage().getItem(SUBTASKS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function loadExecutingState(): { pipelineRunId: string; stageName: string; stageIndex: number; startedAt: number } | null {
  try {
    const raw = getSessionStorage().getItem(EXECUTING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Expire after 35 minutes (stage timeout is 30 min + buffer)
    if (Date.now() - parsed.startedAt > 35 * 60 * 1000) {
      getSessionStorage().removeItem(EXECUTING_KEY);
      getSessionStorage().removeItem(SUBTASKS_KEY);
      return null;
    }
    return parsed;
  } catch { return null; }
}

export function useStageExecution(): UseStageExecutionReturn {
  const [isExecuting, setIsExecuting] = useState(false);
  const isExecutingRef = useRef(false);
  const [currentPhase, setCurrentPhase] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);

  const store = usePipelineStore;
  const activityStore = usePipelineActivityStore;

  // ─── Reconnect after page refresh ─────────────────────────────
  // If a stage was running when the page refreshed, re-subscribe to
  // the WebSocket topic so we pick up events from the still-running backend.
  useEffect(() => {
    const saved = loadExecutingState();
    if (!saved) return;

    // Verify the stage is still running in the store (synced from DB via polling)
    const stages = store.getState().stages;
    const idx = stages.findIndex((s) => s.name === saved.stageName);
    if (idx < 0) return;

    const stageStatus = stages[idx].status;
    if (stageStatus !== 'generating' && stageStatus !== 'validating') {
      // Stage already finished while we were away — clean up
      clearExecutingState();
      return;
    }

    // Stage is still running — reconnect
    isExecutingRef.current = true;
    setIsExecuting(true);
    setCurrentPhase('reconnecting');

    // Restore subtasks (bot grid) from sessionStorage
    const savedSubtasks = loadSubtasks();
    if (savedSubtasks && savedSubtasks.length > 0 && idx >= 0) {
      const currentSubtasks = stages[idx].subtasks;
      if (currentSubtasks.length === 0) {
        // Restore subtasks that were lost on refresh
        for (const st of savedSubtasks) {
          store.getState().addScanSubtask(idx, st);
        }
      }
    }

    activityStore.getState().addLog({
      type: 'info',
      message: `Reconnecting to ${saved.stageName} execution...`,
      timestamp: new Date().toISOString(),
    });

    const topic = `pipeline:${saved.pipelineRunId}`;

    const unsub = getWSManager().subscribe(topic, (wsEvent) => {
      const event = { type: wsEvent.event, data: wsEvent.data };

      if (wsEvent.event === 'delta' || wsEvent.event === 'text_delta') {
        store.getState().appendStreamingText((wsEvent.data as any)?.text ?? '');
      } else if (wsEvent.event === 'complete' || wsEvent.event === 'stage_completed') {
        handleSSEEvent({ type: 'completed', data: wsEvent.data }, saved.stageName, saved.stageIndex);
        doCleanup();
      } else if (wsEvent.event === 'error') {
        const rawMsg = (wsEvent.data as any)?.message ?? 'Stage execution failed';
        const aborted = (wsEvent.data as any)?.aborted;
        if (!aborted) {
          const userMsg = classifyStageError(rawMsg);
          store.getState().setStageStatus(saved.stageIndex, 'failed');
          activityStore.getState().addLog({ type: 'error', message: rawMsg, timestamp: new Date().toISOString() });
          flashError(saved.stageName, userMsg);
        }
        doCleanup();
      } else {
        handleSSEEvent(event, saved.stageName, saved.stageIndex);
      }
    });

    unsubRef.current = unsub;

    function doCleanup() {
      unsub();
      unsubRef.current = null;
      isExecutingRef.current = false;
      setIsExecuting(false);
      setCurrentPhase(null);
      clearExecutingState();
    }

    return () => {
      // Component unmount — don't clear executing state (stage may still be running)
      unsub();
      unsubRef.current = null;
    };
  }, []); // Run once on mount

  const executeStage = useCallback(
    (pipelineRunId: string, stageName: string, options: ExecuteOptions = {}) => {
      // Use ref for synchronous guard — useState is async and can't prevent
      // double-clicks between the call and the next React render.
      if (isExecutingRef.current) return;
      isExecutingRef.current = true;

      const controller = new AbortController();
      abortControllerRef.current = controller;

      setIsExecuting(true);
      setCurrentPhase('initializing');
      setProgress(0);

      const stageIndex = store.getState().stages.findIndex((s) => s.name === stageName);
      if (stageIndex >= 0) {
        store.getState().setStageStatus(stageIndex, 'generating');
        store.getState().clearStreamingText();
      }

      // Persist to sessionStorage so we can reconnect after page refresh
      saveExecutingState(pipelineRunId, stageName, stageIndex);

      // Watch subtask changes and persist to sessionStorage (debounced)
      let subtaskSaveTimer: ReturnType<typeof setTimeout> | null = null;
      const unsubSubtasks = store.subscribe((state) => {
        const stage = state.stages[stageIndex];
        if (stage?.subtasks?.length > 0) {
          if (subtaskSaveTimer) clearTimeout(subtaskSaveTimer);
          subtaskSaveTimer = setTimeout(() => saveSubtasks(stage.subtasks), 500);
        }
      });

      // Subscribe to pipeline events via WebSocket BEFORE starting execution
      const topic = `pipeline:${pipelineRunId}`;
      let unsubscribed = false;

      const unsubscribe = getWSManager().subscribe(topic, (wsEvent) => {
        if (unsubscribed) return;

        // Map WS event to the format handleSSEEvent expects
        const event = { type: wsEvent.event, data: wsEvent.data };

        if (wsEvent.event === 'delta' || wsEvent.event === 'text_delta') {
          store.getState().appendStreamingText((wsEvent.data as any)?.text ?? '');
        } else if (wsEvent.event === 'complete' || wsEvent.event === 'stage_completed') {
          handleSSEEvent({ type: 'completed', data: wsEvent.data }, stageName, stageIndex);
          cleanup();
        } else if (wsEvent.event === 'error') {
          const rawMsg = (wsEvent.data as any)?.message ?? 'Stage execution failed';
          const aborted = (wsEvent.data as any)?.aborted;
          if (aborted) {
            cleanup();
            return;
          }
          const userMsg = classifyStageError(rawMsg);
          if (stageIndex >= 0) {
            store.getState().setStageStatus(stageIndex, 'failed');
            activityStore.getState().addLog({ type: 'error', message: rawMsg, timestamp: new Date().toISOString() });
            flashError(stageName, userMsg);
          }
          cleanup();
        } else {
          handleSSEEvent(event, stageName, stageIndex);
        }
      });

      function cleanup() {
        unsubscribed = true;
        unsubscribe();
        unsubSubtasks();
        if (subtaskSaveTimer) clearTimeout(subtaskSaveTimer);
        isExecutingRef.current = false;
        setIsExecuting(false);
        setCurrentPhase(null);
        clearExecutingState();
      }

      // HTTP POST to start execution (no streaming response expected)
      // Auth is handled by the /api/fastify proxy (Bearer token attached server-side).
      fetch(`${getBaseUrl()}/pipeline/${pipelineRunId}/stage/${stageName}`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          skip_llm_eval: options.skipLlmEval ?? false,
          ...(options.model ? { model: options.model } : {}),
          ...(options.composerModel ? { composer_model: options.composerModel } : {}),
          ...(options.evaluatorModel ? { evaluator_model: options.evaluatorModel } : {}),
          ...(options.promptOverride ? { prompt_override: options.promptOverride } : {}),
          ...(options.validationFeedback?.length ? { validation_feedback: options.validationFeedback } : {}),
          ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
        }),
        signal: controller.signal,
      }).then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as any).error || `HTTP ${res.status}`);
        }
        // Server accepted — events will arrive via WebSocket
        // Don't cleanup here — wait for 'complete' or 'error' WS event
      }).catch((err) => {
        if (err.name === 'AbortError') {
          cleanup();
          return;
        }
        const rawMsg = err.message ?? 'Stage execution failed';
        const userMsg = classifyStageError(rawMsg);
        if (stageIndex >= 0) {
          store.getState().setStageStatus(stageIndex, 'failed');
          activityStore.getState().addLog({ type: 'error', message: rawMsg, timestamp: new Date().toISOString() });
          flashError(stageName, userMsg);
        }
        cleanup();
      });
    },
    [store],
  );

  function handleSSEEvent(event: any, stageName: string, stageIndex: number) {
    const s = store.getState();
    const a = activityStore.getState();
    const idx = stageIndex >= 0 ? stageIndex : s.stages.findIndex((st) => st.name === stageName);

    switch (event.type) {
      case 'phase': {
        const phase = event.data?.phase ?? event.phase ?? null;
        setCurrentPhase(phase);

        // Token usage tracking — emitted by orchestrated stages (SCAN, DECODE, FORGE)
        if (phase === 'usage' && event.data?.data) {
          const ud = event.data.data as Record<string, unknown>;
          a.updateRunUsage({
            inputTokens: (ud.input_tokens as number) ?? 0,
            outputTokens: (ud.output_tokens as number) ?? 0,
            cost: (ud.cost as number) ?? 0,
          });
          if (idx >= 0) {
            const stages = [...s.stages];
            const prev = stages[idx].tokenUsage;
            stages[idx] = {
              ...stages[idx],
              tokenUsage: {
                input: (prev?.input ?? 0) + ((ud.input_tokens as number) ?? 0),
                output: (prev?.output ?? 0) + ((ud.output_tokens as number) ?? 0),
                cost: (prev?.cost ?? 0) + ((ud.cost as number) ?? 0),
              },
            };
          }
        }

        // FORGE: file_generated phase — track generated files
        if (phase === 'file_generated' && event.data?.data) {
          const fd = event.data.data as Record<string, unknown>;
          if (fd.path && typeof fd.path === 'string') {
            a.addModernizedFile({
              path: fd.path as string,
              content: fd.content as string || `// Generated: ${fd.path}\n// Content loading...`,
              language: fd.language as string || undefined,
              size: (fd.size as number) || 0,
            });
          }
        }

        // ─── Generic failure detection ────────────────────────────
        // Any phase event whose name contains "failed" or "error" is a
        // stage-level failure. Classify the root cause from the error
        // message and surface an actionable banner to the user.
        if (phase && typeof phase === 'string' && /_failed|^failed$|_error|^error$/i.test(phase) && idx >= 0) {
          const errorData = event.data?.data as Record<string, unknown> | undefined;
          const rawError = (errorData?.error as string) || (errorData?.message as string) || `${phase.replace(/_/g, ' ')}`;
          const userMessage = classifyStageError(rawError);

          s.setStageStatus(idx, 'failed');
          flashError(stageName, userMessage);
        }

        // Director planning event — populate the subtasks list with planned bots
        if (phase === 'director_planning' && event.data?.data && idx >= 0) {
          const planData = event.data.data as Record<string, unknown>;
          const plannedSubtasks = planData.subtasks as Array<{ type: string; title?: string; priority?: number }> | undefined;
          if (Array.isArray(plannedSubtasks) && plannedSubtasks.length > 0) {
            const stage = s.stages[idx];
            // Only populate if we don't already have subtasks (avoid overwriting status updates)
            const existingTypes = new Set(stage.subtasks.map(st => st.type));
            for (const planned of plannedSubtasks) {
              if (!existingTypes.has(planned.type)) {
                s.addScanSubtask(idx, {
                  id: `${planned.type}-${Date.now()}`,
                  type: planned.type,
                  label: planned.title ?? planned.type,
                  title: planned.title,
                  status: 'pending',
                });
              }
            }
          }
        }

        // Subtask execution events — update individual bot status + progress bar
        if ((phase === 'subtask_executing' || phase === 'subtask_completed' || phase === 'subtask_failed') && event.data?.data && idx >= 0) {
          const subtaskData = event.data.data as Record<string, unknown>;
          // Update progress bar from subtask completion events
          if (typeof subtaskData.progress === 'number') {
            setProgress(subtaskData.progress);
          }
          const subtaskType = subtaskData.type as string | undefined;
          if (subtaskType) {
            const stage = s.stages[idx];
            const existing = stage.subtasks.find(st => st.type === subtaskType);
            if (existing) {
              s.updateScanSubtask(idx, existing.id, {
                status: phase === 'subtask_executing' ? 'running'
                  : phase === 'subtask_completed' ? 'completed'
                  : 'failed',
                duration: subtaskData.duration as number | undefined,
                output: subtaskData.output as string | undefined,
                error: subtaskData.error as string | undefined,
                agentName: subtaskData.agentName as string | undefined,
              });
            } else {
              // First sighting — add it
              s.addScanSubtask(idx, {
                id: `${subtaskType}-${Date.now()}`,
                type: subtaskType,
                label: (subtaskData.title as string) ?? subtaskType,
                status: phase === 'subtask_executing' ? 'running'
                  : phase === 'subtask_completed' ? 'completed'
                  : 'failed',
                agentName: subtaskData.agentName as string | undefined,
              });
            }
          }
        }

        // Log ALL phase events to Terminal + Agent Activity
        const phaseData = event.data?.data as Record<string, unknown> | undefined;
        const phaseMessage = (phaseData?.message as string) ?? phase;

        // Update progress bar from phase events (composing, coverage, validation, etc.)
        if (typeof phaseData?.progress === 'number') {
          setProgress(phaseData.progress as number);
        }

        if (phaseMessage && phase !== 'generating') {
          a.addLog({
            type: phase.includes('fail') || phase.includes('error') ? 'error' : 'info',
            message: `[${phase}] ${phaseMessage}`,
            timestamp: new Date().toISOString(),
          });
          // Also feed as agent activity item for the Agent tab
          a.addToolCall({
            id: `${phase}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            toolName: phase,
            status: phase.includes('fail') || phase.includes('error') ? 'failed'
              : phase.includes('complet') || phase.includes('done') ? 'completed'
              : 'running',
            input: phaseData ? { details: phaseMessage } : undefined,
            output: phaseData?.subtasks ? JSON.stringify(phaseData.subtasks) : undefined,
            startedAt: new Date().toISOString(),
            // Carry subtask identity so the bot popover can filter
            subtaskId: (phaseData?.subtaskId as string) || undefined,
            subtaskType: (phaseData?.type as string) || undefined,
            agentName: (phaseData?.agentName as string) || undefined,
          });
        }
        break;
      }

      case 'progress':
        setProgress(event.data?.progress ?? event.progress ?? 0);
        break;

      case 'delta':
      case 'text_delta':
      case 'chunk':
        s.appendStreamingText(event.data?.text ?? event.text ?? event.data ?? '');
        break;

      case 'tool_call':
        a.addToolCall(event.data ?? event);
        break;

      case 'log':
        a.addLog({
          type: event.data?.level ?? 'info',
          message: event.data?.message ?? event.message ?? '',
          timestamp: new Date().toISOString(),
        });
        break;

      case 'subtask':
        if (idx >= 0) {
          const subtask = event.data;
          if (subtask?.action === 'create') {
            s.addScanSubtask(idx, {
              id: subtask.id,
              type: subtask.type,
              label: subtask.label ?? subtask.type,
              status: 'running',
              agentName: subtask.agentName,
            });
          } else if (subtask?.action === 'update' || subtask?.action === 'complete') {
            s.updateScanSubtask(idx, subtask.id, {
              status: subtask.status,
              output: subtask.output,
            });
          }
        }
        break;

      case 'usage':
        // Direct usage events (event type = 'usage'). The pipeline route currently
        // sends usage as phase-wrapped events (event type = 'phase', phase = 'usage'),
        // handled in the 'phase' case above. Skip here if we already counted via
        // a phase-wrapped usage event to avoid double-counting.
        if (!a.lastUsageEventAt || (Date.now() - new Date(a.lastUsageEventAt).getTime()) > 500) {
          a.updateRunUsage({
            inputTokens: event.data?.input_tokens ?? 0,
            outputTokens: event.data?.output_tokens ?? 0,
            cost: event.data?.cost ?? 0,
          });
          if (idx >= 0) {
            const stages = [...s.stages];
            stages[idx] = {
              ...stages[idx],
              tokenUsage: {
                input: event.data?.input_tokens ?? 0,
                output: event.data?.output_tokens ?? 0,
                cost: event.data?.cost ?? 0,
              },
            };
          }
        }
        break;

      case 'validation':
        if (idx >= 0) {
          s.setStageStatus(idx, 'validating');
          setCurrentPhase('validating');
        }
        break;

      case 'validation_finding':
        // Stream individual validation findings in real-time
        if (idx >= 0 && event.data) {
          a.addLog({
            type: event.data.passed ? 'info' : 'error',
            message: `[${event.data.severity?.toUpperCase()}] ${event.data.name}: ${event.data.feedback}`,
            timestamp: new Date().toISOString(),
          });
          // Incrementally build validation criteria
          const currentVal = s.stages[idx]?.validation;
          const newCriterion = {
            name: event.data.name,
            passed: event.data.passed,
            score: event.data.score ?? 0,
            feedback: event.data.feedback ?? '',
          };
          s.setStageValidation(idx, {
            passed: currentVal?.passed ?? true,
            score: currentVal?.score ?? 0,
            criteria: [...(currentVal?.criteria ?? []), newCriterion],
            summary: currentVal?.summary ?? '',
            validatedAt: new Date().toISOString(),
          });
        }
        break;

      case 'validation_result':
        if (idx >= 0 && event.data) {
          s.setStageValidation(idx, {
            passed: event.data.passed ?? false,
            score: event.data.confidenceScore ?? event.data.score ?? 0,
            criteria: event.data.criteria ?? [],
            summary: event.data.summary ?? '',
            validatedAt: new Date().toISOString(),
          });
        }
        break;

      case 'artifact':
        if (idx >= 0 && event.data) {
          s.addStageArtifact(idx, {
            id: event.data.id ?? crypto.randomUUID(),
            name: event.data.artifact_type ?? event.data.name ?? 'artifact',
            type: event.data.artifact_type ?? 'unknown',
            url: event.data.storage_path ?? '',
            size: event.data.file_size ?? 0,
            createdAt: event.data.created_at ?? new Date().toISOString(),
          });
        }
        break;

      case 'completed':
      case 'stage_completed': {
        const finalOutput = s.streamingText;
        if (idx >= 0) {
          const hasRealOutput = finalOutput && finalOutput.trim().length > 20;
          if (hasRealOutput) {
            s.setStageOutput(idx, finalOutput);
            s.setStageStatus(idx, 'completed');
            flashSuccess(stageName, `Output generated (${finalOutput.length} chars)`);

            // Trigger approval gate if stage requires approval
            if (stageRequiresApproval(stageName)) {
              s.setPendingApproval(idx);
              getNotifier().info(`${stageName} needs approval`, 'Review the output and approve to advance the pipeline.');
            }
          } else {
            const stage = s.stages[idx];
            const hasArtifacts = stage?.artifacts?.length > 0;
            if (hasArtifacts) {
              const partialMsg = `## ${stageName} — Partial Result\n\nSetup completed but AI analysis did not produce output.\n\n> Re-run the stage to retry.`;
              s.setStageOutput(idx, partialMsg);
              s.setStageStatus(idx, 'failed');
              flashError(stageName, 'Setup succeeded but AI analysis failed. Re-run to retry.');
            } else {
              s.setStageStatus(idx, 'failed');
              flashError(stageName, 'No output generated. The LLM may have failed — try re-running.');
            }
          }
        }
        isExecutingRef.current = false;
        setIsExecuting(false);
        setCurrentPhase(null);
        setProgress(100);

        // FORGE: fetch modernized file contents from API after completion
        // Auth is handled by the /api/fastify proxy (Bearer token attached server-side).
        if (stageName === 'FORGE' && s.currentPipelineRunId) {
          const pipeId = s.currentPipelineRunId;

          fetch(`${getBaseUrl()}/pipeline/${pipeId}/modernized-files`, { credentials: 'include' })
            .then((r) => r.json())
            .then((data) => {
              const files = data?.files || [];
              for (const file of files) {
                fetch(`${getBaseUrl()}/pipeline/${pipeId}/modernized-files/${file.id}`, { credentials: 'include' })
                  .then((r) => r.json())
                  .then((detail) => {
                    if (detail?.content) {
                      activityStore.getState().addModernizedFile({
                        path: detail.file_path,
                        content: detail.content,
                        language: detail.language,
                        size: detail.file_size,
                      });
                    }
                  })
                  .catch(() => {});
              }
            })
            .catch(() => {});
        }
        break;
      }

      case 'error': {
        // Backend sends 'error' events when the pipeline service throws (auth, quota,
        // context_length, etc.). Without this handler the stage stays stuck in
        // 'generating' with the elapsed timer running forever.
        const errMsg = event.data?.message ?? event.data?.detail ?? event.message ?? 'Stage execution error';
        const detail = event.data?.detail ?? '';
        if (idx >= 0) {
          s.setStageStatus(idx, 'failed');
          a.addLog({ type: 'error', message: detail || errMsg, timestamp: new Date().toISOString() });
          flashError(stageName, errMsg);
        }
        isExecutingRef.current = false;
        setIsExecuting(false);
        setCurrentPhase(null);
        break;
      }

      case 'failed':
      case 'stage_failed': {
        const errMsg = event.data?.error ?? event.error ?? 'Stage failed';
        if (idx >= 0) {
          s.setStageStatus(idx, 'failed');
          a.addLog({ type: 'error', message: errMsg, timestamp: new Date().toISOString() });
          flashError(stageName, errMsg);
        }
        isExecutingRef.current = false;
        setIsExecuting(false);
        setCurrentPhase(null);
        break;
      }

      default:
        break;
    }
  }

  const abort = useCallback(() => {
    abortControllerRef.current?.abort();
    isExecutingRef.current = false;
    setIsExecuting(false);
    setCurrentPhase(null);
    setProgress(0);
  }, []);

  const output = usePipelineStore((s) => s.streamingText);

  return { executeStage, isExecuting, abort, currentPhase, progress, output };
}
