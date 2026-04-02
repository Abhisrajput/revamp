/**
 * Jira Integration Client — connects to Jira Cloud REST API v3.
 *
 * Enables:
 *   - Pull Jira board/issues into the agent Kanban view
 *   - Assign Jira issues to agents
 *   - Post agent work comments back to Jira
 *   - Sync transitions (agent completes → moves Jira issue)
 *
 * Config via env vars:
 *   JIRA_BASE_URL    — e.g. https://yourteam.atlassian.net
 *   JIRA_EMAIL       — Atlassian account email
 *   JIRA_API_TOKEN   — API token from https://id.atlassian.net/manage-profile/security/api-tokens
 *   JIRA_PROJECT_KEY — e.g. "REV" (default project to query)
 *   JIRA_BOARD_ID    — optional: specific board ID
 */

const JIRA_BASE_URL = process.env.JIRA_BASE_URL || "";
const JIRA_EMAIL = process.env.JIRA_EMAIL || "";
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN || "";
const JIRA_PROJECT_KEY = process.env.JIRA_PROJECT_KEY || "";

// ─── TYPES ──────────────────────────────────────────────────────

export interface JiraIssue {
  id: string;
  key: string;
  summary: string;
  description: string;
  status: string;
  statusCategory: "new" | "indeterminate" | "done";
  priority: string;
  assignee: string | null;
  reporter: string | null;
  labels: string[];
  issueType: string;
  created: string;
  updated: string;
  storyPoints?: number;
  comments: JiraComment[];
  url: string;
}

export interface JiraComment {
  id: string;
  author: string;
  body: string;
  created: string;
}

export interface JiraBoard {
  columns: Array<{
    name: string;
    statusCategory: string;
    issues: JiraIssue[];
  }>;
  total: number;
  projectKey: string;
}

// ─── CLIENT ─────────────────────────────────────────────────────

export function isJiraConfigured(): boolean {
  return !!(JIRA_BASE_URL && JIRA_EMAIL && JIRA_API_TOKEN);
}

async function jiraFetch(path: string, options?: RequestInit): Promise<any> {
  if (!isJiraConfigured()) {
    throw new Error("Jira is not configured. Set JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN.");
  }

  const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64");
  const url = `${JIRA_BASE_URL}/rest/api/3${path}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Jira API ${res.status}: ${text}`);
  }

  return res.json();
}

// ─── ISSUE OPERATIONS ───────────────────────────────────────────

/** Fetch issues for the configured project, grouped by status. */
export async function getJiraBoard(projectKey?: string): Promise<JiraBoard> {
  const key = projectKey || JIRA_PROJECT_KEY;
  if (!key) throw new Error("No JIRA_PROJECT_KEY configured");

  const jql = `project = ${key} ORDER BY status ASC, priority DESC, updated DESC`;
  const data = await jiraFetch(`/search/jql`, {
    method: "POST",
    body: JSON.stringify({
      jql,
      maxResults: 100,
      fields: ["summary", "status", "priority", "assignee", "reporter", "labels", "issuetype", "created", "updated", "comment", "customfield_10016"],
    }),
  });

  const issues: JiraIssue[] = (data.issues || []).map(mapIssue);

  // Group by status
  const columnMap = new Map<string, { name: string; statusCategory: string; issues: JiraIssue[] }>();
  for (const issue of issues) {
    const key = issue.status;
    if (!columnMap.has(key)) {
      columnMap.set(key, { name: issue.status, statusCategory: issue.statusCategory, issues: [] });
    }
    columnMap.get(key)!.issues.push(issue);
  }

  // Sort columns: new → indeterminate → done
  const categoryOrder: Record<string, number> = { new: 0, indeterminate: 1, done: 2 };
  const columns = [...columnMap.values()].sort(
    (a, b) => (categoryOrder[a.statusCategory] ?? 1) - (categoryOrder[b.statusCategory] ?? 1),
  );

  return { columns, total: issues.length, projectKey: key };
}

