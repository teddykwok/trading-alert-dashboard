import type { PrismaClient, RiskTemplate as RiskTemplateRow } from "@prisma/client";
import {
  calculateRiskTemplateAmounts,
  type RiskTemplate as RiskTemplateDto,
} from "@trading-alert-dashboard/shared";
import { RiskTemplateRepository } from "./risk-template.repository";
import { NotFoundError, ValidationError } from "../../utils/errors";
import type { RiskTemplateCreateInput, RiskTemplateUpdateInput } from "./risk-template.schema";

/**
 * Serializes a stored template for the API: Decimal fields become exact
 * strings and riskAmount/targetAmount are recomputed from the STORED fields
 * on every read (never persisted, never taken from a client). referenceCapital
 * is the user's manually chosen planning value — this service must never read
 * an exchange balance, PnL, alert, or outcome to derive anything.
 */
export function serializeRiskTemplate(template: RiskTemplateRow): RiskTemplateDto {
  const referenceCapital = String(template.referenceCapital);
  const riskPercent = String(template.riskPercent);
  const rewardRatio = String(template.rewardRatio);
  const amounts = calculateRiskTemplateAmounts(referenceCapital, riskPercent, rewardRatio);

  return {
    id: template.id,
    name: template.name,
    referenceCapital,
    riskPercent,
    rewardRatio,
    isActive: template.isActive,
    createdAt: template.createdAt.toISOString(),
    updatedAt: template.updatedAt.toISOString(),
    ...amounts,
  };
}

export class RiskTemplateService {
  private readonly repository: RiskTemplateRepository;

  constructor(prisma: PrismaClient) {
    this.repository = new RiskTemplateRepository(prisma);
  }

  private async getOrThrow(id: string): Promise<RiskTemplateRow> {
    const template = await this.repository.findById(id);
    if (!template) throw new NotFoundError(`Risk template ${id} not found`);
    return template;
  }

  async list(): Promise<RiskTemplateDto[]> {
    const templates = await this.repository.findMany();
    return templates.map(serializeRiskTemplate);
  }

  /** Clean null when no template is active — never a server error. */
  async getActive(): Promise<RiskTemplateDto | null> {
    const active = await this.repository.findActive();
    return active ? serializeRiskTemplate(active) : null;
  }

  /**
   * The very first template is activated automatically (there is nothing else
   * it could compete with); later templates are created inactive and must be
   * activated explicitly.
   */
  async create(input: RiskTemplateCreateInput): Promise<RiskTemplateDto> {
    const existingCount = await this.repository.count();
    const created = await this.repository.create({
      name: input.name,
      referenceCapital: input.referenceCapital,
      riskPercent: input.riskPercent,
      rewardRatio: input.rewardRatio,
      isActive: existingCount === 0,
    });
    return serializeRiskTemplate(created);
  }

  async update(id: string, input: RiskTemplateUpdateInput): Promise<RiskTemplateDto> {
    await this.getOrThrow(id);

    const changes: Parameters<RiskTemplateRepository["update"]>[1] = {};
    if (input.name !== undefined) changes.name = input.name;
    if (input.referenceCapital !== undefined) changes.referenceCapital = input.referenceCapital;
    if (input.riskPercent !== undefined) changes.riskPercent = input.riskPercent;
    if (input.rewardRatio !== undefined) changes.rewardRatio = input.rewardRatio;

    const updated = await this.repository.update(id, changes);
    return serializeRiskTemplate(updated);
  }

  async activate(id: string): Promise<RiskTemplateDto> {
    await this.getOrThrow(id);
    const activated = await this.repository.activate(id);
    return serializeRiskTemplate(activated);
  }

  /** Only unused (non-active) templates may be deleted. */
  async remove(id: string): Promise<void> {
    const template = await this.getOrThrow(id);
    if (template.isActive) {
      throw new ValidationError(
        "Cannot delete the active template — activate another template first."
      );
    }
    await this.repository.delete(id);
  }
}
