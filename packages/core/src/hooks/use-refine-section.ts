import { useCallback } from 'react';
import { getApiClient } from '../api/types';

interface RefineSectionContext {
  sectionTitle: string;
  sectionContent: string;
  userFeedback: string;
  fullText: string;
}

type RefineFn = (context: RefineSectionContext) => Promise<string>;

/**
 * Returns a refine function bound to the given pipeline run and stage.
 * The returned function takes a section context and resolves with the refined content string.
 *
 * Usage (matching center-panel.tsx):
 *   const onRefineRequest = useRefineSection(pipelineRunId, stage.name);
 */
export function useRefineSection(
  pipelineRunId: string | null | undefined,
  stageName: string | null | undefined,
): RefineFn {
  const refine = useCallback(
    async (context: RefineSectionContext): Promise<string> => {
      const res = await getApiClient().post('/pipeline/refine-section', {
        section_title: context.sectionTitle,
        section_content: context.sectionContent,
        user_feedback: context.userFeedback,
        full_text: context.fullText,
        pipeline_run_id: pipelineRunId ?? null,
        stage_name: stageName ?? null,
      });

      return res.data?.refined_content ?? res.data?.content ?? res.data?.text ?? '';
    },
    [pipelineRunId, stageName],
  );

  return refine;
}
