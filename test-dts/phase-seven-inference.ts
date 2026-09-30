import {
  ACL,
  ACLEvent,
  Column,
  Entity,
  Event,
  type EventInput,
  type JsonValue,
  type ProviderSelection,
  View,
  type ViewInput,
  type ViewOutput,
  add,
  avg,
  count,
  create,
  fail,
  field,
  input,
  literal,
  max,
  min,
  node,
  optional,
  postgres,
  remove,
  subtract,
  success,
  sum,
  update,
  upsert,
} from "../src/index.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B
  ? 1
  : 2
  ? true
  : false;
type Assert<T extends true> = T;
type IsAny<T> = 0 extends 1 & T ? true : false;

@Entity()
class Invoice {
  id = Column({ type: "uuid", identity: true });
  quantity = Column({ type: "integer" });
  amount = Column({ type: "decimal" });
  active = Column({ type: "boolean" });
  memo = Column({ type: "string", nullable: true });
  explicitNullable = Column<"string">({ type: "string", nullable: true });
  date = Column({ type: "date" });
  time = Column({ type: "datetime" });
  metadata = Column({ type: "json" });
  Add = Event({
    input: {
      id: "uuid",
      quantity: "integer",
      amount: "decimal",
      active: "boolean",
      memo: optional("string"),
      date: "date",
      time: "datetime",
      metadata: "json",
    },
    operation: create({ id: input("id"), quantity: input("quantity") }),
  });
  Change = Event({
    input: { id: "uuid", quantity: "integer" },
    operation: update(input("id"), {
      quantity: add(input("quantity"), literal(1)),
    }),
  });
  Store = Event({
    input: { id: "uuid", quantity: "integer" },
    operation: upsert(input("id"), {
      quantity: subtract(input("quantity"), literal(1)),
    }),
  });
  Erase = Event({ input: { id: "uuid" }, operation: remove(input("id")) });
  Empty = Event({ operation: create({}) });
}
@ACL()
class Gateway {
  Charge = ACLEvent({
    input: { amount: "decimal", reference: optional("string") },
    results: {
      paid: success({ receipt: "uuid" }),
      declined: fail({ reason: "string" }),
    },
  });
}
const Card = View({
  input: { id: "uuid", limit: optional("integer") },
  output: {
    id: field(Invoice, "id"),
    quantity: field(Invoice, "quantity"),
    amount: field(Invoice, "amount"),
    active: field(Invoice, "active"),
    memo: field(Invoice, "memo"),
    date: field(Invoice, "date"),
    time: field(Invoice, "time"),
    metadata: field(Invoice, "metadata"),
  },
  query: { root: Invoice },
});
@Card
class InvoiceCard {}
const Totals = View({
  input: {},
  output: {
    count: count(field(Invoice, "id")),
    sum: sum(field(Invoice, "amount")),
    avg: avg(field(Invoice, "amount")),
    first: min(field(Invoice, "date")),
    last: max(field(Invoice, "date")),
  },
  query: { root: Invoice },
});
@Totals
class InvoiceTotals {}

type Input = EventInput<Invoice["Add"]>;
type Row = ViewOutput<typeof Card>;
type Query = ViewInput<typeof Card>;
type Summary = ViewOutput<typeof Totals>;
type InputHasNoAny = Assert<Equal<IsAny<Input>, false>>;
type InputNumber = Assert<Equal<Input["quantity"], number>>;
type InputOptional = Assert<Equal<Input["memo"], string | undefined>>;
type InputBoolean = Assert<Equal<Input["active"], boolean>>;
type InputUuid = Assert<Equal<Input["id"], string>>;
type InputDecimal = Assert<Equal<Input["amount"], number>>;
type InputDate = Assert<Equal<Input["date"], string>>;
type InputDatetime = Assert<Equal<Input["time"], string>>;
type InputJson = Assert<Equal<Input["metadata"], JsonValue>>;
type QueryOptional = Assert<Equal<Query["limit"], number | undefined>>;
type ExactRowKeys = Assert<
  Equal<
    keyof Row,
    | "id"
    | "quantity"
    | "amount"
    | "active"
    | "memo"
    | "date"
    | "time"
    | "metadata"
  >
