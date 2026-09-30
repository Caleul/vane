import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const fixture = new URL(
  "../fixtures/remaining-public-domain.ts",
  import.meta.url,
);
async function compiled(api, transform = (value) => value) {
  const source = transform(await readFile(fixture, "utf8"));
  const result = api.compileModuleSource({
    fileName: "remaining-public-domain.ts",
    sourceText: source,
  });
  assert.equal(result.success, true, JSON.stringify(result.diagnostics));
  return result.ir.module;
}
async function cleanup(...actions) {
  const errors = [];
  for (const action of actions) {
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(action),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error("Remaining-contract resource cleanup timed out"),
              ),
            5000,
          );
        }),
      ]);
    } catch (error) {
      errors.push(error);
    } finally {
      clearTimeout(timer);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, "Remaining-contract cleanup failed");
}
async function serviceConfig(api) {
  const module = await compiled(api);
  return api.serviceConfiguration({
    application: "remaining-contracts",
    project: {
      schema: "vane.semantic-project-ir",
      version: api.SEMANTIC_PROJECT_IR_VERSION,
      modules: [module],
    },
    providers: api.BUILTIN_PROVIDERS,
    profiles: {
      test: {
        environment: "test",
        topology: api.monolith({
          name: "explicit-library",
          modules: ["Library"],
          runtime: api.node(),
          persistence: {
            provider: api.postgres(),
            namespace: "remaining_contracts",
            targetVersion: 16,
            connection: api.env("UNRESOLVED_DATABASE"),
          },
        }),
        communication: {
          mailbox: api.postgresMailbox(),
          outbox: api.postgresOutbox(),
          deduplication: api.postgresDeduplication(),
          saga: api.postgresSaga(),
          failureQueue: api.postgresFailureQueue(),
        },
        http: {
          provider: api.http(),
          sagaStream: api.sse(),
          security: {
            authentication: "none",
            authorization: "allow",
            cors: [],
            rateLimit: null,
          },
        },
        acls: {
          "Library.Courier.Notify": {
            provider: api.httpAcl(),
            version: "1",
            endpoint: api.env("UNRESOLVED_COURIER"),
            idempotencyHeader: "Idempotency-Key",
            responses: [
              {
                status: 200,
                result: "accepted",
                fields: { receipt: "receipt" },
              },
              { status: 409, result: "rejected", fields: {} },
            ],
          },
        },
        contracts: {
          Library: { views: [{ view: "BookCard" }, { view: "ShelfTotal" }] },
        },
      },
    },
  });
}

