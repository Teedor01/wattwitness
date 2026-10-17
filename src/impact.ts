import { ValidationError } from "./errors";
import type { Displacement } from "./evaluator";
import { MILLI } from "./types";

export type Unit = "h" | "L/h" | "L" | "kgCO2e/L" | "kgCO2e";

export type Provenance = "attested" | "sourced" | "assumed";

export interface Range<U extends Unit> {
  low: number;
  high: number;
  unit: U;
}

export interface Input<U extends Unit> extends Range<U> {
  provenance: Provenance;
  source?: string;
  note?: string;
}

const PRODUCT_UNIT: Record<string, Unit> = {
  "h*L/h": "L",
  "L*kgCO2e/L": "kgCO2e",
};

function assertRange(r: Range<Unit>, label: string, expectedUnit: Unit): void {
  const issues: string[] = [];
  if (r.unit !== expectedUnit) issues.push(`${label}: unit must be "${expectedUnit}" but got "${String(r.unit)}"`);
  if (!Number.isFinite(r.low) || !Number.isFinite(r.high)) issues.push(`${label}: bounds must be finite numbers`);
  else {
    if (r.low < 0 || r.high < 0) issues.push(`${label}: bounds must be non-negative`);
    if (r.low > r.high) issues.push(`${label}: low must be <= high`);
  }
  if (issues.length > 0) throw new ValidationError("INVALID_RANGE", issues);
}

function assertProvenance(i: Input<Unit>, label: string): void {
  if (i.provenance !== "attested" && i.provenance !== "sourced" && i.provenance !== "assumed") {
    throw new ValidationError("INVALID_PROVENANCE", [`${label}: provenance must be attested, sourced or assumed`]);
  }
  if (i.provenance === "sourced" && (typeof i.source !== "string" || i.source.trim() === "")) {
    throw new ValidationError("INVALID_PROVENANCE", [`${label}: a "sourced" input must name its source`]);
  }
}

export function multiply<A extends Unit, B extends Unit>(a: Range<A>, b: Range<B>): Range<Unit> {
  const unit = PRODUCT_UNIT[`${a.unit}*${b.unit}`];
  if (unit === undefined) {
    throw new ValidationError("INCOMPATIBLE_UNITS", [`cannot multiply ${a.unit} by ${b.unit}`]);
  }
  return { low: a.low * b.low, high: a.high * b.high, unit };
}

export function relativeWidth(r: Range<Unit>): number {
  return r.high === 0 ? 0 : (r.high - r.low) / r.high;
}

export interface AssumptionRow {
  name: string;
  range: Range<Unit>;
  provenance: Provenance;
  source?: string;
  note?: string;
}

export interface EmissionsEstimate {
  fuelLitres: Range<"L">;
  emissionsKgCo2e: Range<"kgCO2e">;
  assumptions: AssumptionRow[];
  limitations: string[];
}

export interface EmissionsInputs {
  runtimeHours: Input<"h">;
  fuelLitresPerHour: Input<"L/h">;
  emissionFactorKgCo2ePerLitre: Input<"kgCO2e/L">;
}

export const STANDARD_LIMITATIONS: readonly string[] = [
  "Runtime does not reveal electrical load, so the fuel-rate range must span realistic load variation.",
  "Runtime is attested by corroborated observations; it is not a physical measurement of fuel burned.",
  "The result is an interval, not a point estimate, and is only as reliable as its least reliable input.",
  "This is an evidence-backed estimate, not a certified carbon credit under any carbon-accounting methodology.",
];

export function estimateEmissions(inputs: EmissionsInputs): EmissionsEstimate {
  const { runtimeHours: rt, fuelLitresPerHour: fr, emissionFactorKgCo2ePerLitre: ef } = inputs;
  assertRange(rt, "runtimeHours", "h");
  assertRange(fr, "fuelLitresPerHour", "L/h");
  assertRange(ef, "emissionFactorKgCo2ePerLitre", "kgCO2e/L");
  assertProvenance(rt, "runtimeHours");
  assertProvenance(fr, "fuelLitresPerHour");
  assertProvenance(ef, "emissionFactorKgCo2ePerLitre");

  const fuel = multiply(rt, fr) as Range<"L">;
  const emissions = multiply(fuel, ef) as Range<"kgCO2e">;
  const row = (name: string, i: Input<Unit>): AssumptionRow => ({
    name,
    range: { low: i.low, high: i.high, unit: i.unit },
    provenance: i.provenance,
    ...(i.source !== undefined ? { source: i.source } : {}),
    ...(i.note !== undefined ? { note: i.note } : {}),
  });
  return {
    fuelLitres: fuel,
    emissionsKgCo2e: emissions,
    assumptions: [row("runtime", rt), row("fuel rate", fr), row("emission factor", ef)],
    limitations: [...STANDARD_LIMITATIONS],
  };
}

export function displacementHours(d: Displacement): Range<"h"> {
  return { low: d.lowMilliHours / MILLI, high: d.highMilliHours / MILLI, unit: "h" };
}

export function estimateDisplacementEmissions(
  d: Displacement,
  fuelLitresPerHour: Input<"L/h">,
  emissionFactorKgCo2ePerLitre: Input<"kgCO2e/L">,
): EmissionsEstimate {
  const h = displacementHours(d);
  return estimateEmissions({
    runtimeHours: { ...h, provenance: "attested", note: "displaced hours = committed baseline minus corroborated claim-period runtime" },
    fuelLitresPerHour,
    emissionFactorKgCo2ePerLitre,
  });
}
