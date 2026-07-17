import type { PrismaClient, AlertStatus } from "@prisma/client";
import type { AlertStats } from "@trading-alert-dashboard/shared";
import { AlertsRepository } from "./alerts.repository";
import { NotFoundError } from "../../utils/errors";
import type {
  AiVisionUpdateInput,
  AlertListFilter,
  AlertStatsRange,
  CreateAlertInput,
  DuplicateLookupInput,
} from "./alerts.types";

/** Pipeline states where the alert is still being worked on by the worker. */
export const PROCESSING_ALERT_STATUSES: AlertStatus[] = [
  "RECEIVED",
  "PROCESSING_SCREENSHOT",
  "ANALYZING_WITH_AI",
];

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

  /**
   * Dashboard stat cards for a time range (the client's "today").
   *
   * Counted by the database across every matching alert, so the numbers are
   * unaffected by the list's page size or filters — loading one 100-alert page
   * can never make the cards undercount. `total` is the sum of the status
   * groups, which is every alert in the range whatever its status.
   */
  async statsForRange(range: AlertStatsRange): Promise<AlertStats> {
    const [statusGroups, signalGroups] = await Promise.all([
      this.repository.groupByStatus(range),
      this.repository.groupBySignal(range),
    ]);

    const statusCount = (status: AlertStatus): number =>
      statusGroups.find((group) => group.status === status)?._count._all ?? 0;

    return {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      total: statusGroups.reduce((sum, group) => sum + group._count._all, 0),
      long: signalGroups.find((group) => group.signal === "LONG")?._count._all ?? 0,
      short: signalGroups.find((group) => group.signal === "SHORT")?._count._all ?? 0,
      processing: PROCESSING_ALERT_STATUSES.reduce((sum, status) => sum + statusCount(status), 0),
      analyzed: statusCount("ANALYZED"),
      failed: statusCount("FAILED"),
    };
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
