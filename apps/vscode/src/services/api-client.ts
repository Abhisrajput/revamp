import axios, { AxiosInstance, AxiosError } from "axios";
import * as vscode from "vscode";
import { getConfig, getAuthToken } from "../utils/config.js";

export interface ApiResponse<T = any> {
  data?: T;
  error?: string;
  message?: string;
}

export class RevampApiClient {
  private client: AxiosInstance;
  private apiUrl: string;

  constructor() {
    const config = getConfig();
    this.apiUrl = config.apiUrl;

    this.client = axios.create({
      baseURL: this.apiUrl,
      timeout: 30000,
      headers: {
        "Content-Type": "application/json",
      },
    });

    // Response interceptor for error handling
    this.client.interceptors.response.use(
      (response) => response,
      (error: AxiosError) => {
        if (error.response?.status === 401) {
          // Token expired or rejected — prompt re-authentication via device flow
          this.clearAuthToken();
          vscode.commands.executeCommand("setContext", "revamp.authenticated", false);
          vscode.window
            .showWarningMessage("REVAMP session expired. Please sign in again.", "Sign In")
            .then((selection) => {
              if (selection === "Sign In") {
                vscode.commands.executeCommand("revamp.signIn");
              }
            });
        }
        return Promise.reject(error);
      }
    );
  }

  async setAuthToken(token: string): Promise<void> {
    this.client.defaults.headers.common["Authorization"] = `Bearer ${token}`;
  }

  clearAuthToken(): void {
    delete this.client.defaults.headers.common["Authorization"];
  }

  async signin(email: string, password: string): Promise<{ token: string; user: any }> {
    const response = await this.client.post("/auth/signin", { email, password });
    return response.data;
  }

  async signup(data: {
    email: string;
    password: string;
    first_name: string;
    last_name: string;
    organization_name?: string;
  }): Promise<{ token: string; user: any }> {
    const response = await this.client.post("/auth/signup", data);
    return response.data;
  }

  async verifyToken(): Promise<{ valid: boolean; user: any }> {
    const response = await this.client.get("/auth/verify");
    return response.data;
  }

  // Project endpoints
  async listProjects(): Promise<any[]> {
    const response = await this.client.get("/projects");
    return response.data;
  }

  async createProject(data: {
    name: string;
    description?: string;
    repository_url?: string;
  }): Promise<{ id: string }> {
    const response = await this.client.post("/projects", data);
    return response.data;
  }

  async getProject(projectId: string): Promise<any> {
    const response = await this.client.get(`/projects/${projectId}`);
    return response.data;
  }

  async updateProject(projectId: string, data: any): Promise<void> {
    await this.client.patch(`/projects/${projectId}`, data);
  }

  async addProjectMember(projectId: string, userId: string, role: string): Promise<void> {
    await this.client.post(`/projects/${projectId}/members`, { user_id: userId, role });
  }

  // Pipeline endpoints
  async startPipeline(projectId: string): Promise<{ pipeline_run_id: string }> {
    const response = await this.client.post("/pipeline/start", { project_id: projectId });
    return response.data;
  }

  async getPipelineStatus(pipelineRunId: string): Promise<any> {
    const response = await this.client.get(`/pipeline/${pipelineRunId}/status`);
    return response.data;
  }

  async getPipelineArtifacts(pipelineRunId: string): Promise<any[]> {
    const response = await this.client.get(`/pipeline/${pipelineRunId}/artifacts`);
    return response.data;
  }

  async approvePipelineGate(pipelineRunId: string, stage: string, comment?: string): Promise<void> {
    await this.client.post(`/pipeline/${pipelineRunId}/approve/${stage}`, { comment });
  }

  async rejectPipelineGate(pipelineRunId: string, stage: string, reason: string): Promise<void> {
    await this.client.post(`/pipeline/${pipelineRunId}/reject/${stage}`, { reason });
  }

  // Agent endpoints
  async executeAgent(agentType: string, code: string, language: string, stream = false): Promise<any> {
    const response = await this.client.post("/agents/execute", {
      agent_type: agentType,
      code,
      language,
      stream,
    });
    return response.data;
  }

  async *streamAgent(agentType: string, code: string, language: string): AsyncGenerator<any> {
    try {
      const response = await this.client.post("/agents/execute", {
        agent_type: agentType,
        code,
        language,
        stream: true,
      });

      if (response.data) {
        const lines = response.data.split("\n");
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              yield JSON.parse(line.substring(6));
            } catch {
              // Skip parsing errors
            }
          }
        }
      }
    } catch (error) {
      console.error("Stream error:", error);
      throw error;
    }
  }

  // Storage endpoints
  async generateUploadUrl(projectId: string, filename: string): Promise<{ upload_url: string; storage_key: string }> {
    const response = await this.client.post("/storage/upload-url", {
      project_id: projectId,
      filename,
    });
    return response.data;
  }

  async generateDownloadUrl(storageKey: string): Promise<{ download_url: string }> {
    const response = await this.client.post("/storage/download-url", {
      storage_key: storageKey,
    });
    return response.data;
  }

  async deleteStorageObject(key: string): Promise<void> {
    await this.client.delete(`/storage/${encodeURIComponent(key)}`);
  }
}

let apiClient: RevampApiClient | null = null;

export function getApiClient(): RevampApiClient {
  if (!apiClient) {
    apiClient = new RevampApiClient();
  }
  return apiClient;
}
