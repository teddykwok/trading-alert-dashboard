import type { FastifyInstance } from "fastify";
import { RiskTemplateService } from "../modules/risk-template/risk-template.service";
import {
  riskTemplateCreateSchema,
  riskTemplateUpdateSchema,
} from "../modules/risk-template/risk-template.schema";
import { ValidationError } from "../utils/errors";

export async function riskTemplatesRoutes(app: FastifyInstance): Promise<void> {
  const service = new RiskTemplateService(app.prisma);

  app.get("/api/risk-templates", async () => {
    return service.list();
  });

  // Returns the active template, or null when none is active — never a 500.
  app.get("/api/risk-templates/active", async () => {
    return service.getActive();
  });

  app.post("/api/risk-templates", async (request, reply) => {
    const parsed = riskTemplateCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid risk template payload", parsed.error.flatten());
    }
    return reply.code(201).send(await service.create(parsed.data));
  });

  app.patch<{ Params: { id: string } }>("/api/risk-templates/:id", async (request) => {
    const parsed = riskTemplateUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid risk template update", parsed.error.flatten());
    }
    return service.update(request.params.id, parsed.data);
  });

  app.post<{ Params: { id: string } }>("/api/risk-templates/:id/activate", async (request) => {
    return service.activate(request.params.id);
  });

  app.delete<{ Params: { id: string } }>("/api/risk-templates/:id", async (request, reply) => {
    await service.remove(request.params.id);
    return reply.code(204).send();
  });
}
