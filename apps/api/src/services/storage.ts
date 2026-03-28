import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";

export class StorageService {
  private s3Client: S3Client;
  private bucket: string;

  constructor() {
    this.s3Client = new S3Client({
      region: process.env.S3_REGION || "us-east-1",
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID || "",
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "",
      },
      endpoint: process.env.S3_ENDPOINT,
      forcePathStyle: process.env.S3_ENDPOINT ? true : false, // Required for MinIO
    });

    this.bucket = process.env.S3_BUCKET || "revamp-artifacts";
  }

  async generateUploadUrl(
    projectId: string,
    filename: string,
    expiresIn: number = 3600
  ): Promise<{ uploadUrl: string; key: string }> {
    const key = `projects/${projectId}/uploads/${randomUUID()}/${filename}`;

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: this.getContentType(filename),
    });

    const uploadUrl = await getSignedUrl(this.s3Client, command, {
      expiresIn,
    });

    return { uploadUrl, key };
  }

  async generateDownloadUrl(
    key: string,
    expiresIn: number = 3600
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    return getSignedUrl(this.s3Client, command, { expiresIn });
  }

  async deleteObject(key: string): Promise<void> {
    // Implementation for delete
    console.log(`Delete object: ${key}`);
  }

  private getContentType(filename: string): string {
    const ext = filename.split(".").pop()?.toLowerCase();
    const contentTypes: Record<string, string> = {
      json: "application/json",
      pdf: "application/pdf",
      zip: "application/zip",
      txt: "text/plain",
      csv: "text/csv",
      html: "text/html",
      xml: "application/xml",
      yaml: "application/yaml",
    };
    return contentTypes[ext || ""] || "application/octet-stream";
  }
}

export const storageService = new StorageService();
