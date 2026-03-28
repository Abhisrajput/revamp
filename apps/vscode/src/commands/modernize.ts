import * as vscode from "vscode";
import { getApiClient } from "../services/api-client.js";
import { llmStreamClient } from "../services/llm-stream.js";

export async function modernizeFileCommand(context: vscode.ExtensionContext) {
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

    // Ask user for target framework/language
    const targetFramework = await vscode.window.showInputBox({
      prompt: "Target framework or language (optional)",
      placeHolder: "e.g., React, Vue, TypeScript, Python 3.10",
    });

    const progressOptions: vscode.ProgressOptions = {
      location: vscode.ProgressLocation.Notification,
      title: "Modernizing code with REVAMP...",
      cancellable: true,
    };

    await vscode.window.withProgress(progressOptions, async (progress, token) => {
      token.onCancellationRequested(() => {
        llmStreamClient.cancel();
      });

      try {
        // Create output channel for modernized code
        const outputChannel = vscode.window.createOutputChannel("REVAMP Modernized Code");
        outputChannel.show();
        outputChannel.appendLine(`Original file: ${document.fileName}`);
        outputChannel.appendLine(`Language: ${language}`);
        if (targetFramework) {
          outputChannel.appendLine(`Target: ${targetFramework}`);
        }
        outputChannel.appendLine("---");
        outputChannel.appendLine("");

        progress.report({ increment: 20, message: "Streaming modernized code..." });

        let modernizedCode = "";
        for await (const event of llmStreamClient.stream("modernizer", code, language)) {
          if (event.type === "start") {
            outputChannel.appendLine("Modernization started...");
          } else if (event.type === "content") {
            const content = event.data?.choices?.[0]?.delta?.content || event.data?.content || "";
            if (content) {
              modernizedCode += content;
              outputChannel.append(content);
            }
            progress.report({ increment: 5 });
          } else if (event.type === "complete") {
            outputChannel.appendLine("\n\nModernization complete!");
            progress.report({ increment: 75 });

            // Offer to apply changes
            const applyChanges = await vscode.window.showQuickPick(
              [
                { label: "Apply Changes", description: "Replace file content" },
                { label: "Create New File", description: "Save as new file" },
                { label: "Diff View", description: "Show side-by-side comparison" },
                { label: "Discard", description: "Cancel changes" },
              ],
              { placeHolder: "What would you like to do?" }
            );

            if (applyChanges?.label === "Apply Changes") {
              const edit = new vscode.WorkspaceEdit();
              const fullRange = new vscode.Range(
                document.positionAt(0),
                document.positionAt(code.length)
              );
              edit.replace(fileUri, fullRange, modernizedCode);
              await vscode.workspace.applyEdit(edit);
              vscode.window.showInformationMessage("Changes applied!");
            } else if (applyChanges?.label === "Create New File") {
              const newFileName = document.fileName.replace(/(\.[^.]+)$/, ".modernized$1");
              const newUri = fileUri.with({ path: newFileName });
              const edit = new vscode.WorkspaceEdit();
              edit.createFile(newUri, { ignoreIfExists: false, overwrite: false });
              edit.insert(newUri, new vscode.Position(0, 0), modernizedCode);
              await vscode.workspace.applyEdit(edit);
              vscode.window.showInformationMessage(`Saved as ${newFileName}`);
            }
          } else if (event.type === "error") {
            outputChannel.appendLine(`\nError: ${event.error}`);
            vscode.window.showErrorMessage(`Modernization failed: ${event.error}`);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        vscode.window.showErrorMessage(`Modernization failed: ${message}`);
      }
    });
  };
}
