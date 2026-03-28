import * as vscode from "vscode";
import { getApiClient } from "../services/api-client.js";

export class PipelineViewDataProvider implements vscode.TreeDataProvider<PipelineStageItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<PipelineStageItem | undefined | null | void> =
    new vscode.EventEmitter<PipelineStageItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<PipelineStageItem | undefined | null | void> =
    this._onDidChangeTreeData.event;

  private apiClient = getApiClient();
  private currentPipelineRunId: string | null = null;

  setCurrentPipelineRun(pipelineRunId: string): void {
    this.currentPipelineRunId = pipelineRunId;
    this.refresh();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: PipelineStageItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: PipelineStageItem): Promise<PipelineStageItem[]> {
    if (!this.currentPipelineRunId) {
      return [
        new PipelineStageItem(
          "No pipeline selected",
          undefined,
          vscode.TreeItemCollapsibleState.None
        ),
      ];
    }

    try {
      const status = await this.apiClient.getPipelineStatus(this.currentPipelineRunId);

      const stages = [
        { name: "Analysis", id: "analysis" },
        { name: "Modernization", id: "modernization" },
        { name: "Testing", id: "testing" },
        { name: "Review", id: "review" },
        { name: "Deployment", id: "deployment" },
      ];

      return stages.map((stage) => {
        let icon = "circle-large-outline";
        let description = "";

        if (stage.id === status.current_stage) {
          icon = "circle-large";
          description = "Running";
        } else if (
          stages.findIndex((s) => s.id === stage.id) <
          stages.findIndex((s) => s.id === status.current_stage)
        ) {
          icon = "pass";
          description = "Complete";
        }

        const item = new PipelineStageItem(
          stage.name,
          stage.id,
          vscode.TreeItemCollapsibleState.None
        );
        item.description = description;
        item.iconPath = new vscode.ThemeIcon(icon);
        return item;
      });
    } catch (error) {
      console.error("Error fetching pipeline status:", error);
      return [];
    }
  }
}

export class PipelineStageItem extends vscode.TreeItem {
  constructor(
    label: string,
    public stageId: string | undefined,
    collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None
  ) {
    super(label, collapsibleState);
    this.stageId = stageId;
  }
}
