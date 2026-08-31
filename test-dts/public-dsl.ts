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
  RuleExpressionDeclaration,
  ViewExpressionDeclaration,
} from "../src/index.js";

@Entity()
class Customer {
  id = Column({ type: "uuid", identity: true, generated: "uuid" });

  name = Column({ type: "string", minLength: 1, maxLength: 120 });
}

@Entity()
class Order {
  cacheKey!: string;

  id = Column({ type: "uuid", identity: true, generated: "uuid" });

  customerId = Column({ type: "uuid", references: reference(Customer, "id") });

  total = Column({ type: "decimal", minimum: 0, default: 0 });

  metadata = Column({
    type: "json",
    default: { source: "web", flags: ["new"] },
  });

  @Rule({ expression: gt(column("total"), column("discount")) })
  PositiveTotal() {}

  discount = Column({ type: "decimal", minimum: 0, default: 0 });

  Place = Event({ input: { customerId: "uuid", coupon: optional("string") } });

  Cancel = Event();

  formatForLogs() {}
}

@ACL()
class PaymentGateway {
  Authorize = ACLEvent({
    input: { amount: "decimal" },
    results: {
      approved: success({ transactionId: "string" }),
      declined: fail({ code: "string", reason: optional("string") }),
    },
  });
}

@Entity()
class InvalidEntityEventOptions {
  // @ts-expect-error ACL result interpretations require @ACLEvent, not @Event.
  Authorize = Event({ results: { approved: success({}), declined: fail({}) } });
}

class InvalidEventMemberKind {
  // @ts-expect-error Event is a member factory, not a method decorator.
  @Event()
  Place() {}
}

class NonPublicEventMembers {
  static StaticPlace = Event();
  private PrivatePlace = Event();
  PublicPlace = Event();
}

const uuidColumn = Column({ type: "uuid" });
const uuidSemanticType: "uuid" = uuidColumn.semanticType;
// @ts-expect-error Column factories return semantic tokens, not application values.
const invalidUuidValue: number = uuidColumn;

eventRef(NonPublicEventMembers, "PublicPlace");

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

// Member existence and kind require AST provenance, so the static compiler is
// authoritative for these names; TypeScript validates the helper shape only.
field(Customer, "id");
reference(Order, "customerId");
eventRef(Order, "Place");
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
void uuidSemanticType;
void invalidUuidValue;
