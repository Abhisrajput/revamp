/**
 * GitHub Service — Server-side GitHub integration for REVAMP.
 *
 * Ported from legacy-bridge/src/lib/githubSync.ts with improvements:
 * - Server-side execution (tokens never leave the API)
 * - Structured error types
 * - Better logging
 */

// --- Types ---

export interface ParsedGitHubRepo {
  owner: string;
  repo: string;
  host: string;
  apiBase: string;
}

export interface GitHubAuthIdentity {
  login: string;
  name?: string;
}

export interface GitHubFile {
  path: string;
  content: string;
}

export interface PullInput {
  repoUrl: string;
  token: string;
  branch?: string;
  maxFiles?: number;
}

export interface PullResult {
  owner: string;
  repo: string;
  branch: string;
  files: GitHubFile[];
  skipped: number;
  summary: string;
}

export interface PushInput {
  repoUrl: string;
  token: string;
  files: GitHubFile[];
  branch?: string;
  commitMessage: string;
}

export interface PushResult {
  owner: string;
  repo: string;
  branch: string;
  commitHash: string;
  changedFiles: number;
  deletedFiles: number;
  summary: string;
}

interface GitHubRepoResponse { default_branch?: string }
interface GitHubTreeEntry { path?: string; type?: string; sha?: string }
interface GitHubTreeResponse { tree?: GitHubTreeEntry[] }
interface GitHubRefResponse { object?: { sha?: string } }
interface GitHubCommitResponse { tree?: { sha?: string } }
interface GitHubContentItem { type?: string; path?: string; sha?: string; content?: string; encoding?: string }

// --- Helpers ---

function toApiBase(host: string): string {
  const normalized = host.trim().toLowerCase();
  if (!normalized || normalized === "github.com" || normalized === "api.github.com") {
    return "https://api.github.com";
  }
  return `https://${normalized}/api/v3`;
}

function normalizeBranch(branch: string): string {
  return branch.trim().replace(/^refs\/heads\//, "").replace(/^heads\//, "");
}

export function parseRepoUrl(rawUrl: string): ParsedGitHubRepo | null {
  const value = rawUrl.trim();
  if (!value) return null;

  // SSH: git@github.com:owner/repo.git
  const scpMatch = value.match(/^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/i);
  if (scpMatch) {
    return {
      owner: scpMatch[2].trim(),
      repo: scpMatch[3].trim().replace(/\.git$/i, ""),
      host: scpMatch[1].trim(),
      apiBase: toApiBase(scpMatch[1].trim()),
    };
  }

  // Short: owner/repo
  const ownerRepoMatch = value.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (ownerRepoMatch) {
    return {
      owner: ownerRepoMatch[1].trim(),
      repo: ownerRepoMatch[2].trim().replace(/\.git$/i, ""),
      host: "github.com",
      apiBase: "https://api.github.com",
    };
  }

  // HTTPS: https://github.com/owner/repo
  const hostMatch = value.match(
    /^(?:https?:\/\/)?([A-Za-z0-9.-]+\.[A-Za-z]{2,})(?:\/repos)?\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:[#/?].*)?$/i,
  );
  if (hostMatch) {
    return {
      owner: hostMatch[2].trim(),
      repo: hostMatch[3].trim().replace(/\.git$/i, ""),
      host: hostMatch[1].trim(),
      apiBase: toApiBase(hostMatch[1].trim()),
    };
  }

  // Fallback URL parse
  try {
    const asUrl = value.startsWith("http://") || value.startsWith("https://") ? value : `https://${value}`;
    const parsed = new URL(asUrl);
    const host = parsed.hostname.trim();
    const segments = parsed.pathname.split("/").filter(Boolean);

    if (host.toLowerCase() === "api.github.com" && segments[0] === "repos" && segments.length >= 3) {
      return {
        owner: segments[1].trim(),
        repo: segments[2].trim().replace(/\.git$/i, ""),
        host: "github.com",
        apiBase: "https://api.github.com",
      };
    }

    if (segments.length >= 2) {
      return {
        owner: segments[0].trim(),
        repo: segments[1].trim().replace(/\.git$/i, ""),
        host,
        apiBase: toApiBase(host),
      };
    }
  } catch {
    return null;
  }

  return null;
}

function normalizeFilePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/{2,}/g, "/").trim();
}

