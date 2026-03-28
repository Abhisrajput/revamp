import * as vscode from "vscode";
import { getApiClient, setAuthToken, getAuthToken } from "./services/api-client.js";
import { getConfig } from "./utils/config.js";
import { analyzeCodeCommand } from "./commands/analyze.js";
import { modernizeFileCommand } from "./commands/modernize.js";
import { runPipelineCommand } from "./commands/pipeline.js";
import { ProjectTreeDataProvider } from "./providers/project-tree.js";
import { PipelineViewDataProvider } from "./providers/pipeline-view.js";
import { DashboardPanelProvider } from "./providers/dashboard-panel.js";

let extensionContext: vscode.ExtensionContext | null = null;

export function getContext(): vscode.ExtensionContext | null {
  return extensionContext;
}

export async function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  const config = getConfig();
  const apiClient = getApiClient();

  console.log("REVAMP extension activating...");

  // Try to restore auth token from secrets
  const savedToken = await context.secrets.get("revamp.authToken");
  if (savedToken) {
    await apiClient.setAuthToken(savedToken);

    try {
      const verification = await apiClient.verifyToken();
      if (verification.valid) {
        vscode.commands.executeCommand("setContext", "revamp.authenticated", true);
      } else {
        await context.secrets.delete("revamp.authToken");
      }
    } catch {
      await context.secrets.delete("revamp.authToken");
    }
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

  // Auth commands
  context.subscriptions.push(
    vscode.commands.registerCommand("revamp.signin", async () => {
      const email = await vscode.window.showInputBox({
        prompt: "Email",
        placeHolder: "you@example.com",
      });

      if (!email) return;

      const password = await vscode.window.showInputBox({
        prompt: "Password",
        password: true,
      });

      if (!password) return;

      try {
        const result = await apiClient.signin(email, password);
        await context.secrets.store("revamp.authToken", result.token);
        await apiClient.setAuthToken(result.token);

        vscode.commands.executeCommand("setContext", "revamp.authenticated", true);
        vscode.window.showInformationMessage(`Welcome, ${result.user.first_name}!`);
      } catch (error) {
        vscode.window.showErrorMessage(`Sign in failed: ${error}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("revamp.logout", async () => {
      await context.secrets.delete("revamp.authToken");
      vscode.commands.executeCommand("setContext", "revamp.authenticated", false);
      vscode.window.showInformationMessage("Signed out successfully");
    })
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

  // Auto-refresh UI periodically
  setInterval(() => {
    projectTreeProvider.refresh();
    pipelineViewProvider.refresh();
  }, 30000); // Every 30 seconds

  console.log("REVAMP extension activated successfully!");
}

export function deactivate() {
  console.log("REVAMP extension deactivating...");
}
