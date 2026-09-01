import {
  type ContractMaterializerConfiguration,
  InMemoryTerminalResultStore,
  type PostgreSqlPoolLike,
  type PostgreSqlStorageIr,
  PostgreSqlViewRuntime,
  PublicHttpRuntime,
  type SemanticModule,
  generateOpenApi,
  materializeContract,
  serializeContractIr,
  serializeOpenApi,
} from "../src/index.js";

declare const module: SemanticModule;
declare const pool: PostgreSqlPoolLike;
declare const storage: PostgreSqlStorageIr;

const configuration = {
  basePath: "/api",
  views: [{ view: "OrderDetails" }],
  events: [
    {
      event: "Order.Place",
      terminal: {
        view: "OrderDetails",
        input: { id: { kind: "eventInput", input: "id" } },
      },
    },
  ],
} satisfies ContractMaterializerConfiguration;

const contract = materializeContract(module, configuration);
if (contract.success) {
  serializeContractIr(contract.ir);
  serializeOpenApi(generateOpenApi(contract.ir));
  const views = new PostgreSqlViewRuntime(module, pool, storage);
  new PublicHttpRuntime({
    contract: contract.ir,
    events: {
      dispatch: async () => ({ kind: "success", eventId: "id", revision: "1" }),
    },
    views,
    terminals: new InMemoryTerminalResultStore(),
  });
}

materializeContract(module, {
  events: [
    {
      event: "Order.Place",
      terminal: {
        view: "OrderDetails",
        input: {
          id: {
            // @ts-expect-error terminal mappings use only eventInput or literal.
            kind: "callback",
          },
        },
      },
    },
  ],
});
