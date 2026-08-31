import {
  ACL,
  ACLEvent,
  Column,
  Entity,
  Event,
  Module,
  Rule,
  Saga,
  View,
  and,
  column,
  desc,
  eq,
  event,
  eventRef,
  fail,
  field,
  gt,
  input,
  literal,
  not,
  optional,
  or,
  reference,
  relation,
  success,
} from "../src/index.js";
import type {
  EventMember,
  RuleExpressionDeclaration,
  ViewExpressionDeclaration,
} from "../src/index.js";

@Entity()
class Customer {
  @Column({ type: "uuid", identity: true, generated: "uuid" })
  id!: string;

  @Column({ type: "string", minLength: 1, maxLength: 120 })
  name!: string;
}

@Entity()
class Order {
  @Column({ type: "uuid", identity: true, generated: "uuid" })
  id!: string;

  @Column({ type: "uuid", references: reference(Customer, "id") })
  customerId!: string;

  @Column({ type: "decimal", minimum: 0, default: 0 })
  total!: number;

  @Column({ type: "json", default: { source: "web", flags: ["new"] } })
  metadata!: unknown;

  @Rule({ expression: gt(column("total"), column("discount")) })
  PositiveTotal() {}

  @Column({ type: "decimal", minimum: 0, default: 0 })
  discount!: number;

  @Event({ input: { customerId: "uuid", coupon: optional("string") } })
  Place!: EventMember;

  @Event()
  Cancel!: EventMember;

  formatForLogs() {}
}

@ACL()
class PaymentGateway {
  @ACLEvent({
    input: { amount: "decimal" },
    results: {
      approved: success({ transactionId: "string" }),
      declined: fail({ code: "string", reason: optional("string") }),
    },
  })
  Authorize!: EventMember;
}

@Entity()
class InvalidEntityEventOptions {
  // @ts-expect-error ACL result interpretations require @ACLEvent, not @Event.
  @Event({ results: { approved: success({}), declined: fail({}) } })
  Authorize!: EventMember;
}

class InvalidEventMemberKind {
  // @ts-expect-error Events are declarative EventMember properties, not arbitrary methods.
  @Event()
  Place() {}
}

class InvalidEventMemberType {
  // @ts-expect-error Event decorators require an EventMember-typed property.
  @Event()
  Place!: string;
}

class InvalidEventMemberDeclarations {
  // @ts-expect-error Static Event members cannot be referenced through the instance owner.
  @Event()
  static StaticPlace: EventMember;

  // @ts-expect-error Private Event members are absent from the public owner contract.
  @Event()
  private PrivatePlace!: EventMember;

  // @ts-expect-error Optional Event members are not guaranteed semantic declarations.
  @Event()
  MaybePlace?: EventMember;
}

// @ts-expect-error ACL Events must declare result interpretations.
ACLEvent({ input: { amount: "decimal" } });

@View({
  input: { customerId: "uuid", limit: "integer" },
  output: {
    orderId: field(Order, "id"),
    customerName: field(Customer, "name"),
  },
  query: {
    root: Order,
    relations: {
      customer: relation(field(Order, "customerId"), field(Customer, "id")),
    },
    where: and(
      eq(field(Order, "customerId"), input("customerId")),
      gt(field(Order, "total"), literal(0)),
    ),
    orderBy: [desc(field(Customer, "name"))],
    pagination: { limit: input("limit") },
  },
})
class OrderDetails {}

@Saga({
  input: { orderId: "uuid" },
  steps: {
    place: event(Order, "Place", {
      compensateWith: eventRef(Order, "Cancel"),
    }),
    authorize: event(PaymentGateway, "Authorize", {
      causedBy: ["place"],
    }),
  },
  terminal: { step: "authorize", view: OrderDetails },
})
class PlaceOrder {}

@Module({
  entities: [Customer, Order],
  views: [OrderDetails],
  antiCorruptionLayers: [PaymentGateway],
  sagas: [PlaceOrder],
})
class Core {}

@Module({ imports: [Core], entities: [] })
class Application {}

void Application;

// @ts-expect-error Entity members are checked by field().
field(Customer, "missing");
// @ts-expect-error Event members are not Columns.
field(Order, "Place");
// @ts-expect-error Event members are not Column references.
reference(Order, "Cancel");
// @ts-expect-error Rule methods are not semantic Events.
eventRef(Order, "PositiveTotal");
// @ts-expect-error Undecorated methods are not semantic Events.
eventRef(Order, "formatForLogs");
// @ts-expect-error Event members are checked by eventRef().
eventRef(Order, "MissingEvent");
// @ts-expect-error Properties are Columns, not Events.
eventRef(Order, "id");
// @ts-expect-error Generation strategy is a closed semantic vocabulary.
Column({ type: "uuid", generated: "random" });
// @ts-expect-error Column types are a closed semantic vocabulary.
optional("text");

const viewOnlyComparison = eq(field(Order, "id"), input("id"));
// @ts-expect-error View-only operands cannot produce a Rule expression.
const invalidRuleExpression: RuleExpressionDeclaration = viewOnlyComparison;

const ruleOnlyComparison = eq(column("total"), literal(0));
// @ts-expect-error Rule-only operands cannot produce a View expression.
const invalidViewExpression: ViewExpressionDeclaration = ruleOnlyComparison;

const sharedComparison = eq(literal(1), literal(1));
const ruleWithSharedComparison: RuleExpressionDeclaration = and(
  ruleOnlyComparison,
  sharedComparison,
);
const viewWithSharedComparison: ViewExpressionDeclaration = and(
  viewOnlyComparison,
  sharedComparison,
);
const sharedNegation = not(sharedComparison);
const sharedNegationRule: RuleExpressionDeclaration = sharedNegation;
const sharedNegationView: ViewExpressionDeclaration = sharedNegation;
const sharedLogical = and(sharedComparison, sharedNegation);
const sharedRuleExpression: RuleExpressionDeclaration = sharedLogical;
const sharedViewExpression: ViewExpressionDeclaration = sharedLogical;

// @ts-expect-error Logical Rule helpers require at least two operands.
and(ruleOnlyComparison);
// @ts-expect-error Logical View helpers require at least two operands.
or(viewOnlyComparison);

void invalidRuleExpression;
void invalidViewExpression;
void ruleWithSharedComparison;
void viewWithSharedComparison;
void sharedNegationRule;
void sharedNegationView;
void sharedRuleExpression;
void sharedViewExpression;
