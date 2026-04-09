'use client';

import { useState, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { usePipelineStore, stageRequiresApproval } from '@/lib/stores/pipeline-store';
import { useAuthStore } from '@/lib/stores/auth-store';
import { useNotificationStore } from '@/lib/stores/notification-store';

/** Flash an error to toast + notification bell */
function flashError(stageName: string, message: string) {
  toast.error(`${stageName} failed`, { description: message, duration: 8000 });
  try {
    useNotificationStore.getState().addNotification({
      type: 'stage_failed',
      title: `${stageName} failed`,
      message,
      metadata: { stage: stageName },
    });
  } catch { /* non-fatal */ }
}

/** Flash a success to toast + notification bell */
function flashSuccess(stageName: string, message: string) {
  toast.success(`${stageName} completed`, { description: message, duration: 5000 });
  try {
    useNotificationStore.getState().addNotification({
      type: 'stage_completed',
      title: `${stageName} completed`,
      message,
      metadata: { stage: stageName },
    });
  } catch { /* non-fatal */ }
}

const BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8787';

interface ExecuteOptions {
  skipLlmEval?: boolean;
  promptOverride?: string;
  validationFeedback?: Array<{ name: string; passed: boolean; score: number; feedback: string; severity?: string }>;
}

interface UseStageExecutionReturn {
  executeStage: (pipelineRunId: string, stageName: string, options?: ExecuteOptions) => void;
  isExecuting: boolean;
  abort: () => void;
  currentPhase: string | null;
  progress: number;
  output: string;
}

export function useStageExecution(): UseStageExecutionReturn {
  const [isExecuting, setIsExecuting] = useState(false);
  const [currentPhase, setCurrentPhase] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  const store = usePipelineStore;

  const executeStage = useCallback(
    (pipelineRunId: string, stageName: string, options: ExecuteOptions = {}) => {
      if (isExecuting) return;

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

      const authToken = useAuthStore.getState().token;

      fetch(`${BASE_URL}/pipeline/${pipelineRunId}/stage/${stageName}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({
          skip_llm_eval: options.skipLlmEval ?? false,
          ...(options.promptOverride ? { prompt_override: options.promptOverride } : {}),
          ...(options.validationFeedback?.length ? { validation_feedback: options.validationFeedback } : {}),
        }),
        signal: controller.signal,
      })
        .then((res) => {
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
          }
          if (!res.body) throw new Error('No response body');

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          function processChunk(): Promise<void> {
            return reader.read().then(({ done, value }) => {
              if (done) {
                // Finalize — only mark completed if there's actual output
                const s = store.getState();
                const idx = s.stages.findIndex((st) => st.name === stageName);
                if (idx >= 0) {
                  const stage = s.stages[idx];
                  const output = s.streamingText;
                  const hasRealOutput = output && output.trim().length > 20;
                  if (stage.status === 'generating' || stage.status === 'validating') {
                    if (hasRealOutput) {
                      s.setStageOutput(idx, output);
                      s.setStageStatus(idx, 'completed');
                      flashSuccess(stageName, `Output generated (${output.length} chars)`);
                    } else {
                      // Stream ended but no LLM output — set partial output if any artifacts exist
                      const hasArtifacts = stage.artifacts.length > 0;
                      if (hasArtifacts) {
                        // Partial success: clone/setup worked but LLM analysis failed
                        const partialMsg = `## ${stageName} — Partial Result\n\nCodebase setup completed successfully, but the AI analysis did not produce output.\n\n**What worked:** Codebase cloned, file structure detected\n**What failed:** LLM analysis — the model may be unavailable or the request timed out.\n\n> Re-run the stage to retry the AI analysis.`;
                        s.setStageOutput(idx, partialMsg);
                        s.setStageStatus(idx, 'failed');
                        flashError(stageName, 'Codebase cloned but AI analysis failed. Re-run to retry.');
                      } else {
                        s.setStageStatus(idx, 'failed');
                        flashError(stageName, 'No output generated. The LLM may have failed — try re-running.');
                      }
                    }
                  }
                }
                setIsExecuting(false);
                setCurrentPhase(null);
                setProgress(100);
                return;
              }

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() ?? '';

              for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const raw = line.slice(6).trim();
                if (!raw || raw === '[DONE]') continue;

                try {
                  const event = JSON.parse(raw);
                  handleSSEEvent(event, stageName, stageIndex);
                } catch {
                  // raw text chunk — append directly
                  store.getState().appendStreamingText(raw);
                }
              }

              return processChunk();
            });
          }

          return processChunk();
        })
        .catch((err) => {
          if (err.name === 'AbortError') return;

          const s = store.getState();
          const idx = s.stages.findIndex((st) => st.name === stageName);
          if (idx >= 0) {
            s.setStageStatus(idx, 'failed');
            const errMsg = err.message ?? 'Stage execution failed';
            s.addLog({ type: 'error', message: errMsg, timestamp: new Date().toISOString() });
            flashError(stageName, errMsg);
          }
          setIsExecuting(false);
          setCurrentPhase(null);
        });
    },
    [isExecuting, store],
  );

  function handleSSEEvent(event: any, stageName: string, stageIndex: number) {
    const s = store.getState();
    const idx = stageIndex >= 0 ? stageIndex : s.stages.findIndex((st) => st.name === stageName);

    switch (event.type) {
      case 'phase': {
        const phase = event.data?.phase ?? event.phase ?? null;
        setCurrentPhase(phase);

        // Token usage tracking — emitted by orchestrated stages (SCAN, DECODE, FORGE)
        if (phase === 'usage' && event.data?.data) {
          const ud = event.data.data as Record<string, unknown>;
          s.updateRunUsage({
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
            s.addModernizedFile({
              path: fd.path as string,
              content: fd.content as string || `// Generated: ${fd.path}\n// Content loading...`,
              language: fd.language as string || undefined,
              size: (fd.size as number) || 0,
            });
          }
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

        // Subtask execution events — update individual bot status
        if ((phase === 'subtask_executing' || phase === 'subtask_completed' || phase === 'subtask_failed') && event.data?.data && idx >= 0) {
          const subtaskData = event.data.data as Record<string, unknown>;
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
        if (phaseMessage && phase !== 'generating') {
          s.addLog({
            type: phase.includes('fail') || phase.includes('error') ? 'error' : 'info',
            message: `[${phase}] ${phaseMessage}`,
            timestamp: new Date().toISOString(),
          });
          // Also feed as agent activity item for the Agent tab
          s.addToolCall({
            id: `${phase}-${Date.now()}`,
            toolName: phase,
            status: phase.includes('fail') || phase.includes('error') ? 'failed'
              : phase.includes('complet') || phase.includes('done') ? 'completed'
              : 'running',
            input: phaseData ? { details: phaseMessage } : undefined,
            output: phaseData?.subtasks ? JSON.stringify(phaseData.subtasks) : undefined,
            startedAt: new Date().toISOString(),
          });
        }
        break;
      }

      case 'progress':
        setProgress(event.data?.progress ?? event.progress ?? 0);
        break;

      case 'text_delta':
      case 'chunk':
        s.appendStreamingText(event.data?.text ?? event.text ?? event.data ?? '');
        break;

      case 'tool_call':
        s.addToolCall(event.data ?? event);
        break;

      case 'log':
        s.addLog({
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
        if (!s.lastUsageEventAt || (Date.now() - new Date(s.lastUsageEventAt).getTime()) > 500) {
          s.updateRunUsage({
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
          s.addLog({
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
              try {
                useNotificationStore.getState().addNotification({
                  type: 'approval_required',
                  title: `${stageName} needs approval`,
                  message: 'Review the output and approve to advance the pipeline.',
                  metadata: { stage: stageName },
                });
              } catch { /* non-fatal */ }
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
        setIsExecuting(false);
        setCurrentPhase(null);
        setProgress(100);

        // FORGE: fetch modernized file contents from API after completion
        if (stageName === 'FORGE' && s.currentPipelineRunId) {
          const pipeId = s.currentPipelineRunId;
          const authToken = useAuthStore.getState().token;
          const headers: Record<string, string> = {};
          if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

          fetch(`${BASE_URL}/pipeline/${pipeId}/modernized-files`, { headers })
            .then((r) => r.json())
            .then((data) => {
              const files = data?.files || [];
              for (const file of files) {
                fetch(`${BASE_URL}/pipeline/${pipeId}/modernized-files/${file.id}`, { headers })
                  .then((r) => r.json())
                  .then((detail) => {
                    if (detail?.content) {
                      store.getState().addModernizedFile({
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

      case 'failed':
      case 'stage_failed': {
        const errMsg = event.data?.error ?? event.error ?? 'Stage failed';
        if (idx >= 0) {
          s.setStageStatus(idx, 'failed');
          s.addLog({ type: 'error', message: errMsg, timestamp: new Date().toISOString() });
          flashError(stageName, errMsg);
        }
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
    setIsExecuting(false);
    setCurrentPhase(null);
  }, []);

  const output = usePipelineStore((s) => s.streamingText);

  return { executeStage, isExecuting, abort, currentPhase, progress, output };
}
