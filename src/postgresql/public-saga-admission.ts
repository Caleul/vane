import type { ContractEventOperation } from "../contract-ir.js";
import type { DurablePublicEventAdmission } from "../http-runtime.js";
import { type SagaPlan, bindSagaInput } from "../saga-plan.js";
import {
  type EventEnvelope,
  assertValidEventEnvelope,
  canonicalJson,
} from "./envelope.js";
import { type PostgreSqlSagaRuntime, SagaStateError } from "./saga-runtime.js";

/** Explicit association between public Events and installed orchestration plans. */
export class PostgreSqlPublicSagaAdmission
  implements DurablePublicEventAdmission
{
  readonly #bindings: ReadonlyMap<string, SagaPlan>;
  constructor(
    readonly runtime: PostgreSqlSagaRuntime,
    bindings: Readonly<Record<string, SagaPlan>>,
  ) {
    this.#bindings = new Map(
      Object.entries(bindings).map(([event, plan]) => [
        event,
        structuredClone(plan),
      ]),
    );
  }
  async admitPublic(
    operation: ContractEventOperation,
    envelope: EventEnvelope,
  ): Promise<void> {
    assertValidEventEnvelope(envelope);
    if (envelope.eventIdentity !== operation.identity)
      throw new SagaStateError(
        "Public Event envelope identity differs from the contract.",
      );
    const plan = this.#bindings.get(operation.identity);
    const roots =
      plan?.steps.filter((step) => step.causedBy.length === 0) ?? [];
    if (
      !plan ||
      roots.length !== 1 ||
      roots[0]?.event !== operation.identity ||
      (operation.saga !== undefined && plan.saga !== operation.saga) ||
      plan.terminal.view !== operation.terminal.view ||
      !envelope.sagaId ||
      canonicalJson(bindSagaInput(roots[0].input, envelope.payload)) !==
        canonicalJson(envelope.payload)
    )
      throw new SagaStateError(
        "Public Event does not match its durable Saga plan.",
      );
    const terminalInput = Object.fromEntries(
      Object.entries(operation.terminal.input).flatMap(([name, source]) => {
        const value =
          source.kind === "eventInput"
            ? envelope.payload[source.input]
            : source.value;
        return value === undefined ? [] : [[name, value]];
      }),
    );
    if (
      canonicalJson(terminalInput) !==
      canonicalJson(bindSagaInput(plan.terminal.input, envelope.payload))
    )
      throw new SagaStateError(
        "Public terminal binding differs from the Saga plan.",
      );
    await this.runtime.admit(plan, envelope.payload, {
      sagaId: envelope.sagaId,
      eventId: envelope.eventId,
      correlationId: envelope.correlationId,
      occurredAt: envelope.occurredAt,
    });
  }
}