function encodePathSegments(path: string): string {
  return normalizeFilePath(path).split("/").filter(Boolean).map((s) => encodeURIComponent(s)).join("/");
}

function resolveAuthHeader(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) return "";
  const scheme = trimmed.split(".").length === 3 ? "Bearer" : "token";
  return `${scheme} ${trimmed}`;
}

function githubHeaders(token: string): Record<string, string> {
  const authorization = resolveAuthHeader(token);
  return {
    "Content-Type": "application/json",
    Accept: "application/vnd.github+json",
    ...(authorization ? { Authorization: authorization } : {}),
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function githubJson<T>(
  path: string,
  token: string,
  init?: RequestInit,
  apiBase = "https://api.github.com",
): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: { ...githubHeaders(token), ...(init?.headers as Record<string, string> || {}) },
  });

  const text = await response.text();
  let parsed: Record<string, unknown> | undefined;
  if (text.trim()) {
    try { parsed = JSON.parse(text); } catch { /* skip */ }
  }

  if (!response.ok) {
    if (response.status === 401) throw new Error("GitHub authentication failed (401). Check your token.");
    if (response.status === 403) {
      const reason = parsed && typeof parsed.message === "string" ? parsed.message : "Forbidden";
      throw new Error(`GitHub access denied (403): ${reason}`);
    }
    if (response.status === 404 && path.startsWith("/repos/")) {
      throw new Error("Repository not found or token lacks access.");
    }
    const apiMessage = parsed && typeof parsed.message === "string" ? parsed.message : text || "GitHub request failed.";
    throw new Error(`GitHub API ${response.status}: ${apiMessage}`);
  }

  return (parsed as T) || ({} as T);
}

async function githubFetch(
  path: string,
  token: string,
  init?: RequestInit,
  apiBase = "https://api.github.com",
): Promise<Response> {
  return fetch(`${apiBase}${path}`, {
    ...init,
    headers: { ...githubHeaders(token), ...(init?.headers as Record<string, string> || {}) },
  });
}

function decodeBase64Utf8(base64: string): string {
  const buffer = Buffer.from(base64.replace(/\n/g, ""), "base64");
  return buffer.toString("utf-8");
}

function encodeBase64Utf8(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64");
}

function isLikelyBinaryPath(path: string): boolean {
  const lower = path.toLowerCase();
  const exts = [
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".pdf",
    ".zip", ".tar", ".gz", ".7z", ".jar", ".exe", ".dll", ".so", ".bin",
    ".woff", ".woff2", ".ttf", ".eot", ".mp3", ".mp4", ".mov", ".avi",
  ];
  return exts.some((ext) => lower.endsWith(ext));
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let index = 0;
  const runWorker = async () => {
    while (true) {
      const current = index++;
      if (current >= items.length) return;
      results[current] = await worker(items[current], current);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker()));
  return results;
}

function refPath(branch: string): string {
  return `heads/${normalizeBranch(branch).split("/").filter(Boolean).map((s) => encodeURIComponent(s)).join("/")}`;
}

function isPatResourceRestriction(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error || "")).toLowerCase();
  return msg.includes("resource not accessible by personal access token") || msg.includes("github access denied (403)") || msg.includes("github api 403");
}

// --- Public API ---

/**
 * Validate a GitHub token and optionally verify repo access.
 */
export async function validateToken(token: string, repoUrl?: string): Promise<GitHubAuthIdentity> {
  const trimmed = token.trim();
  if (!trimmed) throw new Error("GitHub token is required.");

  const parsedRepo = repoUrl ? parseRepoUrl(repoUrl) : null;
  const apiBase = parsedRepo?.apiBase || "https://api.github.com";

  const identity = await githubJson<{ login?: string; name?: string }>("/user", trimmed, undefined, apiBase);
  if (!identity.login?.trim()) throw new Error("GitHub auth succeeded but no user identity returned.");

  if (parsedRepo) {
    await githubJson(`/repos/${parsedRepo.owner}/${parsedRepo.repo}`, trimmed, undefined, parsedRepo.apiBase);
  }

  return {
    login: identity.login.trim(),
    name: typeof identity.name === "string" ? identity.name.trim() || undefined : undefined,
  };
}

