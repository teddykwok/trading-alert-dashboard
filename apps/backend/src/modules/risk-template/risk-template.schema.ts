import { z } from "zod";

/**
 * Decimal-safe positive value. Strings are preferred (exact precision into
 * Prisma's Decimal); plain JSON numbers are accepted for convenience. The
 * "greater than zero" check is a pure string test (any nonzero digit), never
 * a float comparison. Digit limits mirror the column types so invalid input
 * fails validation (422) instead of erroring at the database.
 */
function positiveDecimal(integerDigits: number, fractionDigits: number) {
  return z.union([
    z
      .string()
      .trim()
      .regex(
        new RegExp(`^\\d{1,${integerDigits}}(\\.\\d{1,${fractionDigits}})?$`),
        `must be a plain positive decimal with at most ${integerDigits} integer and ${fractionDigits} fraction digits`
      )
      .refine((value) => /[1-9]/.test(value), "must be greater than zero"),
    z.number().finite().positive(),
  ]);
}

// Column types: referenceCapital Decimal(30,12), riskPercent Decimal(10,6),
// rewardRatio Decimal(10,4).
const referenceCapital = positiveDecimal(18, 12);
const riskPercent = positiveDecimal(4, 6);
const rewardRatio = positiveDecimal(6, 4);

const name = z.string().trim().min(1, "name must not be empty").max(100);

// Note: riskAmount/targetAmount are intentionally NOT part of these schemas —
// they are derived server-side from the stored fields on every read and any
// client-sent value is stripped by zod, never trusted.
export const riskTemplateCreateSchema = z.object({
  name,
  referenceCapital,
  riskPercent,
  rewardRatio,
});

export const riskTemplateUpdateSchema = z
  .object({
    name: name.optional(),
    referenceCapital: referenceCapital.optional(),
    riskPercent: riskPercent.optional(),
    rewardRatio: rewardRatio.optional(),
  })
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    "at least one field must be provided"
  );

export type RiskTemplateCreateInput = z.infer<typeof riskTemplateCreateSchema>;
export type RiskTemplateUpdateInput = z.infer<typeof riskTemplateUpdateSchema>;
