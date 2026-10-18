import { describe, expect, it } from "vitest";
import {
  displacementHours,
  estimateDisplacementEmissions,
  estimateEmissions,
  evaluateClaim,
  multiply,
  relativeWidth,
  STANDARD_LIMITATIONS,
  ValidationError,
  type EmissionsInputs,
  type Range,
  type Unit,
} from "../../src";
import { eligibleInput } from "../fixtures";

const inputs = (over: Partial<EmissionsInputs> = {}): EmissionsInputs => ({
  runtimeHours: { low: 10, high: 20, unit: "h", provenance: "attested" },
  fuelLitresPerHour: { low: 1.5, high: 3, unit: "L/h", provenance: "assumed", note: "test fixture" },
  emissionFactorKgCo2ePerLitre: { low: 2, high: 2.8, unit: "kgCO2e/L", provenance: "sourced", source: "test fixture, not a real citation" },
  ...over,
});

describe("unit-checked interval arithmetic", () => {
  it("h x L/h = L and L x kgCO2e/L = kgCO2e", () => {
    const fuel = multiply({ low: 2, high: 3, unit: "h" }, { low: 1, high: 2, unit: "L/h" });
    expect(fuel).toEqual({ low: 2, high: 6, unit: "L" });
    expect(multiply(fuel, { low: 2, high: 2.5, unit: "kgCO2e/L" })).toEqual({ low: 4, high: 15, unit: "kgCO2e" });
  });

  it("rejects dimensionally meaningless products", () => {
    expect(() => multiply({ low: 1, high: 2, unit: "h" }, { low: 1, high: 2, unit: "h" })).toThrowError(expect.objectContaining({ code: "INCOMPATIBLE_UNITS" }));
    expect(() => multiply({ low: 1, high: 2, unit: "L" }, { low: 1, high: 2, unit: "L/h" })).toThrow(ValidationError);
    expect(() => multiply({ low: 1, high: 2, unit: "kgCO2e" }, { low: 1, high: 2, unit: "h" })).toThrow(ValidationError);
  });

  it("computes the corner products: low from lows, high from highs", () => {
    const e = estimateEmissions(inputs());
    expect(e.fuelLitres).toEqual({ low: 15, high: 60, unit: "L" });
    expect(e.emissionsKgCo2e.low).toBeCloseTo(30, 9);
    expect(e.emissionsKgCo2e.high).toBeCloseTo(168, 9);
    expect(e.emissionsKgCo2e.unit).toBe("kgCO2e");
  });

  it("zero runtime gives a zero interval, not NaN", () => {
    const e = estimateEmissions(inputs({ runtimeHours: { low: 0, high: 0, unit: "h", provenance: "attested" } }));
    expect(e.emissionsKgCo2e).toEqual({ low: 0, high: 0, unit: "kgCO2e" });
  });
});

describe("input validation", () => {
  const bad = (over: Partial<EmissionsInputs>) => () => estimateEmissions(inputs(over));
  it("rejects negative, non-finite and inverted ranges", () => {
    expect(bad({ runtimeHours: { low: -1, high: 5, unit: "h", provenance: "attested" } })).toThrow(ValidationError);
    expect(bad({ runtimeHours: { low: 1, high: Number.NaN, unit: "h", provenance: "attested" } })).toThrow(ValidationError);
    expect(bad({ runtimeHours: { low: 1, high: Number.POSITIVE_INFINITY, unit: "h", provenance: "attested" } })).toThrow(ValidationError);
    expect(bad({ fuelLitresPerHour: { low: 3, high: 1.5, unit: "L/h", provenance: "assumed" } })).toThrowError(expect.objectContaining({ code: "INVALID_RANGE" }));
  });
  it("rejects the wrong unit for an input slot", () => {
    expect(bad({ fuelLitresPerHour: { low: 1, high: 2, unit: "L" as never, provenance: "assumed" } })).toThrow(ValidationError);
    expect(bad({ emissionFactorKgCo2ePerLitre: { low: 1, high: 2, unit: "kgCO2e" as never, provenance: "assumed" } })).toThrow(ValidationError);
  });
  it("requires a provenance label, and a named source when provenance is sourced", () => {
    expect(bad({ fuelLitresPerHour: { low: 1, high: 2, unit: "L/h" } as never })).toThrowError(expect.objectContaining({ code: "INVALID_PROVENANCE" }));
    expect(bad({ emissionFactorKgCo2ePerLitre: { low: 2, high: 3, unit: "kgCO2e/L", provenance: "sourced" } })).toThrowError(expect.objectContaining({ code: "INVALID_PROVENANCE" }));
    expect(bad({ emissionFactorKgCo2ePerLitre: { low: 2, high: 3, unit: "kgCO2e/L", provenance: "sourced", source: "   " } })).toThrow(ValidationError);
  });
});

