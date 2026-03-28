import * as vscode from "vscode";
import { getApiClient } from "../services/api-client.js";

export class ProjectTreeDataProvider implements vscode.TreeDataProvider<ProjectTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<ProjectTreeItem | undefined | null | void> =
    new vscode.EventEmitter<ProjectTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<ProjectTreeItem | undefined | null | void> =
    this._onDidChangeTreeData.event;

  private apiClient = getApiClient();

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ProjectTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ProjectTreeItem): Promise<ProjectTreeItem[]> {
    if (!element) {
      // Root items - show projects
      try {
        const projects = await this.apiClient.listProjects();
        return projects.map(
          (project) =>
            new ProjectTreeItem(
              project.name,
              project.id,
              vscode.TreeItemCollapsibleState.Collapsed,
              {
                command: "revamp.showProject",
                title: "Show Project",
                arguments: [project.id],
              }
            )
        );
      } catch (error) {
        console.error("Error fetching projects:", error);
        return [];
      }
    } else {
      // Show project details
      try {
        const project = await this.apiClient.getProject(element.projectId);
        const items: ProjectTreeItem[] = [];

        items.push(
          new ProjectTreeItem(
            `Status: ${project.status}`,
            `${element.projectId}-status`,
            vscode.TreeItemCollapsibleState.None
          )
        );

        items.push(
          new ProjectTreeItem(
            `Stage: ${project.current_stage}`,
            `${element.projectId}-stage`,
            vscode.TreeItemCollapsibleState.None
          )
        );

        if (project.members && project.members.length > 0) {
          items.push(
            new ProjectTreeItem(
              `Members (${project.members.length})`,
              `${element.projectId}-members`,
              vscode.TreeItemCollapsibleState.Collapsed
            )
          );
        }

        if (project.pipelineRuns && project.pipelineRuns.length > 0) {
          items.push(
            new ProjectTreeItem(
              `Pipelines (${project.pipelineRuns.length})`,
              `${element.projectId}-pipelines`,
              vscode.TreeItemCollapsibleState.Collapsed
            )
          );
        }

        return items;
      } catch (error) {
        console.error("Error fetching project details:", error);
        return [];
      }
    }
  }
}

export class ProjectTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    public projectId: string,
    collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None,
    command?: vscode.Command
  ) {
    super(label, collapsibleState);
    this.projectId = projectId;
    if (command) {
      this.command = command;
    }
  }
}
