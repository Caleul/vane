export interface SourcePosition {
  readonly line: number;
  readonly column: number;
}

export interface SourceLocation {
  readonly fileName: string;
  readonly start: SourcePosition;
  readonly end: SourcePosition;
}

export interface Diagnostic {
  readonly code: string;
  readonly path: readonly string[];
  readonly message: string;
  readonly correction: string;
  readonly location?: SourceLocation;
}
