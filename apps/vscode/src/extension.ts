import * as vscode from "vscode";
import { getApiClient } from "./services/api-client.js";
import { getConfig } from "./utils/config.js";
import { analyzeCodeCommand } from "./commands/analyze.js";
import { modernizeFileCommand } from "./commands/modernize.js";
import { runPipelineCommand } from "./commands/pipeline.js";
import { ProjectTreeDataProvider } from "./providers/project-tree.js";
import { PipelineViewDataProvider } from "./providers/pipeline-view.js";
import { DashboardPanelProvider } from "./providers/dashboard-panel.js";
import { startDeviceFlow, getAccessToken, signOut } from "./auth/device-flow.js";
import { llmStreamClient } from "./services/llm-stream.js";

let extensionContext: vscode.ExtensionContext | null = null;

export function getContext(): vscode.ExtensionContext | null {
  return extensionContext;
}

export async function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  const config = getConfig();
  const apiClient = getApiClient();

  console.log("REVAMP extension activating...");

  // Wire the ExtensionContext into services that need secret-based auth
  llmStreamClient.setContext(context);

  // Try to restore Keycloak token from secrets and attach to API client
  const savedToken = await getAccessToken(context);
  if (savedToken) {
    await apiClient.setAuthToken(savedToken);
    vscode.commands.executeCommand("setContext", "revamp.authenticated", true);
  }

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("revamp.startProject", async () => {
      const name = await vscode.window.showInputBox({
        prompt: "Project name",
        placeHolder: "My Legacy App",
      });

      if (!name) return;

      try {
        const result = await apiClient.createProject({
          name,
          description: await vscode.window.showInputBox({
            prompt: "Project description (optional)",
          }),
        });

        vscode.window.showInformationMessage(`Project "${name}" created!`);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to create project: ${error}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("revamp.analyzeCode", analyzeCodeCommand(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("revamp.modernizeFile", modernizeFileCommand(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("revamp.runPipeline", runPipelineCommand(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("revamp.showDashboard", async () => {
      vscode.commands.executeCommand("revampDashboard.focus");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("revamp.compareVersions", async () => {
      vscode.window.showInformationMessage("Diff view coming soon!");
    })
  );

  // Keycloak device-code auth commands
  context.subscriptions.push(
    vscode.commands.registerCommand("revamp.signIn", async () => {
      try {
        const bundle = await startDeviceFlow(context);
        await apiClient.setAuthToken(bundle.access_token);
        vscode.commands.executeCommand("setContext", "revamp.authenticated", true);
        vscode.window.showInformationMessage("Signed in to REVAMP.");
      } catch (err: any) {
        vscode.window.showErrorMessage(`Sign-in failed: ${err.message}`);
      }
    }),
    vscode.commands.registerCommand("revamp.signOut", async () => {
      await signOut(context);
      apiClient.clearAuthToken();
      vscode.commands.executeCommand("setContext", "revamp.authenticated", false);
      vscode.window.showInformationMessage("Signed out of REVAMP.");
    }),
  );

  // Register tree data providers
  const projectTreeProvider = new ProjectTreeDataProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("revampExplorer", projectTreeProvider)
  );

  const pipelineViewProvider = new PipelineViewDataProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("pipelineView", pipelineViewProvider)
  );

  // Register webview provider
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "dashboardPanel",
      new DashboardPanelProvider(context),
      {
        webviewOptions: { retainContextWhenHidden: true },
      }
    )
  );

  // Auto-refresh UI periodically; also re-attach the latest token on each tick
  setInterval(async () => {
    const token = await getAccessToken(context);
    if (token) {
      await apiClient.setAuthToken(token);
    }
    projectTreeProvider.refresh();
    pipelineViewProvider.refresh();
  }, 30000); // Every 30 seconds

  console.log("REVAMP extension activated successfully!");
}

export function deactivate() {
  console.log("REVAMP extension deactivating...");
}
