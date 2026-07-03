import type { PrismaClient, AlertStatus } from "@prisma/client";
import { AlertsRepository } from "./alerts.repository";
import { NotFoundError } from "../../utils/errors";
import type {
  AiVisionUpdateInput,
  AlertListFilter,
  CreateAlertInput,
  DuplicateLookupInput,
} from "./alerts.types";

export class AlertsService {
  private readonly repository: AlertsRepository;

  constructor(prisma: PrismaClient) {
    this.repository = new AlertsRepository(prisma);
  }

  async list(filter: AlertListFilter) {
    const [items, total] = await Promise.all([
      this.repository.findMany(filter),
      this.repository.count(filter),
    ]);
    return { items, total };
  }

  async getByIdOrThrow(id: string) {
    const alert = await this.repository.findById(id);
    if (!alert) throw new NotFoundError(`Alert ${id} not found`);
    return alert;
  }

  create(input: CreateAlertInput) {
    return this.repository.create(input);
  }

  findRecentDuplicate(input: DuplicateLookupInput) {
    return this.repository.findRecentDuplicate(input);
  }

  registerDuplicate(id: string) {
    return this.repository.incrementDuplicate(id);
  }

  async setStatus(id: string, status: AlertStatus, errorMessage?: string) {
    await this.getByIdOrThrow(id);
    return this.repository.update(id, { status, errorMessage: errorMessage ?? null });
  }

  async delete(id: string) {
    await this.getByIdOrThrow(id);
    await this.repository.delete(id);
  }

  markProcessingScreenshot(id: string) {
    return this.repository.update(id, { status: "PROCESSING_SCREENSHOT" });
  }

  markScreenshotSaved(id: string, screenshotUrl: string) {
    return this.repository.update(id, { screenshotUrl });
  }

  markAnalyzingWithAi(id: string) {
    return this.repository.update(id, { status: "ANALYZING_WITH_AI" });
  }

  markAnalyzed(id: string, result: AiVisionUpdateInput) {
    return this.repository.update(id, {
      status: "ANALYZED",
      aiBias: result.aiBias,
      aiConfidence: result.aiConfidence,
      aiPattern: result.aiPattern,
      aiSummary: result.aiSummary,
      aiRiskNotes: result.aiRiskNotes,
      aiProvider: result.aiProvider,
    });
  }

  markFailed(id: string, errorMessage: string) {
    return this.repository.update(id, { status: "FAILED", errorMessage });
  }
}
