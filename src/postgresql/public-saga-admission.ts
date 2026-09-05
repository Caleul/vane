import type { ContractEventOperation } from "../contract-ir.js";
import type { DurablePublicEventAdmission } from "../http-runtime.js";
import type { SagaPlan } from "../saga-plan.js";
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
    readonly handlesStandalone = false,
  ) {
    this.#bindings = new Map(
      Object.entries(bindings).map(([event, plan]) => [
        event,
        structuredClone(plan),
      ]),
    );
  }
  validateOperation(operation: ContractEventOperation): void {
    const plan = this.#bindings.get(operation.identity);
    const roots =
      plan?.steps.filter((step) => step.causedBy.length === 0) ?? [];
    if (
      !plan ||
      roots.length !== 1 ||
      roots[0]?.event !== operation.identity ||
      roots[0].ownerKind !== operation.ownerKind ||
      (operation.saga !== undefined
        ? plan.saga !== operation.saga
        : plan.steps.length !== 1) ||
      plan.terminal.view !== operation.terminal.view
    )
      throw new SagaStateError(
        "Public Event does not match its declared Saga plan.",
      );
    const rootBinding = Object.fromEntries(
      operation.input.map((field) => [
        field.name,
        { kind: "input", name: field.name },
      ]),
    );
    if (canonicalJson(rootBinding) !== canonicalJson(roots[0].input))
      throw new SagaStateError(
        "Public root binding differs from the Saga plan.",
      );
    const input = operation.input.map(({ name, type, optional }) => ({
      name,
      type,
      optional,
    }));
    if (
      canonicalJson(input) !==
      canonicalJson(plan.input.map((field) => ({ ...field })))
    )
      throw new SagaStateError(
        "Public input contract differs from the Saga plan.",
      );
    const terminalBinding = Object.fromEntries(
      Object.entries(operation.terminal.input).map(([name, source]) => [
        name,
        source.kind === "eventInput"
          ? { kind: "input", name: source.input }
          : source,
      ]),
    );
    if (canonicalJson(terminalBinding) !== canonicalJson(plan.terminal.input))
      throw new SagaStateError(
        "Public terminal binding differs from the Saga plan.",
      );
  }

  async admitPublic(
    operation: ContractEventOperation,
    envelope: EventEnvelope,
  ): Promise<void> {
    this.validateOperation(operation);
    assertValidEventEnvelope(envelope);
    if (envelope.eventIdentity !== operation.identity || !envelope.sagaId)
      throw new SagaStateError(
        "Public Event envelope does not match the contract.",
      );
    const plan = this.#bindings.get(operation.identity) as SagaPlan;
    await this.runtime.admit(plan, envelope.payload, {
      sagaId: envelope.sagaId,
      eventId: envelope.eventId,
      correlationId: envelope.correlationId,
      occurredAt: envelope.occurredAt,
    });
  }
}
