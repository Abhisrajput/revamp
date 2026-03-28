import * as vscode from "vscode";
import { getApiClient } from "../services/api-client.js";

export async function runPipelineCommand(context: vscode.ExtensionContext) {
  return async () => {
    const apiClient = getApiClient();

    try {
      // Get list of projects
      const projects = await apiClient.listProjects();

      if (projects.length === 0) {
        vscode.window.showInformationMessage("No projects found. Create a project first.");
        return;
      }

      // Let user select a project
      const projectQuickPick = await vscode.window.showQuickPick(
        projects.map((p) => ({
          label: p.name,
          description: p.description,
          projectId: p.id,
        })),
        { placeHolder: "Select a project to modernize" }
      );

      if (!projectQuickPick) return;

      const progressOptions: vscode.ProgressOptions = {
        location: vscode.ProgressLocation.Notification,
        title: "Running modernization pipeline...",
        cancellable: true,
      };

      let pipelineRunId: string;

      await vscode.window.withProgress(progressOptions, async (progress, token) => {
        try {
          // Start pipeline
          progress.report({ increment: 10, message: "Starting pipeline..." });
          const result = await apiClient.startPipeline(projectQuickPick.projectId);
          pipelineRunId = result.pipeline_run_id;

          progress.report({ increment: 20, message: "Pipeline started, monitoring..." });

          // Poll for status
          let isComplete = false;
          let pollCount = 0;
          const maxPolls = 60; // 5 minutes with 5-second intervals

          while (!isComplete && pollCount < maxPolls && !token.isCancellationRequested) {
            await new Promise((resolve) => setTimeout(resolve, 5000)); // Wait 5 seconds

            const status = await apiClient.getPipelineStatus(pipelineRunId);

            if (status.status === "completed") {
              progress.report({ increment: 70, message: "Pipeline completed!" });
              isComplete = true;

              // Get artifacts
              const artifacts = await apiClient.getPipelineArtifacts(pipelineRunId);

              const outputChannel = vscode.window.createOutputChannel("REVAMP Pipeline");
              outputChannel.show();
              outputChannel.appendLine("Pipeline completed successfully!");
              outputChannel.appendLine(`Pipeline ID: ${pipelineRunId}`);
              outputChannel.appendLine(`Status: ${status.status}`);
              outputChannel.appendLine(`Artifacts: ${artifacts.length}`);

              artifacts.forEach((artifact, index) => {
                outputChannel.appendLine(`  ${index + 1}. ${artifact.artifact_type} - ${artifact.stage_name}`);
              });

              vscode.window.showInformationMessage(
                "Pipeline completed! Check output channel for details."
              );
            } else if (status.status === "failed") {
              isComplete = true;
              progress.report({ increment: 100 });
              vscode.window.showErrorMessage(
                `Pipeline failed: ${status.error_message || "Unknown error"}`
              );
            } else {
              const incrementPerStage = 60 / maxPolls;
              progress.report({
                increment: incrementPerStage,
                message: `Running stage: ${status.current_stage}...`,
              });
              pollCount++;
            }
          }

          if (token.isCancellationRequested) {
            vscode.window.showInformationMessage("Pipeline monitoring cancelled.");
          } else if (!isComplete) {
            vscode.window.showWarningMessage("Pipeline still running. Check REVAMP dashboard for updates.");
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          vscode.window.showErrorMessage(`Pipeline execution failed: ${message}`);
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      vscode.window.showErrorMessage(`Failed to run pipeline: ${message}`);
    }
  };
}
