import { Decimal } from "decimal.js";
import { z } from "zod";

/**
 * All money is handled as decimal strings with 2 places (ADR-006). Never use JS numbers for amounts.
 * Rounding is banker's rounding (half-even), applied once per computed line.
 */
export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });
export type Dec = InstanceType<typeof D>;

const LIMIT = new D("1e15");

/** Accepts "1234.5", "1,234.50", 1234.5 (numbers are converted via their shortest string form). */
export const money = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === "number" ? String(v) : v.replace(/,/g, "").trim()))
  .refine((v) => /^-?\d+(\.\d{1,2})?$/.test(v), "Amounts must have at most 2 decimal places")
  .refine((v) => new D(v).abs().lt(LIMIT), "Amount is too large")
  .transform((v) => new D(v).toFixed(2));

export const nonNegativeMoney = money.refine((v) => !new D(v).isNeg(), "Amount cannot be negative");

export const percent = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => /^\d{1,3}(\.\d{1,2})?$/.test(v) && new D(v).lte(100), "Percent must be between 0 and 100 with at most 2 decimals")
  .transform((v) => new D(v).toFixed(2));

export const dec = (v: string | number | null | undefined) => new D(v ?? 0);
export const fmt = (v: Dec) => v.toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN).toFixed(2);
export const sum = (values: (string | Dec | null | undefined)[]) => values.reduce<Dec>((a, v) => a.plus(v ?? 0), new D(0));
/** amount × pct / 100, rounded half-even to cents. */
export const pctOf = (amount: Dec | string, pct: Dec | string) => new D(amount).times(pct).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);