/**
 * Fetch the repo tree (file listing without content).
 */
export async function fetchRepoTree(
  repoUrl: string,
  token: string,
  branch?: string,
): Promise<{ branch: string; paths: string[]; truncated: boolean }> {
  const repo = parseRepoUrl(repoUrl);
  if (!repo) throw new Error("Invalid GitHub repository URL.");

  const repoMeta = await githubJson<GitHubRepoResponse>(
    `/repos/${repo.owner}/${repo.repo}`, token, undefined, repo.apiBase,
  );
  const resolved = normalizeBranch(branch?.trim() || repoMeta.default_branch || "main");

  const tree = await githubJson<GitHubTreeResponse & { truncated?: boolean }>(
    `/repos/${repo.owner}/${repo.repo}/git/trees/${encodeURIComponent(resolved)}?recursive=1`,
    token, undefined, repo.apiBase,
  );

  const paths = (tree.tree || [])
    .filter((e) => e.type === "blob" && !!e.path)
    .map((e) => normalizeFilePath(e.path!));

  return { branch: resolved, paths, truncated: !!tree.truncated };
}

/**
 * Fetch content of a single file.
 */
export async function fetchFileContent(
  repoUrl: string,
  token: string,
  filePath: string,
  branch?: string,
): Promise<string> {
  const repo = parseRepoUrl(repoUrl);
  if (!repo) throw new Error("Invalid GitHub repository URL.");

  const ref = branch ? `?ref=${encodeURIComponent(branch)}` : "";
  const response = await githubFetch(
    `/repos/${repo.owner}/${repo.repo}/contents/${encodePathSegments(filePath)}${ref}`,
    token,
    { headers: { Accept: "application/vnd.github.raw+json" } },
    repo.apiBase,
  );

  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}: Failed to read ${filePath}`);
  }

  return response.text();
}

/**
 * List branches for a repo.
 */
export async function listBranches(
  repoUrl: string,
  token: string,
): Promise<Array<{ name: string; protected: boolean }>> {
  const repo = parseRepoUrl(repoUrl);
  if (!repo) throw new Error("Invalid GitHub repository URL.");

  const branches = await githubJson<Array<{ name: string; protected?: boolean }>>(
    `/repos/${repo.owner}/${repo.repo}/branches?per_page=100`,
    token, undefined, repo.apiBase,
  );

  return branches.map((b) => ({ name: b.name, protected: !!b.protected }));
}

/**
 * Pull files from a GitHub repository.
 * Tries git-data API first, falls back to contents API.
 */
export async function pullFiles(input: PullInput): Promise<PullResult> {
  try {
    return await pullViaGitDataApi(input);
  } catch (error) {
    if (!isPatResourceRestriction(error)) throw error;
    return await pullViaContentsApi(input);
  }
}

/**
 * Push files to a GitHub repository.
 * Tries git-data API first, falls back to contents API.
 */
export async function pushFiles(input: PushInput): Promise<PushResult> {
  try {
    return await pushViaGitDataApi(input);
  } catch (error) {
    if (!isPatResourceRestriction(error)) throw error;
    return await pushViaContentsApi(input);
  }
}

// --- Internal Pull Implementations ---

async function pullViaGitDataApi(input: PullInput): Promise<PullResult> {
  const token = input.token.trim();
  const repo = parseRepoUrl(input.repoUrl);
  if (!repo) throw new Error("Invalid GitHub repository URL.");

  const repoMeta = await githubJson<GitHubRepoResponse>(
    `/repos/${repo.owner}/${repo.repo}`, token, undefined, repo.apiBase,
  );
  const branch = normalizeBranch(input.branch?.trim() || repoMeta.default_branch || "main");

  const tree = await githubJson<GitHubTreeResponse>(
    `/repos/${repo.owner}/${repo.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    token, undefined, repo.apiBase,
  );

  const blobs = (tree.tree || []).filter((e) => e.type === "blob" && !!e.path && !!e.sha);
  if (blobs.length === 0) throw new Error(`No files found in ${repo.owner}/${repo.repo}@${branch}.`);

  const maxFiles = Math.max(1, input.maxFiles || 500);
  const candidates = blobs.filter((e) => !isLikelyBinaryPath(e.path!)).slice(0, maxFiles);
  const skippedFromLimit = Math.max(0, blobs.length - candidates.length);

  const pulled = await mapWithConcurrency(candidates, 8, async (entry) => {
    const blob = await githubJson<{ content?: string; encoding?: string }>(
      `/repos/${repo.owner}/${repo.repo}/git/blobs/${entry.sha}`, token, undefined, repo.apiBase,
    );
    if (blob.encoding !== "base64" || typeof blob.content !== "string") return null;
    const decoded = decodeBase64Utf8(blob.content);
    if (decoded.includes("\u0000")) return null;
    return { path: normalizeFilePath(entry.path!), content: decoded };
  });

  const files = pulled.filter((e): e is GitHubFile => !!e);
  const skipped = skippedFromLimit + (candidates.length - files.length);

  return {
    owner: repo.owner, repo: repo.repo, branch, files, skipped,
    summary: `Pulled ${files.length} file(s) from ${repo.owner}/${repo.repo}@${branch}${skipped > 0 ? ` (skipped ${skipped})` : ""} via git-tree API.`,
  };
}

