export class ValidationError extends Error {
  readonly code: string;
  readonly issues: string[];
  constructor(code: string, issues: string[]) {
    super(`${code}: ${issues.join("; ")}`);
    this.name = "ValidationError";
    this.code = code;
    this.issues = issues;
  }
}
