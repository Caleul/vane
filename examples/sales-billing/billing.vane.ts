import {
  ACL,
  ACLEvent,
  Column,
  Entity,
  Event,
  Module,
  View,
  create,
  eq,
  fail,
  field,
  input,
  literal,
  success,
  update,
} from "@lilka/vane";

@Entity()
export class Payment {
  id = Column({ type: "uuid", identity: true });
  amount = Column({ type: "integer", minimum: 1 });
  status = Column({ type: "string" });
  Create = Event({
    input: { id: "uuid", amount: "integer" },
    operation: create({
      id: input("id"),
      amount: input("amount"),
      status: literal("created"),
    }),
  });
  Cancel = Event({
    input: { id: "uuid" },
    operation: update(input("id"), { status: literal("cancelled") }),
  });
}
@ACL()
export class PaymentGateway {
  Authorize = ACLEvent({
    input: { id: "uuid", amount: "integer" },
    results: { approved: success({ reference: "string" }), declined: fail({}) },
  });
}
@View({
  input: { id: "uuid" },
  output: {
    id: field(Payment, "id"),
    amount: field(Payment, "amount"),
    status: field(Payment, "status"),
  },
  query: { root: Payment, where: eq(field(Payment, "id"), input("id")) },
})
export class PaymentReceipt {}
@Module({
  entities: [Payment],
  antiCorruptionLayers: [PaymentGateway],
  views: [PaymentReceipt],
})
export class Billing {}