async function pullViaContentsApi(input: PullInput): Promise<PullResult> {
  const token = input.token.trim();
  const repo = parseRepoUrl(input.repoUrl);
  if (!repo) throw new Error("Invalid GitHub repository URL.");

  const repoMeta = await githubJson<GitHubRepoResponse>(
    `/repos/${repo.owner}/${repo.repo}`, token, undefined, repo.apiBase,
  );
  const branch = normalizeBranch(input.branch?.trim() || repoMeta.default_branch || "main");
  const maxFiles = Math.max(1, input.maxFiles || 500);

  // Recursive directory traversal via contents API
  const queue: string[] = [""];
  const filePaths: string[] = [];
  let discovered = 0;

  while (queue.length > 0 && filePaths.length < maxFiles) {
    const currentPath = queue.shift() || "";
    const suffix = currentPath ? `/${encodePathSegments(currentPath)}` : "";
    const entries = await githubJson<GitHubContentItem[]>(
      `/repos/${repo.owner}/${repo.repo}/contents${suffix}?ref=${encodeURIComponent(branch)}`,
      token, undefined, repo.apiBase,
    );
    for (const entry of (Array.isArray(entries) ? entries : [entries])) {
      if (!entry.path || !entry.type) continue;
      discovered++;
      if (entry.type === "dir") { queue.push(entry.path); continue; }
      if (entry.type === "file") filePaths.push(normalizeFilePath(entry.path));
      if (filePaths.length >= maxFiles) break;
    }
  }

  const candidates = filePaths.filter((p) => !isLikelyBinaryPath(p));
  const pulled = await mapWithConcurrency(candidates, 8, async (path) => {
    const response = await githubFetch(
      `/repos/${repo.owner}/${repo.repo}/contents/${encodePathSegments(path)}?ref=${encodeURIComponent(branch)}`,
      token, { headers: { Accept: "application/vnd.github.raw+json" } }, repo.apiBase,
    );
    if (!response.ok) return null;
    const content = await response.text();
    if (content.includes("\u0000")) return null;
    return { path, content };
  });

  const files = pulled.filter((e): e is GitHubFile => !!e);
  const skipped = discovered - files.length;

  return {
    owner: repo.owner, repo: repo.repo, branch, files, skipped,
    summary: `Pulled ${files.length} file(s) from ${repo.owner}/${repo.repo}@${branch}${skipped > 0 ? ` (skipped ${skipped})` : ""} via contents API.`,
  };
}

// --- Internal Push Implementations ---

