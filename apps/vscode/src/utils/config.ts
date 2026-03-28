import * as vscode from "vscode";

export interface RevampConfig {
  apiUrl: string;
  defaultModel: string;
  autoAnalyze: boolean;
  enableNotifications: boolean;
  authToken?: string;
}

export function getConfig(): RevampConfig {
  const config = vscode.workspace.getConfiguration("revamp");

  return {
    apiUrl: config.get("apiUrl") || "http://localhost:3000",
    defaultModel: config.get("defaultModel") || "gpt-4-turbo",
    autoAnalyze: config.get("autoAnalyze") || false,
    enableNotifications: config.get("enableNotifications") !== false,
    authToken: undefined, // Load from secrets
  };
}

export async function getAuthToken(): Promise<string | undefined> {
  const context = require("../extension").getContext();
  if (!context) return undefined;

  return context.secrets.get("revamp.authToken");
}

export async function setAuthToken(token: string, context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.store("revamp.authToken", token);
}

export async function clearAuthToken(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete("revamp.authToken");
}

export function updateConfig(key: string, value: any): Thenable<void> {
  return vscode.workspace.getConfiguration("revamp").update(key, value, vscode.ConfigurationTarget.Global);
}
