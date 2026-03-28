/**
 * GitHub Routes — API endpoints for GitHub integration.
 *
 * Endpoints:
 *   POST   /github/validate-token  → Validate GitHub token
 *   GET    /github/tree            → Fetch repository file tree
 *   GET    /github/file            → Fetch single file content
 *   GET    /github/branches        → List repository branches
 *   POST   /github/push            → Push files to repository
 */

import { FastifyInstance } from "fastify";
import { z } from "zod";
import * as github from "@/services/github.js";

// ─── SCHEMAS ────────────────────────────────────────────────────

const ValidateTokenSchema = z.object({
  token: z.string().min(1),
  repo_url: z.string().optional(),
});

const TreeQuerySchema = z.object({
  repo_url: z.string().min(1),
  token: z.string().min(1),
  branch: z.string().optional(),
});

const FileQuerySchema = z.object({
  repo_url: z.string().min(1),
  token: z.string().min(1),
  file_path: z.string().min(1),
  branch: z.string().optional(),
});

const BranchesQuerySchema = z.object({
  repo_url: z.string().min(1),
  token: z.string().min(1),
});

const PushSchema = z.object({
  repo_url: z.string().min(1),
  token: z.string().min(1),
  branch: z.string().optional(),
  commit_message: z.string().min(1),
  files: z.array(
    z.object({
      path: z.string().min(1),
      content: z.string(),
    }),
  ),
});

// ─── ROUTES ─────────────────────────────────────────────────────

export async function githubRoutes(fastify: FastifyInstance) {
  /**
   * POST /github/validate-token — Validate a GitHub token
   */
  fastify.post<{ Body: z.infer<typeof ValidateTokenSchema> }>(
    "/github/validate-token",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const validation = ValidateTokenSchema.safeParse(request.body);
      if (!validation.success) {
        return reply.status(400).send({ error: "Invalid input", details: validation.error.issues });
      }

      try {
        const identity = await github.validateToken(
          validation.data.token,
          validation.data.repo_url,
        );
        return reply.send({
          valid: true,
          login: identity.login,
          name: identity.name,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Token validation failed";
        return reply.status(401).send({ valid: false, error: message });
      }
    },
  );

  /**
   * GET /github/tree — Fetch repository file tree
   */
  fastify.get<{ Querystring: z.infer<typeof TreeQuerySchema> }>(
    "/github/tree",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const validation = TreeQuerySchema.safeParse(request.query);
      if (!validation.success) {
        return reply.status(400).send({ error: "Invalid input", details: validation.error.issues });
      }

      try {
        const { repo_url, token, branch } = validation.data;
        const parsed = github.parseRepoUrl(repo_url);
        const result = await github.fetchRepoTree(repo_url, token, branch);

        return reply.send({
          owner: parsed?.owner,
          repo: parsed?.repo,
          branch: result.branch,
          files: result.paths,
          file_count: result.paths.length,
          truncated: result.truncated,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to fetch repository tree";
        return reply.status(400).send({ error: message });
      }
    },
  );

  /**
   * GET /github/file — Fetch single file content
   */
  fastify.get<{ Querystring: z.infer<typeof FileQuerySchema> }>(
    "/github/file",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const validation = FileQuerySchema.safeParse(request.query);
      if (!validation.success) {
        return reply.status(400).send({ error: "Invalid input", details: validation.error.issues });
      }

      try {
        const { repo_url, token, file_path, branch } = validation.data;
        const content = await github.fetchFileContent(repo_url, token, file_path, branch);

        return reply.send({
          path: file_path,
          content,
          size: content.length,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to fetch file";
        return reply.status(400).send({ error: message });
      }
    },
  );

  /**
   * GET /github/branches — List repository branches
   */
  fastify.get<{ Querystring: z.infer<typeof BranchesQuerySchema> }>(
    "/github/branches",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const validation = BranchesQuerySchema.safeParse(request.query);
      if (!validation.success) {
        return reply.status(400).send({ error: "Invalid input", details: validation.error.issues });
      }

      try {
        const { repo_url, token } = validation.data;
        const branches = await github.listBranches(repo_url, token);

        return reply.send({ branches });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to list branches";
        return reply.status(400).send({ error: message });
      }
    },
  );

  /**
   * POST /github/push — Push files to a repository
   */
  fastify.post<{ Body: z.infer<typeof PushSchema> }>(
    "/github/push",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const validation = PushSchema.safeParse(request.body);
      if (!validation.success) {
        return reply.status(400).send({ error: "Invalid input", details: validation.error.issues });
      }

      try {
        const { repo_url, token, branch, commit_message, files } = validation.data;
        const result = await github.pushFiles({
          repoUrl: repo_url,
          token,
          files,
          branch,
          commitMessage: commit_message,
        });

        return reply.status(201).send({
          owner: result.owner,
          repo: result.repo,
          branch: result.branch,
          commit_hash: result.commitHash,
          changed_files: result.changedFiles,
          deleted_files: result.deletedFiles,
          summary: result.summary,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Push failed";
        return reply.status(400).send({ error: message });
      }
    },
  );
}