async function pushViaGitDataApi(input: PushInput): Promise<PushResult> {
  const token = input.token.trim();
  const repo = parseRepoUrl(input.repoUrl);
  if (!repo) throw new Error("Invalid GitHub repository URL.");
  if (!input.commitMessage.trim()) throw new Error("Commit message is required.");

  const repoMeta = await githubJson<GitHubRepoResponse>(
    `/repos/${repo.owner}/${repo.repo}`, token, undefined, repo.apiBase,
  );
  const defaultBranch = normalizeBranch(repoMeta.default_branch || "main");
  const branch = normalizeBranch(input.branch?.trim() || defaultBranch);

  // Resolve branch head
  const refResponse = await githubFetch(
    `/repos/${repo.owner}/${repo.repo}/git/ref/${refPath(branch)}`, token, undefined, repo.apiBase,
  );

  let headSha = "";
  if (refResponse.ok) {
    const parsed = (await refResponse.json()) as GitHubRefResponse;
    headSha = parsed.object?.sha || "";
  } else if (refResponse.status === 404) {
    // Create branch from default
    const defaultRef = await githubJson<GitHubRefResponse>(
      `/repos/${repo.owner}/${repo.repo}/git/ref/${refPath(defaultBranch)}`, token, undefined, repo.apiBase,
    );
    const baseSha = defaultRef.object?.sha || "";
    if (!baseSha) throw new Error("Unable to resolve default branch head.");
    const created = await githubJson<GitHubRefResponse>(
      `/repos/${repo.owner}/${repo.repo}/git/refs`, token,
      { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }) },
      repo.apiBase,
    );
    headSha = created.object?.sha || "";
  } else {
    throw new Error(`GitHub API ${refResponse.status}: Unable to resolve branch.`);
  }

  if (!headSha) throw new Error(`Unable to resolve branch head for ${branch}.`);

  // Get base tree
  const commit = await githubJson<GitHubCommitResponse>(
    `/repos/${repo.owner}/${repo.repo}/git/commits/${headSha}`, token, undefined, repo.apiBase,
  );
  const baseTreeSha = commit.tree?.sha || "";
  if (!baseTreeSha) throw new Error("Unable to resolve base tree.");

  // Get existing tree for diffing
  const existingTree = await githubJson<GitHubTreeResponse>(
    `/repos/${repo.owner}/${repo.repo}/git/trees/${baseTreeSha}?recursive=1`, token, undefined, repo.apiBase,
  );
  const existingMap = new Map<string, string>();
  (existingTree.tree || []).forEach((e) => {
    if (e.type === "blob" && e.path && e.sha) existingMap.set(normalizeFilePath(e.path), e.sha);
  });

  // Deduplicate input files
  const deduped = new Map<string, string>();
  for (const file of input.files) {
    if (file.path && file.content != null) deduped.set(normalizeFilePath(file.path), file.content);
  }
  const localFiles = [...deduped.entries()].map(([path, content]) => ({ path, content }));
  if (localFiles.length === 0) throw new Error("No files to push.");

  // Create blobs
  const blobs = await mapWithConcurrency(localFiles, 8, async (file) => {
    const blob = await githubJson<{ sha?: string }>(
      `/repos/${repo.owner}/${repo.repo}/git/blobs`, token,
      { method: "POST", body: JSON.stringify({ content: file.content, encoding: "utf-8" }) },
      repo.apiBase,
    );
    if (!blob.sha) throw new Error(`Failed to create blob for ${file.path}.`);
    return { path: file.path, sha: blob.sha };
  });

  // Diff
  const localPaths = new Set(blobs.map((b) => b.path));
  const changedEntries = blobs
    .filter((b) => existingMap.get(b.path) !== b.sha)
    .map((b) => ({ path: b.path, mode: "100644" as const, type: "blob" as const, sha: b.sha }));

  if (changedEntries.length === 0) {
    return {
      owner: repo.owner, repo: repo.repo, branch, commitHash: headSha,
      changedFiles: 0, deletedFiles: 0,
      summary: `No changes detected for ${repo.owner}/${repo.repo}@${branch}.`,
    };
  }

  // Create tree + commit
  const nextTree = await githubJson<{ sha?: string }>(
    `/repos/${repo.owner}/${repo.repo}/git/trees`, token,
    { method: "POST", body: JSON.stringify({ base_tree: baseTreeSha, tree: changedEntries }) },
    repo.apiBase,
  );
  if (!nextTree.sha) throw new Error("Failed to create git tree.");

  const createdCommit = await githubJson<{ sha?: string }>(
    `/repos/${repo.owner}/${repo.repo}/git/commits`, token,
    { method: "POST", body: JSON.stringify({ message: input.commitMessage.trim(), tree: nextTree.sha, parents: [headSha] }) },
    repo.apiBase,
  );
  if (!createdCommit.sha) throw new Error("Failed to create git commit.");

  // Update ref
  await githubJson(
    `/repos/${repo.owner}/${repo.repo}/git/refs/${refPath(branch)}`, token,
    { method: "PATCH", body: JSON.stringify({ sha: createdCommit.sha, force: false }) },
    repo.apiBase,
  );

  return {
    owner: repo.owner, repo: repo.repo, branch, commitHash: createdCommit.sha,
    changedFiles: changedEntries.length, deletedFiles: 0,
    summary: `Pushed ${changedEntries.length} file(s) to ${repo.owner}/${repo.repo}@${branch} (${createdCommit.sha.slice(0, 7)}).`,
  };
}

