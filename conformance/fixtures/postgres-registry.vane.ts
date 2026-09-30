// Independently authored public DSL fixture. No implementation/test fixture imports.
import {
  Column,
  Entity,
  Event,
  Module,
  Rule,
  Saga,
  View,
  add,
  asc,
  column,
  create,
  eq,
  event,
  eventRef,
  field,
  gte,
  input,
  literal,
  remove,
  update,
  upsert,
} from "@lilka/vane";
@Entity()
class Parcel {
  id = Column({ type: "uuid", identity: true });
  label = Column({ type: "string", unique: true, minLength: 1, maxLength: 40 });
  units = Column({ type: "integer", minimum: 0, maximum: 1000, default: 0 });
  capacity = Column({ type: "integer", default: 100 });
  weight = Column({ type: "decimal", default: 1.25 });
  active = Column({ type: "boolean", default: true });
  expires = Column({ type: "date", nullable: true });
  recorded = Column({ type: "datetime", nullable: true });
  metadata = Column({ type: "json", default: { kind: "conformance" } });
  @Rule({ expression: gte(column("capacity"), column("units")) })
  WithinCapacity() {}
  Register = Event({
    input: { id: "uuid", label: "string" },
    operation: create({
      id: input("id"),
      label: input("label"),
      recorded: literal("2026-09-01T08:00:00.000Z"),
    }),
  });
  RegisterLoad = Event({
    input: { id: "uuid", label: "string", amount: "integer" },
    operation: create({ id: input("id"), label: input("label") }),
  });
  AddUnits = Event({
    input: { id: "uuid", amount: "integer" },
    operation: update(input("id"), {
      units: add(column("units"), input("amount")),
    }),
  });
  Rename = Event({
    input: { id: "uuid", label: "string" },
    operation: update(input("id"), { label: input("label") }),
  });
  Store = Event({
    input: { id: "uuid", label: "string" },
    operation: upsert(input("id"), { label: input("label") }),
  });
  Erase = Event({ input: { id: "uuid" }, operation: remove(input("id")) });
  Activate = Event({
    input: { id: "uuid" },
    operation: update(input("id"), { active: literal(false) }),
  });
}
@Entity()
class ReceiptStamp {
  id = Column({ type: "uuid", identity: true, generated: "uuid" });
  value = Column({ type: "string", default: "untouched" });
  Stamp = Event({ operation: create({}) });
}
@View({
  input: { id: "uuid" },
  output: {
    id: field(Parcel, "id"),
    label: field(Parcel, "label"),
    active: field(Parcel, "active"),
  },
  query: { root: Parcel, where: eq(field(Parcel, "id"), input("id")) },
})
class ParcelCard {}
@View({
  input: { minimum: "integer", limit: "integer", offset: "integer" },
  output: { label: field(Parcel, "label"), units: field(Parcel, "units") },
  query: {
    root: Parcel,
    where: gte(field(Parcel, "units"), input("minimum")),
    orderBy: [asc(field(Parcel, "label"))],
    pagination: { limit: input("limit"), offset: input("offset") },
  },
})
class ParcelPage {}
@Saga({
  input: { id: "uuid", label: "string" },
  steps: {
    register: event(Parcel, "Register"),
    stamp: event(ReceiptStamp, "Stamp", { causedBy: ["register"] }),
  },
  terminal: { step: "stamp", view: ParcelCard },
})
class StampParcel {}
@Saga({
  input: { id: "uuid", label: "string" },
  steps: {
    register: event(Parcel, "Register", {
      compensateWith: eventRef(Parcel, "Erase"),
    }),
    activate: event(Parcel, "Activate", { causedBy: ["register"] }),
  },
  terminal: { step: "activate", view: ParcelCard },
})
class RegisterParcel {}
@Saga({
  input: { id: "uuid", label: "string", amount: "integer" },
  steps: {
    register: event(Parcel, "RegisterLoad", {
      compensateWith: eventRef(Parcel, "Erase"),
    }),
    overfill: event(Parcel, "AddUnits", { causedBy: ["register"] }),
  },
  terminal: { step: "overfill", view: ParcelCard },
})
class OverfillParcel {}
@Module({
  entities: [Parcel, ReceiptStamp],
  views: [ParcelCard, ParcelPage],
  sagas: [RegisterParcel, OverfillParcel, StampParcel],
})
class Registry {}