describe("uncertainty propagation", () => {
  it("widening any input widens the output interval", () => {
    const narrow = estimateEmissions(inputs()).emissionsKgCo2e;
    const wideFuel = estimateEmissions(inputs({ fuelLitresPerHour: { low: 1, high: 4, unit: "L/h", provenance: "assumed" } })).emissionsKgCo2e;
    expect(wideFuel.low).toBeLessThan(narrow.low);
    expect(wideFuel.high).toBeGreaterThan(narrow.high);
    expect(relativeWidth(wideFuel)).toBeGreaterThan(relativeWidth(narrow));
  });

  it("point inputs give a point estimate with zero relative width", () => {
    const e = estimateEmissions({
      runtimeHours: { low: 10, high: 10, unit: "h", provenance: "attested" },
      fuelLitresPerHour: { low: 2, high: 2, unit: "L/h", provenance: "assumed" },
      emissionFactorKgCo2ePerLitre: { low: 2.5, high: 2.5, unit: "kgCO2e/L", provenance: "assumed" },
    });
    expect(e.emissionsKgCo2e.low).toBe(e.emissionsKgCo2e.high);
    expect(relativeWidth(e.emissionsKgCo2e)).toBe(0);
  });

  it("the evaluator's displacement interval flows through to the emissions interval", () => {
    const r = evaluateClaim(eligibleInput());
    expect(displacementHours(r.displacement)).toEqual({ low: 21, high: 21, unit: "h" });
    const est = estimateDisplacementEmissions(
      r.displacement,
      { low: 1, high: 2, unit: "L/h", provenance: "assumed", note: "test fixture" },
      { low: 2, high: 3, unit: "kgCO2e/L", provenance: "assumed", note: "test fixture" },
    );
    expect(est.fuelLitres).toEqual({ low: 21, high: 42, unit: "L" });
    expect(est.emissionsKgCo2e).toEqual({ low: 42, high: 126, unit: "kgCO2e" });
  });

  it("an uncertain displacement interval stays uncertain in kgCO2e", () => {
    const d = { baselineLowMilliHours: 24_000, baselineHighMilliHours: 24_000, postLowMilliHours: 3_000, postHighMilliHours: 9_000, lowMilliHours: 15_000, highMilliHours: 21_000 };
    const est = estimateDisplacementEmissions(d, { low: 1, high: 2, unit: "L/h", provenance: "assumed" }, { low: 2, high: 3, unit: "kgCO2e/L", provenance: "assumed" });
    expect(est.emissionsKgCo2e).toEqual({ low: 30, high: 126, unit: "kgCO2e" });
  });
});

describe("transparency of the estimate", () => {
  it("every output carries its inputs, their provenance, and the standing limitations", () => {
    const e = estimateEmissions(inputs());
    expect(e.assumptions.map((a) => [a.name, a.provenance])).toEqual([
      ["runtime", "attested"],
      ["fuel rate", "assumed"],
      ["emission factor", "sourced"],
    ]);
    expect(e.assumptions[2]?.source).toContain("test fixture");
    expect(e.limitations).toEqual([...STANDARD_LIMITATIONS]);
    expect(e.limitations.some((l) => /not a certified carbon credit/i.test(l))).toBe(true);
  });

  it("the library ships no default fuel rates or emission factors", () => {
    const missing = { runtimeHours: { low: 1, high: 2, unit: "h", provenance: "attested" } } as unknown as EmissionsInputs;
    expect(() => estimateEmissions(missing)).toThrow();
  });
  it("types: Range is generic over Unit", () => {
    const r: Range<Unit> = { low: 0, high: 1, unit: "h" };
    expect(r.unit).toBe("h");
  });
});
