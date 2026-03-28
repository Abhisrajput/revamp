import * as vscode from "vscode";
import * as path from "path";
import { getApiClient } from "../services/api-client.js";

export class DashboardPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "revampDashboard";

  private apiClient = getApiClient();

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    token: vscode.CancellationToken
  ): void | Thenable<void> {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "resources"),
      ],
    };

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case "getProjects":
          try {
            const projects = await this.apiClient.listProjects();
            webviewView.webview.postMessage({
              command: "projectsLoaded",
              projects,
            });
          } catch (error) {
            webviewView.webview.postMessage({
              command: "error",
              message: `Failed to load projects: ${error}`,
            });
          }
          break;

        case "startPipeline":
          try {
            const result = await this.apiClient.startPipeline(message.projectId);
            webviewView.webview.postMessage({
              command: "pipelineStarted",
              pipelineRunId: result.pipeline_run_id,
            });
          } catch (error) {
            webviewView.webview.postMessage({
              command: "error",
              message: `Failed to start pipeline: ${error}`,
            });
          }
          break;

        case "getPipelineStatus":
          try {
            const status = await this.apiClient.getPipelineStatus(message.pipelineRunId);
            webviewView.webview.postMessage({
              command: "pipelineStatusUpdated",
              status,
            });
          } catch (error) {
            webviewView.webview.postMessage({
              command: "error",
              message: `Failed to get pipeline status: ${error}`,
            });
          }
          break;

        case "approvePipeline":
          try {
            await this.apiClient.approvePipelineGate(
              message.pipelineRunId,
              message.stage,
              message.comment
            );
            webviewView.webview.postMessage({
              command: "pipelineApproved",
              stage: message.stage,
            });
          } catch (error) {
            webviewView.webview.postMessage({
              command: "error",
              message: `Failed to approve pipeline: ${error}`,
            });
          }
          break;
      }
    });

    // Initial load
    webviewView.webview.postMessage({ command: "init" });
  }

  private getHtmlContent(webview: vscode.Webview): string {
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>REVAMP Dashboard</title>
        <style>
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }

          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 16px;
          }

          .container {
            max-width: 600px;
          }

          h1 {
            font-size: 20px;
            margin-bottom: 16px;
            color: var(--vscode-editor-foreground);
          }

          .section {
            margin-bottom: 24px;
            padding: 12px;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border-radius: 4px;
          }

          .section h2 {
            font-size: 14px;
            margin-bottom: 12px;
            color: var(--vscode-textBlockQuote-border);
          }

          .project-list {
            list-style: none;
          }

          .project-item {
            padding: 8px 12px;
            margin-bottom: 8px;
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            cursor: pointer;
            transition: background-color 0.2s;
          }

          .project-item:hover {
            background-color: var(--vscode-list-hoverBackground);
          }

          .project-name {
            font-weight: 500;
            margin-bottom: 4px;
          }

          .project-status {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
          }

          .button {
            display: inline-block;
            padding: 8px 16px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            transition: background-color 0.2s;
          }

          .button:hover {
            background-color: var(--vscode-button-hoverBackground);
          }

          .button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
          }

          .pipeline-stage {
            padding: 12px;
            margin-bottom: 8px;
            background-color: var(--vscode-input-background);
            border-left: 3px solid var(--vscode-descriptionForeground);
            border-radius: 2px;
          }

          .pipeline-stage.active {
            border-left-color: var(--vscode-terminal-ansiGreen);
            background-color: var(--vscode-list-activeSelectionBackground);
          }

          .pipeline-stage.completed {
            border-left-color: var(--vscode-terminal-ansiBlue);
          }

          .loading {
            text-align: center;
            color: var(--vscode-descriptionForeground);
            padding: 16px;
          }

          .error {
            padding: 12px;
            background-color: var(--vscode-inputValidation-errorBackground);
            border: 1px solid var(--vscode-inputValidation-errorBorder);
            border-radius: 4px;
            color: var(--vscode-inputValidation-errorForeground);
            margin-bottom: 16px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>REVAMP Dashboard</h1>

          <div id="error" class="error" style="display: none;"></div>

          <div class="section">
            <h2>Projects</h2>
            <div id="projects-container" class="loading">Loading projects...</div>
          </div>

          <div class="section">
            <h2>Current Pipeline</h2>
            <div id="pipeline-container" class="loading">No pipeline running</div>
          </div>
        </div>

        <script>
          const vscode = acquireVsCodeApi();

          document.addEventListener('DOMContentLoaded', () => {
            vscode.postMessage({ command: 'getProjects' });
          });

          window.addEventListener('message', (event) => {
            const message = event.data;

            switch (message.command) {
              case 'projectsLoaded':
                renderProjects(message.projects);
                break;

              case 'pipelineStatusUpdated':
                renderPipelineStatus(message.status);
                break;

              case 'error':
                showError(message.message);
                break;

              case 'pipelineStarted':
                console.log('Pipeline started:', message.pipelineRunId);
                vscode.postMessage({
                  command: 'getPipelineStatus',
                  pipelineRunId: message.pipelineRunId
                });
                break;
            }
          });

          function renderProjects(projects) {
            const container = document.getElementById('projects-container');
            if (projects.length === 0) {
              container.innerHTML = '<p style="color: var(--vscode-descriptionForeground);">No projects yet</p>';
              return;
            }

            const html = projects.map((project) => \`
              <div class="project-item" onclick="startPipeline('\${project.id}')">
                <div class="project-name">\${project.name}</div>
                <div class="project-status">
                  Status: \${project.status} • Stage: \${project.current_stage}
                </div>
              </div>
            \`).join('');

            container.innerHTML = html;
          }

          function renderPipelineStatus(status) {
            const container = document.getElementById('pipeline-container');
            const stages = ['analysis', 'modernization', 'testing', 'review', 'deployment'];
            const stageNames = {
              analysis: 'Analysis',
              modernization: 'Modernization',
              testing: 'Testing',
              review: 'Review',
              deployment: 'Deployment'
            };

            const html = stages.map((stage) => {
              const isActive = stage === status.current_stage;
              const isCompleted = stages.indexOf(stage) < stages.indexOf(status.current_stage);
              const cssClass = isActive ? 'pipeline-stage active' : isCompleted ? 'pipeline-stage completed' : 'pipeline-stage';

              return \`<div class="\${cssClass}">\${stageNames[stage]}</div>\`;
            }).join('');

            container.innerHTML = html;
          }

          function startPipeline(projectId) {
            vscode.postMessage({
              command: 'startPipeline',
              projectId: projectId
            });
          }

          function showError(message) {
            const errorDiv = document.getElementById('error');
            errorDiv.textContent = message;
            errorDiv.style.display = 'block';
          }
        </script>
      </body>
      </html>
    `;
  }
}
