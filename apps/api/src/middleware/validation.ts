import { FastifyRequest, FastifyReply } from "fastify";
import { ZodSchema } from "zod";

export function createValidationMiddleware<T extends ZodSchema>(schema: T) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await schema.parseAsync(request.body);
    } catch (error: any) {
      reply.status(400).send({
        error: "Validation failed",
        details: error.errors || error.message,
      });
    }
  };
}

export async function validateRequest<T extends ZodSchema>(
  schema: T,
  data: unknown
): Promise<{ valid: boolean; data?: any; error?: string }> {
  try {
    const parsed = await schema.parseAsync(data);
    return { valid: true, data: parsed };
  } catch (error: any) {
    return {
      valid: false,
      error: error.errors?.[0]?.message || error.message,
    };
  }
}
