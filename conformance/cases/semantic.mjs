import assert from "node:assert/strict";

// These fixtures are authored for the normative suite, independent of test/.
export function domain() {
  return {
    name: "Calendar",
    entities: [
      {
        name: "Booking",
        columns: [
          { name: "id", type: "uuid", identity: true, generated: "uuid" },
          { name: "starts", type: "integer" },
          { name: "ends", type: "integer" },
        ],
        rules: [
          {
            name: "Ordered",
            expression: {
              kind: "comparison",
              operator: "gt",
              left: { kind: "column", column: "ends" },
              right: { kind: "column", column: "starts" },
            },
          },
        ],
        events: [
          {
            name: "Reserve",
            input: [
              { name: "starts", type: "integer" },
              { name: "ends", type: "integer" },
            ],
            operation: {
              kind: "create",
              values: [
                { column: "starts", value: { kind: "input", input: "starts" } },
                { column: "ends", value: { kind: "input", input: "ends" } },
              ],
            },
          },
        ],
      },
    ],
  };
}
export function compiled(api, declaration = domain()) {
  const result = api.compileSemanticIr(declaration);
  assert.equal(result.success, true, JSON.stringify(result.diagnostics));
  return result.ir;
}
function reject(api, declaration, code) {
  const result = api.compileSemanticIr(declaration);
  assert.equal(result.success, false, "Invalid declaration must be rejected");
  assert.equal(
    "ir" in result,
    false,
    "Rejected input must not expose partial IR",
  );
  assert.ok(result.diagnostics.length > 0);
  if (code)
    assert.ok(
      result.diagnostics.some((d) => d.code === code),
      JSON.stringify(result.diagnostics),
    );
  for (const diagnostic of result.diagnostics) {
    assert.equal(typeof diagnostic.code, "string");
    assert.ok(diagnostic.code.length);
    assert.ok(Array.isArray(diagnostic.path));
    assert.ok(diagnostic.message.length);
    assert.ok(diagnostic.correction.length);
  }
  return `Rejected with ${result.diagnostics.map((d) => d.code).join(", ")}; no partial IR`;
}
function negative(id, requirements, mutate, code) {
  return {
    id,
    requirements,
    kind: "negative",
    run: ({ api }) => {
      const declaration = domain();
      mutate(declaration);
      return reject(api, declaration, code);
    },
  };
}
export const cases = [
  {
    id: "semantic.owner-event",
    requirements: ["EE-ENT-005", "EE-EVT-001", "EE-EVT-013", "EE-COMP-001"],
    kind: "positive",
    run: ({ api }) => {
      const ir = compiled(api);
      const event = ir.module.entities[0].events[0];
      assert.equal(event.identity, "Booking.Reserve");
      assert.deepEqual(event.owner, { kind: "entity", entity: "Booking" });
      assert.deepEqual(event.persistence, { target: "owner", required: true });
      assert.equal(event.operation.kind, "create");
      assert.deepEqual(
        [...event.operation.values].sort((a, b) =>
          a.column.localeCompare(b.column),
        ),
        [...domain().entities[0].events[0].operation.values].sort((a, b) =>
          a.column.localeCompare(b.column),
        ),
      );
      assert.equal(ir.module.name, "Calendar");
      return "Provider-free compilation exposes Booking.Reserve, owner-only persistence and the declared operation AST";
    },
  },
  {
    id: "semantic.determinism",
    requirements: ["EE-MOD-004", "EE-COMP-002"],
    kind: "positive",
    run: ({ api }) => {
      const input = domain();
      const reordered = structuredClone(input);
      reordered.entities[0].columns.reverse();
      reordered.entities[0].events[0].input.reverse();
      const first = compiled(api, input);
      const second = compiled(api, reordered);
      assert.equal(typeof first.version, "number");
      assert.ok(first.version > 0);
      assert.ok(first.schema);
      assert.equal(
        api.serializeSemanticIr(first),
        api.serializeSemanticIr(second),
      );
      assert.deepEqual(JSON.parse(api.serializeSemanticIr(first)), first);
      return "Equivalent declaration orders produce byte-identical, versioned, JSON-roundtrippable Semantic IR";
    },
  },
  negative(
    "semantic.identity-missing",
    ["EE-ENT-002", "EE-COMP-003"],
    (d) => {
      d.entities[0].columns[0].identity = false;
    },
    "VANE_SEM_ENTITY_IDENTITY",
  ),
  negative(
    "semantic.identity-composite",
    ["EE-ENT-002", "EE-COMP-003"],
    (d) => {
      d.entities[0].columns[1].identity = true;
    },
    "VANE_SEM_ENTITY_IDENTITY",
  ),
  negative("semantic.entity-duplicate", ["EE-ENT-001", "EE-MOD-003"], (d) => {
    d.entities.push(structuredClone(d.entities[0]));
  }),
  negative(
    "semantic.rule-single-column",
    ["EE-RUL-001", "EE-RUL-005"],
    (d) => {
      d.entities[0].rules[0].expression.right = { kind: "literal", value: 0 };
    },
    "VANE_SEM_RULE_ARITY",
  ),
  negative("semantic.rule-foreign-column", ["EE-RUL-002"], (d) => {
    d.entities.push({
      name: "Other",
      columns: [
        { name: "id", type: "uuid", identity: true },
        { name: "foreign", type: "integer" },
      ],
    });
    d.entities[0].rules[0].expression.right = {
      kind: "column",
      column: "Other.foreign",
    };
  }),
  {
    id: "semantic.operation-missing",
    requirements: ["EE-EVT-002", "EE-EVT-013"],
    kind: "negative",
    run: ({ api }) => {
      const result = api.compileModuleSource({
        fileName: "missing-operation.ts",
        sourceText: `import {Entity,Module,Column,Event} from "@lilka/vane"; @Entity() class Note { id=Column({type:"uuid",identity:true}); Add=Event({}); } @Module({entities:[Note]}) class Notes {}`,
      });
      assert.equal(result.success, false);
      assert.equal("ir" in result, false);
      return "Public source DSL rejects Entity Event without a persistent operation";
    },
  },
  negative(
    "semantic.operation-foreign-target",
    ["EE-EVT-005", "EE-EVT-016", "EE-COMP-003"],
    (d) => {
      d.entities[0].events[0].operation.values[0].column = "Other.starts";
    },
  ),
  negative(
    "semantic.operation-unknown-input",
    ["EE-EVT-016", "EE-COMP-003"],
    (d) => {
      d.entities[0].events[0].operation.values[0].value.input = "unknown";
    },
  ),
  negative(
    "semantic.operation-wrong-type",
    ["EE-EVT-016", "EE-COMP-003"],
    (d) => {
      d.entities[0].events[0].operation.values[0].value = {
        kind: "literal",
        value: "wrong",
      };
    },
  ),
  {
    id: "semantic.operation-open-expression",
    requirements: ["EE-EVT-015"],
    kind: "negative",
    run: ({ api }) => {
      const result = api.compileModuleSource({
        fileName: "callback-operation.ts",
        sourceText: `import {Entity,Module,Column,Event,create} from "@lilka/vane"; @Entity() class Note { id=Column({type:"uuid",identity:true}); Add=Event({operation:create({id: ()=>"callback"})}); } @Module({entities:[Note]}) class Notes {}`,
      });
      assert.equal(result.success, false);
      assert.equal("ir" in result, false);
      return "Public DSL rejects callback expressions outside the closed operation AST";
    },
  },
  negative("semantic.column-contradiction", ["EE-COL-005"], (d) => {
    d.entities[0].columns[0].nullable = true;
  }),
  {
    id: "semantic.column-reference",
    requirements: ["EE-COL-003", "EE-COMP-003"],
    kind: "positive",
    run: ({ api }) => {
      const d = domain();
      d.entities.push({
        name: "Guest",
        columns: [{ name: "id", type: "uuid", identity: true }],
      });
      d.entities[0].columns.push({
        name: "guest",
        type: "uuid",
        references: { entity: "Guest", column: "id" },
        nullable: true,
      });
      const ir = compiled(api, d);
      assert.deepEqual(
        ir.module.entities
          .find((e) => e.name === "Booking")
          .columns.find((c) => c.name === "guest").references,
        { entity: "Guest", column: "id" },
      );
      d.entities[0].columns.at(-1).type = "integer";
      reject(api, d);
      return "Typed reference is retained; incompatible foreign-key type is rejected";
    },
  },
  {
    id: "semantic.imports",
    requirements: ["EE-MOD-002", "EE-MOD-003"],
    kind: "positive",
    run: ({ api }) => {
      const result = api.compileSemanticProject([
        { name: "Shared", entities: [] },
        { ...domain(), imports: ["Shared"] },
      ]);
      assert.equal(result.success, true, JSON.stringify(result.diagnostics));
      assert.deepEqual(
        result.ir.modules.find((m) => m.name === "Calendar").imports,
        ["Shared"],
      );
      const invalid = api.compileSemanticProject([
        { ...domain(), imports: ["Absent"] },
      ]);
      assert.equal(invalid.success, false);
      assert.equal("ir" in invalid, false);
      return "Explicit import preserved; missing imported Module rejected without partial project IR";
    },
  },
  {
    id: "semantic.operation-kinds",
    requirements: ["EE-EVT-014", "EE-EVT-015"],
    kind: "positive",
    run: ({ api }) => {
      for (const kind of ["create", "update", "delete", "upsert"]) {
        const d = domain();
        if (kind === "upsert")
          d.entities[0].columns[0] = {
            name: "id",
            type: "uuid",
            identity: true,
          };
        const e = d.entities[0].events[0];
        e.input.push({ name: "id", type: "uuid" });
        e.operation = {
          kind,
          ...(kind !== "create"
            ? { identity: { kind: "input", input: "id" } }
            : {}),
          ...(kind !== "delete"
            ? {
                values:
                  kind === "update"
                    ? [
                        {
                          column: "starts",
                          value: {
                            kind: "arithmetic",
                            operator: "add",
                            left: { kind: "column", column: "starts" },
                            right: { kind: "literal", value: 1 },
                          },
                        },
                      ]
                    : e.operation.values,
              }
            : {}),
        };
        assert.equal(
          compiled(api, d).module.entities[0].events[0].operation.kind,
          kind,
        );
      }
      return "create/update/delete/upsert accepted on owner identity; typed input/literal/current-Column arithmetic represented in update";
    },
  },
  {
    id: "semantic.public-dsl",
    requirements: ["EE-MOD-005"],
    kind: "positive",
    run: ({ api }) => {
      const source = `import { Entity, Module, Column, Event, create } from "@lilka/vane";
      @Entity() class Note { id = Column({type:"uuid",identity:true,generated:"uuid"}); Add = Event({operation:create({})}); }
      @Module({entities:[Note]}) class Notes {}`;
      const result = api.compileModuleSource({
        fileName: "notes.vane.ts",
        sourceText: source,
      });
      assert.equal(result.success, true, JSON.stringify(result.diagnostics));
      assert.equal(result.ir.module.name, "Notes");
      const absent = api.compileModuleSource({
        fileName: "missing.vane.ts",
        sourceText: source.replace(
          "@Module({entities:[Note]}) class Notes {}",
          "",
        ),
      });
      assert.equal(absent.success, false);
      return "Public member-factory DSL compiles only with an explicitly declared Module";
    },
  },
];
