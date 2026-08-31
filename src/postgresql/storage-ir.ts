export const POSTGRESQL_STORAGE_IR_VERSION = 1 as const;

export type PostgreSqlType =
  | "text"
  | "bigint"
  | "numeric"
  | "boolean"
  | "date"
  | "timestamptz"
  | "uuid"
  | "jsonb";

export interface PostgreSqlColumn {
  readonly semanticId: string;
  readonly name: string;
  readonly type: PostgreSqlType;
  readonly nullable: boolean;
  readonly defaultSql: string | null;
  readonly generated: "identity" | null;
  readonly technical: boolean;
}

export interface PostgreSqlReference {
  readonly table: string;
  readonly column: string;
  readonly onDelete: "NO ACTION";
  readonly onUpdate: "NO ACTION";
}

export interface PostgreSqlConstraint {
  readonly semanticId: string;
  readonly name: string;
  readonly kind: "primaryKey" | "unique" | "check" | "foreignKey";
  readonly columns: readonly string[];
  readonly expression: string | null;
  readonly references: PostgreSqlReference | null;
}

export interface PostgreSqlIndex {
  readonly semanticId: string;
  readonly name: string;
  readonly unique: boolean;
  readonly columns: readonly string[];
  readonly where: string | null;
}

export interface PostgreSqlTable {
  readonly semanticId: string;
  readonly module: string | null;
  readonly name: string;
  readonly technical: boolean;
  readonly columns: readonly PostgreSqlColumn[];
  readonly constraints: readonly PostgreSqlConstraint[];
  readonly indexes: readonly PostgreSqlIndex[];
}

export interface PostgreSqlStorageIr {
  readonly schema: "vane.postgresql-storage-ir";
  readonly version: typeof POSTGRESQL_STORAGE_IR_VERSION;
  readonly provider: {
    readonly name: "postgresql";
    readonly minimumVersion: 16;
    readonly namespace: string;
  };
  readonly tables: readonly PostgreSqlTable[];
}

export function serializePostgreSqlStorageIr(ir: PostgreSqlStorageIr): string {
  return `${JSON.stringify(ir, null, 2)}\n`;
}
