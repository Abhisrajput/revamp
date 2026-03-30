'use client';

import { useState, useCallback, useRef } from 'react';
import { usePipelineStore } from '@/lib/stores/pipeline-store';
import { useAuthStore } from '@/lib/stores/auth-store';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8787';

interface ExecuteOptions {
  skipLlmEval?: boolean;
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

      fetch(`${BASE_URL}/pipeline/${pipelineRunId}/execute/${stageName}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({ skip_llm_eval: options.skipLlmEval ?? false }),
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
                // Finalize
                const s = store.getState();
                const idx = s.stages.findIndex((st) => st.name === stageName);
                if (idx >= 0) {
                  const stage = s.stages[idx];
                  if (stage.status === 'generating' || stage.status === 'validating') {
                    s.setStageOutput(idx, s.streamingText);
                    s.setStageStatus(idx, 'completed');
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
            s.addLog({
              type: 'error',
              message: err.message ?? 'Stage execution failed',
              timestamp: new Date().toISOString(),
            });
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

        // SCAN/DECODE: subtask events
        if ((phase === 'subtask_executing' || phase === 'scout_assessment' || phase === 'director_planning' || phase === 'composing') && event.data?.data) {
          s.addLog({
            type: 'info',
            message: (event.data.data as Record<string, unknown>)?.message ?? phase,
            timestamp: new Date().toISOString(),
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
        break;

      case 'validation':
        if (idx >= 0) {
          s.setStageStatus(idx, 'validating');
          setCurrentPhase('validating');
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
          s.setStageOutput(idx, finalOutput);
          s.setStageStatus(idx, 'completed');
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
      case 'stage_failed':
        if (idx >= 0) {
          s.setStageStatus(idx, 'failed');
          s.addLog({
            type: 'error',
            message: event.data?.error ?? event.error ?? 'Stage failed',
            timestamp: new Date().toISOString(),
          });
        }
        setIsExecuting(false);
        setCurrentPhase(null);
        break;

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