/** Get a single issue with full details. */
export async function getJiraIssue(issueKey: string): Promise<JiraIssue> {
  const data = await jiraFetch(`/issue/${issueKey}?fields=summary,status,priority,assignee,reporter,labels,issuetype,created,updated,comment,description,customfield_10016`);
  return mapIssue(data);
}

/** Post a comment on a Jira issue (agent reports progress). */
export async function addJiraComment(
  issueKey: string,
  body: string,
  agentName?: string,
): Promise<JiraComment> {
  const prefix = agentName ? `*[${agentName}]*\n\n` : "";
  const adfBody = {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: `${prefix}${body}` }],
      },
    ],
  };

  const data = await jiraFetch(`/issue/${issueKey}/comment`, {
    method: "POST",
    body: JSON.stringify({ body: adfBody }),
  });

  return {
    id: data.id,
    author: data.author?.displayName || "REVAMP Agent",
    body,
    created: data.created,
  };
}

/** Transition a Jira issue to a new status. */
export async function transitionJiraIssue(
  issueKey: string,
  transitionName: string,
): Promise<boolean> {
  // First, get available transitions
  const data = await jiraFetch(`/issue/${issueKey}/transitions`);
  const transition = (data.transitions || []).find(
    (t: any) => t.name.toLowerCase() === transitionName.toLowerCase(),
  );

  if (!transition) {
    const available = (data.transitions || []).map((t: any) => t.name).join(", ");
    throw new Error(`Transition "${transitionName}" not found. Available: ${available}`);
  }

  await jiraFetch(`/issue/${issueKey}/transitions`, {
    method: "POST",
    body: JSON.stringify({ transition: { id: transition.id } }),
  });

  return true;
}

/** Assign a Jira issue to a user by email or accountId. */
export async function assignJiraIssue(
  issueKey: string,
  accountId: string | null,
): Promise<boolean> {
  await jiraFetch(`/issue/${issueKey}/assignee`, {
    method: "PUT",
    body: JSON.stringify({ accountId }),
  });
  return true;
}

/** Search for Jira users. */
export async function searchJiraUsers(query: string): Promise<Array<{ accountId: string; displayName: string; email?: string }>> {
  const data = await jiraFetch(`/user/search?query=${encodeURIComponent(query)}&maxResults=10`);
  return (data || []).map((u: any) => ({
    accountId: u.accountId,
    displayName: u.displayName,
    email: u.emailAddress,
  }));
}

// ─── HELPERS ────────────────────────────────────────────────────

function mapIssue(raw: any): JiraIssue {
  const fields = raw.fields || {};
  const comments = (fields.comment?.comments || []).map((c: any) => ({
    id: c.id,
    author: c.author?.displayName || "Unknown",
    body: extractTextFromAdf(c.body),
    created: c.created,
  }));

  return {
    id: raw.id,
    key: raw.key,
    summary: fields.summary || "",
    description: extractTextFromAdf(fields.description),
    status: fields.status?.name || "Unknown",
    statusCategory: fields.status?.statusCategory?.key || "indeterminate",
    priority: fields.priority?.name || "Medium",
    assignee: fields.assignee?.displayName || null,
    reporter: fields.reporter?.displayName || null,
    labels: fields.labels || [],
    issueType: fields.issuetype?.name || "Task",
    created: fields.created || "",
    updated: fields.updated || "",
    storyPoints: fields.customfield_10016 ?? undefined,
    comments,
    url: `${JIRA_BASE_URL}/browse/${raw.key}`,
  };
}

/** Extract plain text from Atlassian Document Format (ADF). */
function extractTextFromAdf(adf: any): string {
  if (!adf) return "";
  if (typeof adf === "string") return adf;
  if (adf.type === "text") return adf.text || "";
  if (adf.content && Array.isArray(adf.content)) {
    return adf.content.map(extractTextFromAdf).join("\n");
  }
  return "";
}