>;
type RowHasNoAny = Assert<Equal<IsAny<Row>, false>>;
type RequiredId = Assert<Equal<Row["id"], string>>;
type NullableMemo = Assert<Equal<Row["memo"], string | null>>;
type BooleanOutput = Assert<Equal<Row["active"], boolean>>;
type IntegerOutput = Assert<Equal<Row["quantity"], number>>;
type DecimalOutput = Assert<Equal<Row["amount"], number>>;
type DateOutput = Assert<Equal<Row["date"], string>>;
type DatetimeOutput = Assert<Equal<Row["time"], string>>;
type JsonNotAny = Assert<Equal<IsAny<Row["metadata"]>, false>>;
type JsonExact = Assert<Equal<Row["metadata"], JsonValue>>;
type CountNotNullable = Assert<Equal<Summary["count"], number>>;
type SumNullable = Assert<Equal<Summary["sum"], number | null>>;
type AverageNullable = Assert<Equal<Summary["avg"], number | null>>;
type MinimumNullable = Assert<Equal<Summary["first"], string | null>>;
type MaximumNullable = Assert<Equal<Summary["last"], string | null>>;
const Explicit = View({
  input: {},
  output: { value: field(Invoice, "explicitNullable") },
  query: { root: Invoice },
});
type ExplicitGenericStillNullable = Assert<
  Equal<ViewOutput<typeof Explicit>["value"], string | null>
>;

const validInput: Input = {
  id: "id",
  quantity: 2,
  amount: 1.5,
  active: true,
  date: "2026-01-01",
  time: "2026-01-01T00:00:00Z",
  metadata: { ok: true },
};
const validQuery: Query = { id: "id" };
const validRow: Row = {
  id: "id",
  quantity: 2,
  amount: 1.5,
  active: true,
  memo: null,
  date: "2026-01-01",
  time: "2026-01-01T00:00:00Z",
  metadata: { ok: [true] },
};
const validAcl: EventInput<Gateway["Charge"]> = { amount: 1.5 };
const validEmpty: EventInput<Invoice["Empty"]> = {};
const runtime: ProviderSelection<"runtime"> = node();
const storage: ProviderSelection<"storage"> = postgres();
// @ts-expect-error Inferred Event integer is not a string.
const wrongInput: Input = { ...validInput, quantity: "2" };
// @ts-expect-error Optional input remains typed.
const wrongOptional: Input = { ...validInput, memo: 7 };
// @ts-expect-error Required Event fields cannot be omitted.
const missingInput: Input = { quantity: 2 };
// @ts-expect-error View output is an exact inferred row shape.
const wrongRow: Row = { ...validRow, active: "true" };
// @ts-expect-error JSON output is a JSON value, not arbitrary unknown.
const wrongJson: Row = { ...validRow, metadata: () => true };
// @ts-expect-error Nonnullable output excludes null.
const wrongNull: Row = { ...validRow, id: null };
// @ts-expect-error Typed View query rejects wrong optional value.
const wrongQuery: Query = { id: "id", limit: "5" };
// @ts-expect-error ACL Event payload retains its own types.
const wrongAcl: EventInput<Gateway["Charge"]> = { amount: "paid" };
// @ts-expect-error Empty inputs do not become any or an unrestricted object.
const wrongEmpty: EventInput<Invoice["Empty"]> = { arbitrary: true };
// @ts-expect-error Runtime and storage providers remain distinct.
const wrongProvider: ProviderSelection<"runtime"> = postgres();
// @ts-expect-error Column type is opaque, not the application's string value.
const copiedValue: string = new Invoice().id;
// @ts-expect-error Closed Column vocabulary.
Column({ type: "text" });
// @ts-expect-error Event factory cannot become an ACL result declaration.
Event({ results: { ok: success({}) } });
// @ts-expect-error Entity Event has exactly one operation, not a handler.
Event({ handler: () => null });
// @ts-expect-error ACL requires result interpretations.
ACLEvent({ input: { amount: "decimal" } });
// @ts-expect-error create requires operation value tokens.
create({ amount: 2 });
// @ts-expect-error update requires identity and assignments.
update(input("id"));
// @ts-expect-error upsert requires identity and assignments.
upsert(input("id"));
// @ts-expect-error remove accepts one identity token only.
remove(input("id"), {});
// @ts-expect-error arithmetic requires operation value tokens.
add(input("quantity"), 1);
// @ts-expect-error arithmetic requires operation value tokens.
subtract("quantity", literal(1));
void [
  InvoiceCard,
  InvoiceTotals,
  validInput,
  validQuery,
  validRow,
  validAcl,
  validEmpty,
  runtime,
  storage,
  wrongInput,
  wrongOptional,
  missingInput,
  wrongRow,
  wrongNull,
  wrongQuery,
  wrongAcl,
  wrongEmpty,
  wrongProvider,
  copiedValue,
];
