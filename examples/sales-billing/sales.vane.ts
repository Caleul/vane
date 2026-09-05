import {
  Column,
  Entity,
  Event,
  Module,
  Rule,
  Saga,
  View,
  column,
  create,
  eq,
  event,
  eventRef,
  field,
  gte,
  input,
  literal,
  update,
} from "@lilka/vane";
import { Billing, Payment, PaymentGateway } from "./billing.vane.js";

@Entity()
export class Order {
  id = Column({ type: "uuid", identity: true });
  amount = Column({ type: "integer", minimum: 1 });
  minimum = Column({ type: "integer", minimum: 1 });
  status = Column({ type: "string" });
  @Rule({ expression: gte(column("amount"), column("minimum")) })
  MeetsMinimum() {}
  Place = Event({
    input: { id: "uuid", amount: "integer", minimum: "integer" },
    operation: create({
      id: input("id"),
      amount: input("amount"),
      minimum: input("minimum"),
      status: literal("placed"),
    }),
  });
  Cancel = Event({
    input: { id: "uuid" },
    operation: update(input("id"), { status: literal("cancelled") }),
  });
  Complete = Event({
    input: { id: "uuid" },
    operation: update(input("id"), { status: literal("complete") }),
  });
}
@View({
  input: { id: "uuid" },
  output: {
    id: field(Order, "id"),
    amount: field(Order, "amount"),
    status: field(Order, "status"),
  },
  query: { root: Order, where: eq(field(Order, "id"), input("id")) },
})
export class OrderDetails {}
@Saga({
  input: { id: "uuid", amount: "integer", minimum: "integer" },
  steps: {
    place: event(Order, "Place", { compensateWith: eventRef(Order, "Cancel") }),
    payment: event(Payment, "Create", {
      causedBy: ["place"],
      compensateWith: eventRef(Payment, "Cancel"),
    }),
    authorize: event(PaymentGateway, "Authorize", { causedBy: ["payment"] }),
    complete: event(Order, "Complete", { causedBy: ["authorize"] }),
  },
  terminal: { step: "complete", view: OrderDetails },
})
class PlaceOrder {}
@Module({
  imports: [Billing],
  entities: [Order],
  views: [OrderDetails],
  sagas: [PlaceOrder],
})
export class Sales {}
