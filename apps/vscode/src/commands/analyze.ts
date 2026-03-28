import * as vscode from "vscode";
import { getApiClient } from "../services/api-client.js";
import { llmStreamClient } from "../services/llm-stream.js";
import { workspaceAnalyzer } from "../services/workspace-analyzer.js";

export async function analyzeCodeCommand(context: vscode.ExtensionContext) {
  return async (uri?: vscode.Uri) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor && !uri) {
      vscode.window.showErrorMessage("No file selected");
      return;
    }

    const fileUri = uri || editor!.document.uri;
    const document = await vscode.workspace.openTextDocument(fileUri);
    const code = document.getText();
    const language = document.languageId;

    const progressOptions: vscode.ProgressOptions = {
      location: vscode.ProgressLocation.Notification,
      title: "Analyzing code with REVAMP...",
      cancellable: true,
    };

    await vscode.window.withProgress(progressOptions, async (progress, token) => {
      token.onCancellationRequested(() => {
        llmStreamClient.cancel();
      });

      const outputChannel = vscode.window.createOutputChannel("REVAMP Analysis");
      outputChannel.show();
      outputChannel.appendLine(`Analyzing ${document.fileName}`);
      outputChannel.appendLine("---");

      try {
        // First do local workspace analysis
        const localAnalysis = await workspaceAnalyzer.analyzeFile(fileUri);
        outputChannel.appendLine(`File: ${localAnalysis.file}`);
        outputChannel.appendLine(`Language: ${localAnalysis.language}`);
        outputChannel.appendLine(`Lines of code: ${localAnalysis.metrics.lines_of_code}`);
        outputChannel.appendLine(`Legacy score: ${localAnalysis.metrics.legacy_score}/100`);
        outputChannel.appendLine("");
        outputChannel.appendLine("Issues found:");
        for (const issue of localAnalysis.issues) {
          outputChannel.appendLine(`  [${issue.severity}] Line ${issue.line}: ${issue.description}`);
        }
        outputChannel.appendLine("");
        outputChannel.appendLine("Streaming analysis from server...");
        outputChannel.appendLine("---");

        progress.report({ increment: 30, message: "Streaming analysis..." });

        // Then stream LLM analysis
        let eventCount = 0;
        for await (const event of llmStreamClient.stream("analyzer", code, language)) {
          if (event.type === "start") {
            outputChannel.appendLine("Analysis started...");
          } else if (event.type === "content") {
            eventCount++;
            const content = event.data?.choices?.[0]?.delta?.content || event.data?.content || "";
            if (content) {
              outputChannel.append(content);
            }
            progress.report({ increment: 10, message: `Processing (${eventCount} events)...` });
          } else if (event.type === "complete") {
            outputChannel.appendLine("\n\nAnalysis complete!");
            progress.report({ increment: 60 });
          } else if (event.type === "error") {
            outputChannel.appendLine(`\nError: ${event.error}`);
            vscode.window.showErrorMessage(`Analysis failed: ${event.error}`);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        outputChannel.appendLine(`Error: ${message}`);
        vscode.window.showErrorMessage(`Analysis failed: ${message}`);
      }
    });
  };
}