async function pushViaContentsApi(input: PushInput): Promise<PushResult> {
  const token = input.token.trim();
  const repo = parseRepoUrl(input.repoUrl);
  if (!repo) throw new Error("Invalid GitHub repository URL.");
  if (!input.commitMessage.trim()) throw new Error("Commit message is required.");

  const repoMeta = await githubJson<GitHubRepoResponse>(
    `/repos/${repo.owner}/${repo.repo}`, token, undefined, repo.apiBase,
  );
  const branch = normalizeBranch(input.branch?.trim() || repoMeta.default_branch || "main");

  const deduped = new Map<string, string>();
  for (const file of input.files) {
    if (file.path && file.content != null) deduped.set(normalizeFilePath(file.path), file.content);
  }
  const localFiles = [...deduped.entries()].map(([path, content]) => ({ path, content }));
  if (localFiles.length === 0) throw new Error("No files to push.");

  let changedFiles = 0;
  let lastCommitSha = "";

  for (const file of localFiles) {
    const filePath = `/repos/${repo.owner}/${repo.repo}/contents/${encodePathSegments(file.path)}`;
    const readResponse = await githubFetch(
      `${filePath}?ref=${encodeURIComponent(branch)}`, token, undefined, repo.apiBase,
    );

    let existingSha: string | undefined;
    let remoteContent: string | undefined;

    if (readResponse.ok) {
      const existing = (await readResponse.json()) as GitHubContentItem;
      existingSha = existing.sha;
      if (existing.encoding === "base64" && typeof existing.content === "string") {
        remoteContent = decodeBase64Utf8(existing.content);
      }
    }

    if (remoteContent !== undefined && remoteContent === file.content) continue;

    const payload: Record<string, unknown> = {
      message: input.commitMessage.trim(),
      content: encodeBase64Utf8(file.content),
      branch,
    };
    if (existingSha) payload.sha = existingSha;

    const result = await githubJson<{ commit?: { sha?: string } }>(
      filePath, token, { method: "PUT", body: JSON.stringify(payload) }, repo.apiBase,
    );
    if (result.commit?.sha) lastCommitSha = result.commit.sha;
    changedFiles++;
  }

  return {
    owner: repo.owner, repo: repo.repo, branch, commitHash: lastCommitSha,
    changedFiles, deletedFiles: 0,
    summary: changedFiles > 0
      ? `Pushed ${changedFiles} file(s) to ${repo.owner}/${repo.repo}@${branch} via contents API${lastCommitSha ? ` (${lastCommitSha.slice(0, 7)})` : ""}.`
      : `No changes detected for ${repo.owner}/${repo.repo}@${branch}.`,
  };
}
