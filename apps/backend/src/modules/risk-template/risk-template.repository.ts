import type { Prisma, PrismaClient, RiskTemplate } from "@prisma/client";

export class RiskTemplateRepository {
  constructor(private readonly prisma: PrismaClient) {}

  findMany(): Promise<RiskTemplate[]> {
    return this.prisma.riskTemplate.findMany({ orderBy: { createdAt: "asc" } });
  }

  findById(id: string): Promise<RiskTemplate | null> {
    return this.prisma.riskTemplate.findUnique({ where: { id } });
  }

  findActive(): Promise<RiskTemplate | null> {
    return this.prisma.riskTemplate.findFirst({ where: { isActive: true } });
  }

  count(): Promise<number> {
    return this.prisma.riskTemplate.count();
  }

  create(data: Prisma.RiskTemplateCreateInput): Promise<RiskTemplate> {
    return this.prisma.riskTemplate.create({ data });
  }

  update(id: string, data: Prisma.RiskTemplateUpdateInput): Promise<RiskTemplate> {
    return this.prisma.riskTemplate.update({ where: { id }, data });
  }

  /**
   * Atomically makes `id` the only active template: deactivating the current
   * one and activating the target run in a single transaction, so a failure
   * can never leave zero or two active templates.
   */
  async activate(id: string): Promise<RiskTemplate> {
    const [, activated] = await this.prisma.$transaction([
      this.prisma.riskTemplate.updateMany({
        where: { isActive: true, id: { not: id } },
        data: { isActive: false },
      }),
      this.prisma.riskTemplate.update({ where: { id }, data: { isActive: true } }),
    ]);
    return activated;
  }

  async delete(id: string): Promise<void> {
    await this.prisma.riskTemplate.delete({ where: { id } });
  }
}
