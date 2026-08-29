export interface Diagnostic {
  readonly code: string;
  readonly path: readonly string[];
  readonly message: string;
  readonly correction: string;
}