async function withDatabase(context, action) {
  const { api, packageRoot, databaseUrl } = context;
  if (!databaseUrl)
    throw Object.assign(
      new Error("Real PostgreSQL is required for remaining public contracts"),
      { code: "CONFORMANCE_GAP" },
    );
  const { Pool } = createRequire(join(packageRoot, "package.json"))("pg");
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 8,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
  });
  const namespace = `vane_remaining_${randomUUID().replaceAll("-", "")}`;
  let runtime;
  let migrated = false;
  try {
    const module = await compiled(api);
    const version = await pool.query("SHOW server_version_num");
    context.postgresqlVersion = version.rows[0].server_version_num;
    assert.ok(Number(context.postgresqlVersion) >= 160000);
    const materialized = api.materializePostgreSql(
      {
        schema: "vane.semantic-project-ir",
        version: api.SEMANTIC_PROJECT_IR_VERSION,
        modules: [module],
      },
      { namespace, targetVersion: 16 },
    );
    assert.equal(
      materialized.success,
      true,
      JSON.stringify(materialized.diagnostics),
    );
    await api.applyPostgreSqlMigrationPlan(
      pool,
      api.createPostgreSqlMigrationPlan({
        previous: null,
        next: materialized.ir,
      }),
    );
    migrated = true;
    runtime = new api.PostgreSqlModuleRuntime({
      module,
      pool,
      storage: materialized.ir,
    });
    await runtime.start();
    const views = new api.PostgreSqlViewRuntime(module, pool, materialized.ir);
    const envelope = (identity, payload) =>
      api.createEventEnvelope({
        eventId: randomUUID(),
        eventIdentity: identity,
        occurredAt: new Date().toISOString(),
        payload,
      });
    return await action({ api, module, runtime, views, envelope });
  } finally {
    await cleanup(
      () => runtime?.stop(),
      () =>
        migrated ? pool.query(`DROP SCHEMA "${namespace}" CASCADE`) : undefined,
      () => pool.end(),
    );
  }
}
export const cases = [
  {
    id: "remaining.explicit-service-boundaries",
    requirements: ["EE-SVC-008"],
    kind: "negative",
    run: async ({ api }) => {
      const config = await serviceConfig(api);
      const result = api.compileServiceConfiguration(config, "test");
      assert.equal(result.success, true, JSON.stringify(result.diagnostics));
      assert.deepEqual(
        result.plan.infrastructure.services.map((service) => ({
          name: service.name,
          modules: service.modules,
        })),
        [{ name: "explicit-library", modules: ["Library"] }],
      );
      assert.deepEqual(result.plan.runtime.ownership, [
        { entity: "Library.Book", service: "explicit-library" },
        { entity: "Library.Shelf", service: "explicit-library" },
      ]);
      const missing = structuredClone(config);
      missing.profiles.test.topology = undefined;
      const rejected = api.compileServiceConfiguration(missing, "test");
      assert.equal(rejected.success, false);
      assert.equal("plan" in rejected, false);
      const omitted = structuredClone(config);
      omitted.profiles.test.topology.service.modules = [];
      assert.equal(
        api.compileServiceConfiguration(omitted, "test").success,
        false,
      );
      const invented = structuredClone(config);
      invented.profiles.test.topology.service.modules.push("InferredService");
      assert.equal(
        api.compileServiceConfiguration(invented, "test").success,
        false,
      );
      return "Only the declared service and exact Module/Entity ownership exist; missing topology/membership and invented Module boundary reject instead of creating services automatically.";
    },
  },
  {
    id: "remaining.generation-never-applies-remote",
    requirements: ["EE-SVC-032"],
    kind: "negative",
    run: async ({ api, cli }) => {
      const directory = await mkdtemp(join(tmpdir(), "vane-no-remote-"));
      try {
        const config = await serviceConfig(api);
        const configPath = join(directory, "config.mjs");
        const guard = join(directory, "deny-network.mjs");
        const attempts = join(directory, "network-attempts");
        await writeFile(
          configPath,
          `export default ${JSON.stringify(config)};\n`,
        );
        await writeFile(
          guard,
          `import net from 'node:net'; import {writeFileSync} from 'node:fs'; const deny=()=>{writeFileSync(${JSON.stringify(attempts)},'network attempted');throw new Error('Conformance network access forbidden');}; net.Socket.prototype.connect=deny; globalThis.fetch=deny;`,
        );
        const options = {
          env: { ...process.env, NODE_OPTIONS: `--import=${guard}` },
        };
        const generated = await cli(
          [
            "generate",
            "--config",
            configPath,
            "--profile",
            "test",
            "--out",
            join(directory, "output"),
            "--json",
          ],
          options,
        );
        assert.equal(generated.status, 0, generated.stderr);
        assert.equal(JSON.parse(generated.stdout).success, true);
        const deployment = JSON.parse(
          await readFile(join(directory, "output", "deploy-plan.json"), "utf8"),
        );
        const infrastructure = JSON.parse(
          await readFile(
            join(directory, "output", "infrastructure-ir.json"),
            "utf8",
          ),
        );
        assert.equal(deployment.apply, "manual");
        assert.equal(infrastructure.apply, "manual");
        for (const command of ["apply", "deploy", "cloud-apply"]) {
          const unsupported = await cli(
            [command, "--config", configPath, "--profile", "test"],
            options,
          );
          assert.equal(unsupported.status, 1);
          assert.match(unsupported.stderr, /Usage:/);
        }
        await assert.rejects(
          readFile(attempts),
          (error) => error.code === "ENOENT",
        );
        return "Installed CLI generates local deployment artifacts with networking denied and zero network attempts; both deployment/Infrastructure IR require manual apply, and remote apply/deploy commands are unsupported.";
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  },
  {
    id: "remaining.public-payload-inference",
    requirements: ["EE-NFR-002", "EE-PIVOT-001", "EE-PIVOT-002", "EE-VIEW-001"],
    kind: "positive",
    run: async ({ packageRoot }) => {
      const ts = createRequire(join(packageRoot, "package.json"))("typescript");
      const directory = await mkdtemp(
        join(resolve(packageRoot, "../../.."), "remaining-types-"),
      );
      try {
        const file = join(directory, "consumer.mts");
        const source = await readFile(
          new URL("../fixtures/service-public-inference.ts", import.meta.url),
          "utf8",
        );
        const options = {
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          experimentalDecorators: true,
          types: [],
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.NodeNext,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
        };
        const diagnostics = () =>
          ts.getPreEmitDiagnostics(ts.createProgram([file], options));
        await writeFile(file, source);
        assert.deepEqual(
          diagnostics().map((value) =>
            ts.flattenDiagnosticMessageText(value.messageText, "\n"),
          ),
          [],
        );
        await writeFile(
          file,
          source.replaceAll(/\/\/ @ts-expect-error[^\n]*\n/g, ""),
        );
        const invalid = diagnostics();
        assert.ok(
          invalid.length >= 20,
          "Negative input/output/provider/factory/operation assignments must be rejected",
        );
        assert.ok(
          invalid.every((value) => ![2307, 7016].includes(value.code)),
          "Module resolution failure must not masquerade as a negative fixture",
        );
        return "Installed TypeScript declarations infer exact Event/ACL inputs, optional fields, View input/row keys/nullability, all scalar types and nullable aggregates without any; opaque factories and every mutation/arithmetic operation have rejecting negative type examples.";
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  },
  {
    id: "remaining.named-view-static-provenance",
    requirements: ["EE-NFR-002", "EE-PIVOT-001"],
    kind: "negative",
    run: async ({ api }) => {
      const options = `{input:{id:"uuid"},output:{id:field(Book,"id"),title:field(Book,"title")},query:{root:Book}}`;
      const inline = `import {Entity,Column,View,Module,field} from "@lilka/vane";
        @Entity() class Book { id=Column({type:"uuid",identity:true}); title=Column({type:"string",nullable:true}); }
        @View(${options}) class Card {} @Module({entities:[Book],views:[Card]}) class Books {}`;
      const named = inline.replace(
        `@View(${options})`,
        `const CardContract = View(${options}); @CardContract`,
      );
      const compile = (sourceText) =>
        api.compileModuleSource({ fileName: "named-view.ts", sourceText });
      const result = compile(named);
      assert.equal(result.success, true, JSON.stringify(result.diagnostics));
      assert.deepEqual(result.ir, compile(inline).ir);
      for (const invalid of [
        named.replace("const CardContract", "let CardContract"),
        named.replace(
          "const CardContract",
          "const CardContract: ClassDecorator",
        ),
        named.replace("@CardContract", "const Alias = CardContract; @Alias"),
        named.replace(`View(${options})`, `(() => View(${options}))()`),
        named.replace('field(Book,"title")', 'field(Book,"missing")'),
        named.replace(
          'title=Column({type:"string",nullable:true});',
          'title!: Book["id"];',
        ),
      ]) {
        const rejected = compile(invalid);
        assert.equal(rejected.success, false);
        assert.equal("ir" in rejected, false);
      }
      return "Named local const View token preserves inline semantics; mutable/annotated/aliased/dynamic tokens and missing/copied-type members cannot bypass AST provenance.";
    },
  },
  {
    id: "remaining.saga-no-intermediate-return",
    requirements: ["EE-SAGA-006"],
    kind: "negative",
    run: async ({ api }) => {
      const module = await compiled(api);
      assert.deepEqual(
        module.sagas[0].steps.find((step) => step.name === "notify").causedBy,
        ["add"],
      );
      const source = await readFile(fixture, "utf8");
      for (const unsupported of [
        "await: true",
        'waitFor: "add"',
        'result: "intermediate"',
        'returns: "payload"',
      ]) {
        const result = api.compileModuleSource({
          fileName: "invalid-intermediate.ts",
          sourceText: source.replace(
            /causedBy:\s*\["add"\]/,
            `causedBy: ["add"], ${unsupported}`,
          ),
        });
        assert.equal(
          result.success,
          false,
          `${unsupported} must not define a Saga step`,
        );
        assert.equal("ir" in result, false);
        assert.ok(result.diagnostics.length);
      }
      return "One-way causal steps compile; awaited/waitFor/result/returns intermediate step declarations reject without Semantic IR.";
    },
  },
  {
    id: "remaining.event-terminal-outcomes",
    requirements: ["EE-EVT-003"],
    kind: "positive",
    run: (context) =>
      withDatabase(context, async ({ api, module, runtime, envelope }) => {
        const shelfId = randomUUID();
        const create = await runtime.dispatch(
          envelope("Shelf.Add", { id: shelfId, name: "terminal-shelf" }),
        );
        assert.equal(create.kind, "success");
        const bookId = randomUUID();
        assert.equal(
          (
            await runtime.dispatch(
              envelope("Book.Add", { id: bookId, shelfId, copies: 3 }),
            )
          ).kind,
          "success",
        );
        const rejected = await runtime.dispatch(
          envelope("Book.Invalid", { id: bookId }),
        );
        assert.equal(rejected.kind, "fail");
        assert.deepEqual(Object.keys(rejected.fail).sort(), [
          "code",
          "correlationId",
          "message",
        ]);
        const event = module.antiCorruptionLayers[0].events[0];
        for (const [interpretation, data, expected] of [
          ["accepted", { receipt: "internal-only" }, "success"],
          ["rejected", {}, "fail"],
          ["pending", {}, "fail"],
        ]) {
          const adapter = {
            eventIdentity: "Courier.Notify",
            version: "1",
            idempotency: "eventId",
            results: ["accepted", "rejected"],
            execute: async () => ({ result: interpretation, data }),
          };
          const result = await new api.AclEventRuntime(
            [event],
            [adapter],
          ).dispatch(envelope("Courier.Notify", { id: bookId }));
          assert.equal(result.kind, expected);
        }
        return "Real Entity persistence acceptance/rejection yields success/fail; ACL accepted/rejected interpretations do likewise and undeclared pending result fails.";
      }),
  },
  {
    id: "remaining.public-views-only",
    requirements: ["EE-VIEW-001", "EE-VIEW-007", "EE-VOC-002"],
    kind: "positive",
    run: (context) =>
      withDatabase(
        context,
        async ({ api, module, runtime, views, envelope }) => {
          const shelfId = randomUUID();
          const first = randomUUID();
          const second = randomUUID();
          assert.equal(
            (
              await runtime.dispatch(
                envelope("Shelf.Add", { id: shelfId, name: "Science" }),
              )
            ).kind,
            "success",
          );
          for (const [id, copies] of [
            [first, 3],
            [second, 7],
          ])
            assert.equal(
              (
                await runtime.dispatch(
                  envelope("Book.Add", { id, shelfId, copies }),
                )
              ).kind,
              "success",
            );
          const contract = api.materializeContract(module, {
            views: [{ view: "BookCard" }, { view: "ShelfTotal" }],
            events: [
              {
                event: "Book.Add",
                terminal: {
                  view: "BookCard",
                  input: { id: { kind: "eventInput", input: "id" } },
                },
              },
            ],
          });
          assert.equal(
            contract.success,
            true,
            JSON.stringify(contract.diagnostics),
          );
          const publicRuntime = new api.PublicHttpRuntime({
            contract: contract.ir,
            events: runtime,
            views,
            terminals: new api.InMemoryTerminalResultStore(),
          });
          const read = await publicRuntime.handle({
            method: "POST",
            path: "/views/BookCard",
            body: { id: first },
          });
          assert.equal(read.status, 200);
          assert.deepEqual(JSON.parse(read.body), [
            { id: first, copies: 3, shelf: "Science" },
          ]);
          const total = await publicRuntime.handle({
            method: "POST",
            path: "/views/ShelfTotal",
            body: { shelfId },
          });
          assert.equal(total.status, 200);
          assert.deepEqual(JSON.parse(total.body), [{ copies: 10 }]);
          assert.equal(
            (
              await publicRuntime.handle({
                method: "POST",
                path: "/views/BookCard",
                body: { id: 17 },
              })
            ).status,
            400,
          );
          assert.equal(
            (
              await publicRuntime.handle({
                method: "GET",
                path: "/entities/Book",
              })
            ).status,
            404,
          );
          const accepted = await publicRuntime.handle({
            method: "POST",
            path: "/events/Book.Add",
            body: { id: randomUUID(), shelfId, copies: 2 },
          });
          assert.equal(accepted.status, 202);
          assert.deepEqual(Object.keys(JSON.parse(accepted.body)), ["sagaId"]);
          const stream = await publicRuntime.handle({
            method: "GET",
            path: `/sagas/${JSON.parse(accepted.body).sagaId}`,
            signal: AbortSignal.timeout(3000),
          });
          assert.equal(stream.status, 200);
          assert.equal(stream.body.split("event: ").length, 2);
          assert.match(stream.body, /^event: view\ndata: /);
          const result = JSON.parse(stream.body.split("data: ")[1]);
          assert.equal(result.kind, "view");
          assert.equal(result.view, "BookCard");
          assert.deepEqual(Object.keys(result.data[0]).sort(), [
            "copies",
            "id",
            "shelf",
          ]);
          for (const raw of ["Book", "Courier", "EntityDTO", "progress"]) {
            const invalid = api.materializeContract(module, {
              events: [{ event: "Book.Add", terminal: { view: raw } }],
            });
            assert.equal(invalid.success, false);
            assert.equal("ir" in invalid, false);
          }
          return "Persisted relations and sum produce deterministic typed public Views; malformed View input and direct Entity route reject; Event admission reveals only sagaId and success SSE only a View; Entity/ACL/DTO/progress terminal substitutes reject.";
        },
      ),
  },
];
