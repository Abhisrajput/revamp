import * as vscode from "vscode";
import { getApiClient } from "./api-client.js";

export interface StreamEvent {
  type: "start" | "content" | "complete" | "error";
  data?: any;
  error?: string;
}

export class LLMStreamClient {
  private abortController: AbortController | null = null;

  async *stream(agentType: string, code: string, language: string): AsyncGenerator<StreamEvent> {
    this.abortController = new AbortController();

    try {
      const apiClient = getApiClient();

      // Send initial event
      yield { type: "start", data: { agent_type: agentType } };

      // Stream from API
      let buffer = "";

      const response = await fetch(
        `${vscode.workspace.getConfiguration("revamp").get("apiUrl") || "http://localhost:3000"}/agents/execute`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${await this.getAuthToken()}`,
          },
          body: JSON.stringify({
            agent_type: agentType,
            code,
            language,
            stream: true,
          }),
          signal: this.abortController.signal,
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body");
      }

      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");

        // Process complete lines
        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i];
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.substring(6));
              yield { type: "content", data };
            } catch {
              // Skip parsing errors
            }
          }
        }

        buffer = lines[lines.length - 1];
      }

      // Process any remaining data
      if (buffer) {
        if (buffer.startsWith("data: ")) {
          try {
            const data = JSON.parse(buffer.substring(6));
            yield { type: "content", data };
          } catch {
            // Skip parsing errors
          }
        }
      }

      yield { type: "complete" };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        yield { type: "error", error: "Stream cancelled by user" };
      } else {
        yield {
          type: "error",
          error: error instanceof Error ? error.message : "Stream failed",
        };
      }
    } finally {
      this.abortController = null;
    }
  }

  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  private async getAuthToken(): Promise<string> {
    // Get from VS Code secrets or configuration
    const token = await vscode.authentication.getSession("revamp", [], { silent: true });
    return token?.accessToken || "";
  }
}

export const llmStreamClient = new LLMStreamClient();
