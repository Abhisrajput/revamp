import { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@/db/index.js";
import { projects, projectMembers } from "@/db/schema.js";
import { eq, and } from "drizzle-orm";
import { storageService } from "@/services/storage.js";

const GenerateUploadUrlSchema = z.object({
  project_id: z.string().uuid(),
  filename: z.string().min(1).max(255),
  content_type: z.string().optional(),
});

const GenerateDownloadUrlSchema = z.object({
  storage_key: z.string().min(1).max(1024),
});

/**
 * Verify the caller has access to the project that owns a storage key.
 * Storage keys are formatted as `projects/{projectId}/...`.
 * Returns the project_id or null if the key format is unrecognized.
 */
function extractProjectIdFromKey(key: string): string | null {
  const match = key.match(/^projects\/([0-9a-f-]{36})\//);
  return match ? match[1] : null;
}

export async function storageRoutes(fastify: FastifyInstance) {
  // Generate upload presigned URL — requires project membership
  fastify.post<{ Body: z.infer<typeof GenerateUploadUrlSchema> }>(
    "/storage/upload-url",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const validation = GenerateUploadUrlSchema.safeParse(request.body);
      if (!validation.success) {
        return reply.status(400).send({ error: "Invalid input" });
      }

      const { project_id, filename } = validation.data;

      // Verify project access
      if (request.user.role !== "admin") {
        const project = await db.query.projects.findFirst({
          where: eq(projects.id, project_id),
          columns: { organization_id: true, visibility: true },
        });
        if (!project) {
          return reply.status(404).send({ error: "Project not found" });
        }

        const isSameOrg = project.organization_id === request.user.organization_id;
        if (!isSameOrg || project.visibility === "private") {
          const membership = await db.query.projectMembers.findFirst({
            where: and(
              eq(projectMembers.project_id, project_id),
              eq(projectMembers.user_id, request.user.sub),
            ),
          });
          if (!membership) {
            return reply.status(403).send({ error: "Access denied" });
          }
        }
      }

      // Sanitize filename — strip path traversal characters
      const safeName = filename.replace(/[\/\\\.\.]+/g, "_").replace(/^_+/, "");
      if (!safeName) {
        return reply.status(400).send({ error: "Invalid filename" });
      }

      try {
        const { uploadUrl, key } = await storageService.generateUploadUrl(
          project_id,
          safeName,
          3600 // 1 hour expiry
        );

        return reply.send({
          upload_url: uploadUrl,
          storage_key: key,
          expires_in: 3600,
        });
      } catch (error) {
        console.error("Upload URL generation error:", error);
        return reply.status(500).send({ error: "Failed to generate upload URL" });
      }
    }
  );

  // Generate download presigned URL — requires access to the key's project
  fastify.post<{ Body: z.infer<typeof GenerateDownloadUrlSchema> }>(
    "/storage/download-url",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const validation = GenerateDownloadUrlSchema.safeParse(request.body);
      if (!validation.success) {
        return reply.status(400).send({ error: "Invalid input" });
      }

      const { storage_key } = validation.data;

      // Verify the caller has access to the owning project
      if (request.user.role !== "admin") {
        const projectId = extractProjectIdFromKey(storage_key);
        if (projectId) {
          const membership = await db.query.projectMembers.findFirst({
            where: and(
              eq(projectMembers.project_id, projectId),
              eq(projectMembers.user_id, request.user.sub),
            ),
          });
          if (!membership) {
            // Also check org match
            const project = await db.query.projects.findFirst({
              where: eq(projects.id, projectId),
              columns: { organization_id: true },
            });
            if (!project || project.organization_id !== request.user.organization_id) {
              return reply.status(403).send({ error: "Access denied" });
            }
          }
        }
      }

      try {
        const downloadUrl = await storageService.generateDownloadUrl(
          storage_key,
          3600 // 1 hour expiry
        );

        return reply.send({
          download_url: downloadUrl,
          expires_in: 3600,
        });
      } catch (error) {
        console.error("Download URL generation error:", error);
        return reply.status(500).send({ error: "Failed to generate download URL" });
      }
    }
  );

  // Delete object — requires project membership
  fastify.delete<{ Params: { key: string } }>(
    "/storage/:key",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const { key } = request.params;

      // Decode once — Fastify already decodes route params once, so a single
      // additional decodeURIComponent handles %2F-style encoding without
      // enabling double-encoding attacks.
      let decodedKey: string;
      try {
        decodedKey = decodeURIComponent(key);
      } catch {
        return reply.status(400).send({ error: "Invalid storage key" });
      }

      // Reject any path traversal sequences and absolute paths
      if (
        decodedKey.includes("..") ||
        decodedKey.startsWith("/") ||
        decodedKey.includes("%2e") ||
        decodedKey.includes("%2f") ||
        decodedKey.includes("\0")
      ) {
        return reply.status(400).send({ error: "Invalid storage key" });
      }

      // Key must start with projects/{uuid}/ — reject anything else
      if (!extractProjectIdFromKey(decodedKey)) {
        return reply.status(400).send({ error: "Invalid storage key format" });
      }

      // Verify the caller has access to the owning project
      if (request.user.role !== "admin") {
        const projectId = extractProjectIdFromKey(decodedKey);
        if (projectId) {
          const membership = await db.query.projectMembers.findFirst({
            where: and(
              eq(projectMembers.project_id, projectId),
              eq(projectMembers.user_id, request.user.sub),
            ),
          });
          if (!membership) {
            return reply.status(403).send({ error: "Access denied" });
          }
        }
      }

      try {
        await storageService.deleteObject(decodedKey);
        return reply.send({ message: "Object deleted" });
      } catch (error) {
        console.error("Delete error:", error);
        return reply.status(500).send({ error: "Failed to delete object" });
      }
    }
  );
}
