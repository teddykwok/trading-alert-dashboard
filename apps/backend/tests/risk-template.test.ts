import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { calculateRiskTemplateAmounts } from "@trading-alert-dashboard/shared";
import { RiskTemplateService } from "../src/modules/risk-template/risk-template.service";
import {
  riskTemplateCreateSchema,
  riskTemplateUpdateSchema,
} from "../src/modules/risk-template/risk-template.schema";
import { NotFoundError, ValidationError } from "../src/utils/errors";

const NOW = new Date("2026-08-01T10:00:00Z");

function templateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "tpl_1",
    name: "Current $400",
    referenceCapital: "400",
    riskPercent: "1",
    rewardRatio: "1.5",
    isActive: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

interface MockOptions {
  templates?: ReturnType<typeof templateRow>[];
  existing?: ReturnType<typeof templateRow> | null;
  count?: number;
}

function createMockPrisma(options: MockOptions = {}) {
  const riskTemplate = {
    findMany: vi.fn().mockResolvedValue(options.templates ?? []),
    findUnique: vi.fn().mockResolvedValue(options.existing ?? null),
    findFirst: vi
      .fn()
      .mockResolvedValue((options.templates ?? []).find((t) => t.isActive) ?? null),
    count: vi.fn().mockResolvedValue(options.count ?? 0),
    create: vi.fn().mockImplementation(async ({ data }) => templateRow(data)),
    update: vi
      .fn()
      .mockImplementation(async ({ where, data }) =>
        templateRow({ ...(options.existing ?? {}), id: where.id, ...data })
      ),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    delete: vi.fn().mockResolvedValue(templateRow()),
  };

  return {
    riskTemplate,
    $transaction: vi.fn().mockImplementation(async (operations: Promise<unknown>[]) =>
      Promise.all(operations)
    ),
  } as unknown as PrismaClient;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("calculateRiskTemplateAmounts", () => {
  it("calculates USD 400 at 1% as riskAmount 4", () => {
    expect(calculateRiskTemplateAmounts("400", "1", "1.5").riskAmount).toBe("4");
  });

  it("calculates riskAmount 4 at RR 1.5 as targetAmount 6", () => {
    expect(calculateRiskTemplateAmounts("400", "1", "1.5").targetAmount).toBe("6");
  });

  it("is exact for decimal inputs (no float drift)", () => {
    // 400.10 × 1.5% = 6.0015 exactly; × 2 = 12.003 exactly.
    expect(calculateRiskTemplateAmounts("400.10", "1.5", "2")).toEqual({
      riskAmount: "6.0015",
      targetAmount: "12.003",
    });
    // 333.33 × 0.75% = 2.499975; × 1.37 = 3.42496575.
    expect(calculateRiskTemplateAmounts("333.33", "0.75", "1.37")).toEqual({
      riskAmount: "2.499975",
      targetAmount: "3.42496575",
    });
  });
});

describe("risk template schemas", () => {
  it("accepts a valid create payload (strings or numbers)", () => {
    expect(
      riskTemplateCreateSchema.safeParse({
        name: "Current $400",
        referenceCapital: "400",
        riskPercent: "1",
        rewardRatio: "1.5",
      }).success
    ).toBe(true);
    expect(
      riskTemplateCreateSchema.safeParse({
        name: "Numbers",
        referenceCapital: 400,
        riskPercent: 1,
        rewardRatio: 1.5,
      }).success
    ).toBe(true);
  });

  it("rejects invalid numeric values (zero, negative, garbage, empty name)", () => {
    const valid = { name: "T", referenceCapital: "400", riskPercent: "1", rewardRatio: "1.5" };
    for (const bad of [
      { ...valid, referenceCapital: "0" },
      { ...valid, referenceCapital: "0.000" },
      { ...valid, riskPercent: 0 },
      { ...valid, riskPercent: -1 },
      { ...valid, rewardRatio: "-1.5" },
      { ...valid, rewardRatio: "1,5" },
      { ...valid, rewardRatio: "abc" },
      { ...valid, name: "   " },
    ]) {
      expect(riskTemplateCreateSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("strips client-sent riskAmount/targetAmount instead of trusting them", () => {
    const parsed = riskTemplateCreateSchema.safeParse({
      name: "T",
      referenceCapital: "400",
      riskPercent: "1",
      rewardRatio: "1.5",
      riskAmount: "9999",
      targetAmount: "9999",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).not.toHaveProperty("riskAmount");
      expect(parsed.data).not.toHaveProperty("targetAmount");
    }
  });

  it("update requires at least one field and validates the same rules", () => {
    expect(riskTemplateUpdateSchema.safeParse({}).success).toBe(false);
    expect(riskTemplateUpdateSchema.safeParse({ referenceCapital: "1000" }).success).toBe(true);
    expect(riskTemplateUpdateSchema.safeParse({ riskPercent: "0" }).success).toBe(false);
  });
});

describe("RiskTemplateService", () => {
  it("creates a valid template and returns derived amounts", async () => {
    const prisma = createMockPrisma({ count: 1 }); // not the first template
    const service = new RiskTemplateService(prisma);

    const created = await service.create({
      name: "Current $400",
      referenceCapital: "400",
      riskPercent: "1",
      rewardRatio: "1.5",
    });

    expect(created).toMatchObject({
      name: "Current $400",
      referenceCapital: "400",
      riskPercent: "1",
      rewardRatio: "1.5",
      isActive: false,
      riskAmount: "4",
      targetAmount: "6",
    });
  });

  it("auto-activates the very first template only", async () => {
    const first = new RiskTemplateService(createMockPrisma({ count: 0 }));
    const input = { name: "T", referenceCapital: "400", riskPercent: "1", rewardRatio: "1.5" };
    expect((await first.create(input)).isActive).toBe(true);

    const second = new RiskTemplateService(createMockPrisma({ count: 3 }));
    expect((await second.create(input)).isActive).toBe(false);
  });

  it("activating a template deactivates every other one, transactionally", async () => {
    const prisma = createMockPrisma({ existing: templateRow({ id: "tpl_2" }) });
    const service = new RiskTemplateService(prisma);

    const activated = await service.activate("tpl_2");

    expect(activated.isActive).toBe(true);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.riskTemplate.updateMany).toHaveBeenCalledWith({
      where: { isActive: true, id: { not: "tpl_2" } },
      data: { isActive: false },
    });
    expect(prisma.riskTemplate.update).toHaveBeenCalledWith({
      where: { id: "tpl_2" },
      data: { isActive: true },
    });
  });

  it("activate throws NotFound for a missing template", async () => {
    const service = new RiskTemplateService(createMockPrisma({ existing: null }));
    await expect(service.activate("missing")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("returns null when no active template exists", async () => {
    const service = new RiskTemplateService(createMockPrisma({ templates: [] }));
    expect(await service.getActive()).toBeNull();
  });

  it("returns the active template with derived amounts", async () => {
    const active = templateRow({ isActive: true, referenceCapital: "1000", riskPercent: "2", rewardRatio: "3" });
    const service = new RiskTemplateService(createMockPrisma({ templates: [active] }));

    expect(await service.getActive()).toMatchObject({
      isActive: true,
      riskAmount: "20",
      targetAmount: "60",
    });
  });

  it("updates only the provided fields", async () => {
    const prisma = createMockPrisma({ existing: templateRow() });
    const service = new RiskTemplateService(prisma);

    const updated = await service.update("tpl_1", { referenceCapital: "1000" });

    expect(prisma.riskTemplate.update).toHaveBeenCalledWith({
      where: { id: "tpl_1" },
      data: { referenceCapital: "1000" },
    });
    // Derived amounts follow the stepped-up capital: 1000 × 1% = 10, × 1.5 = 15.
    expect(updated).toMatchObject({ riskAmount: "10", targetAmount: "15" });
  });

  it("deletes an inactive template", async () => {
    const prisma = createMockPrisma({ existing: templateRow({ isActive: false }) });
    const service = new RiskTemplateService(prisma);

    await service.remove("tpl_1");
    expect(prisma.riskTemplate.delete).toHaveBeenCalledWith({ where: { id: "tpl_1" } });
  });

  it("refuses to delete the active template", async () => {
    const prisma = createMockPrisma({ existing: templateRow({ isActive: true }) });
    const service = new RiskTemplateService(prisma);

    await expect(service.remove("tpl_1")).rejects.toBeInstanceOf(ValidationError);
    expect(prisma.riskTemplate.delete).not.toHaveBeenCalled();
  });

  it("delete throws NotFound for a missing template", async () => {
    const service = new RiskTemplateService(createMockPrisma({ existing: null }));
    await expect(service.remove("missing")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("never reads any model other than RiskTemplate (no balance/alert/outcome derivation)", async () => {
    // A proxy Prisma that throws if ANY model except riskTemplate (or
    // $transaction) is touched: proves derived values come purely from the
    // stored template fields, not from exchange balances, alerts, or PnL.
    const inner = createMockPrisma({
      templates: [templateRow({ isActive: true })],
      existing: templateRow(),
      count: 1,
    });
    const guarded = new Proxy(inner as Record<string, unknown>, {
      get(target, property: string) {
        if (property !== "riskTemplate" && property !== "$transaction" && !(property in Object.prototype)) {
          throw new Error(`Unexpected access to prisma.${String(property)}`);
        }
        return target[property as keyof typeof target];
      },
    }) as unknown as PrismaClient;

    const service = new RiskTemplateService(guarded);
    await service.list();
    await service.getActive();
    await service.create({ name: "T", referenceCapital: "400", riskPercent: "1", rewardRatio: "1.5" });
    await service.update("tpl_1", { riskPercent: "2" });
    await service.activate("tpl_1");
  });
});
