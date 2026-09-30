import assert from "node:assert/strict";
import { domain, compiled } from "./semantic.mjs";

function graph() {
  const d = domain();
  d.views = [
    {
      name: "Details",
      input: [{ name: "id", type: "uuid" }],
      output: [
        {
          name: "id",
          expression: { kind: "column", entity: "Booking", column: "id" },
        },
      ],
      query: {
        root: "Booking",
        where: {
          kind: "comparison",
          operator: "eq",
          left: { kind: "column", entity: "Booking", column: "id" },
          right: { kind: "input", input: "id" },
        },
      },
    },
  ];
  d.antiCorruptionLayers = [
    {
      name: "Notifier",
      events: [
        {
          name: "Send",
          input: [{ name: "message", type: "string" }],
          results: [
            { name: "sent", outcome: "success", data: [] },
            { name: "refused", outcome: "fail", data: [] },
          ],
        },
      ],
    },
  ];
  d.sagas = [
    {
      name: "ReserveAndNotify",
      input: [],
      steps: [
        {
          name: "reserve",
          event: { owner: "Booking", event: "Reserve" },
          causedBy: [],
          compensateWith: { owner: "Notifier", event: "Send" },
        },
        {
          name: "notify",
          event: { owner: "Notifier", event: "Send" },
          causedBy: ["reserve"],
        },
      ],
      terminal: { step: "notify", view: "Details" },
    },
  ];
  return d;
}
function rejection(api, d) {
  const result = api.compileSemanticIr(d);
  assert.equal(result.success, false, JSON.stringify(result));
  assert.equal("ir" in result, false);
  assert.ok(result.diagnostics.length);
  return result.diagnostics.map((d) => d.code).join(", ");
}
function sourceReject(api, extra, owner = "Event") {
  const source = `import {Entity,Module,Column,Event,create} from "@lilka/vane"; @Entity() class Note {id=Column({type:"uuid",identity:true,generated:"uuid"}); Add=${owner}({operation:create({}),${extra}});} @Module({entities:[Note]}) class Notes {}`;
  const result = api.compileModuleSource({
    fileName: "technical-policy.ts",
    sourceText: source,
  });
  assert.equal(result.success, false);
  assert.equal("ir" in result, false);
}
export const cases = [
  {
    id: "causality.composed-domain",
    requirements: ["EE-MOD-001", "EE-ACL-001", "EE-ACL-002", "EE-EVT-001"],
    kind: "positive",
    run: ({ api }) => {
      const ir = compiled(api, graph());
      assert.equal(ir.module.entities.length, 1);
      assert.equal(ir.module.views.length, 1);
      assert.equal(ir.module.antiCorruptionLayers.length, 1);
      assert.equal(ir.module.sagas.length, 1);
      assert.equal(
        ir.module.antiCorruptionLayers[0].events[0].identity,
        "Notifier.Send",
      );
      const d = graph();
      d.antiCorruptionLayers.push(structuredClone(d.antiCorruptionLayers[0]));
      rejection(api, d);
      return "Explicit Module composes Entity/View/ACL/Saga; ACL owns stable Notifier.Send identity; duplicate ACL rejected";
    },
  },
  {
    id: "causality.dag-validation",
    requirements: ["EE-SAGA-001", "EE-SAGA-002", "EE-EVT-012", "EE-COMP-003"],
    kind: "negative",
    run: ({ api }) => {
      compiled(api, graph());
      const cycle = graph();
      cycle.sagas[0].steps[0].causedBy = ["notify"];
      rejection(api, cycle);
      const missing = graph();
      missing.sagas[0].steps[1].event.event = "Absent";
      rejection(api, missing);
      const missingCompensation = graph();
      missingCompensation.sagas[0].steps[0].compensateWith.event = "Absent";
      rejection(api, missingCompensation);
      return "Valid linear DAG and compensation reference accepted; causal cycle, missing Event and missing compensation Event rejected";
    },
  },
  {
    id: "semantic.technical-policy-rejection",
    requirements: ["EE-EVT-011", "EE-SVC-021"],
    kind: "negative",
    run: ({ api }) => {
      for (const setting of [
        "retry:3",
        "timeout:1000",
        "transport:'http'",
        "provider:'node'",
      ])
        sourceReject(api, setting);
      return "Source compiler rejects retry, timeout, transport and provider in semantic Entity Event";
    },
  },
  {
    id: "view.query-required",
    requirements: ["EE-VIEW-002", "EE-COMP-003"],
    kind: "negative",
    run: ({ api }) => {
      const result = api.compileModuleSource({
        fileName: "queryless.ts",
        sourceText: `import {Entity,Module,Column,View,field} from "@lilka/vane"; @Entity() class Note {id=Column({type:"uuid",identity:true});} @View({input:{},output:{id:field(Note,"id")}}) class Detail {} @Module({entities:[Note],views:[Detail]}) class Notes {}`,
      });
      assert.equal(result.success, false);
      assert.equal("ir" in result, false);
      compiled(api, graph());
      return "View requires its own query; no queryless public View is accepted";
    },
  },
  {
    id: "view.persistence-rejected",
    requirements: ["EE-VIEW-003", "EE-COMP-003"],
    kind: "negative",
    run: ({ api }) => {
      const result = api.compileModuleSource({
        fileName: "persistent-view.ts",
        sourceText: `import {Entity,Module,Column,View,field,create} from "@lilka/vane"; @Entity() class Note {id=Column({type:"uuid",identity:true});} @View({input:{},output:{id:field(Note,"id")},query:{root:Note},operation:create({})}) class Detail {} @Module({entities:[Note],views:[Detail]}) class Notes {}`,
      });
      assert.equal(result.success, false);
      assert.equal("ir" in result, false);
      return "View declaration rejects persistent operation";
    },
  },
  {
    id: "view.reference-validation",
    requirements: ["EE-VIEW-005", "EE-COMP-003"],
    kind: "negative",
    run: ({ api }) => {
      compiled(api, graph());
      for (const field of ["entity", "column"]) {
        const d = graph();
        d.views[0].output[0].expression[field] = "Absent";
        rejection(api, d);
      }
      return "View known references accepted; missing Entity and Column rejected";
    },
  },
  {
    id: "semantic.column-contradictions",
    requirements: ["EE-COL-005"],
    kind: "negative",
    run: ({ api }) => {
      for (const extra of [
        { type: "string", minLength: 5, maxLength: 1 },
        { type: "integer", minimum: 4, maximum: 1 },
        { type: "integer", generated: "uuid" },
        {
          type: "uuid",
          generated: "uuid",
          default: "b0378340-4c59-46e8-98a4-397d73a6d2f3",
        },
      ]) {
        const d = domain();
        d.entities[0].columns.push({ name: "broken", ...extra });
        rejection(api, d);
      }
      return "String/numeric inverted bounds, incompatible generator and simultaneous generation/default rejected";
    },
  },
  {
    id: "semantic.invalid-operation-identity",
    requirements: ["EE-EVT-016"],
    kind: "negative",
    run: ({ api }) => {
      const d = domain();
      d.entities[0].events[0].operation = {
        kind: "delete",
        identity: { kind: "literal", value: 42 },
      };
      rejection(api, d);
      return "Non-UUID operation identity rejected before materialization without partial IR";
    },
  },
];

cases.push({
  id: "acl.technical-settings-rejected",
  requirements: ["EE-ACL-004"],
  kind: "negative",
  run: ({ api }) => {
    for (const setting of [
      "endpoint:'https://example.invalid'",
      "protocol:'http'",
      "credential:'fake'",
      "serialization:'json'",
      "timeout:1000",
      "retry:3",
      "idempotency:'required'",
    ]) {
      const result = api.compileModuleSource({
        fileName: "technical-acl.ts",
        sourceText: `import {ACL,ACLEvent,Module,success,fail} from "@lilka/vane"; @ACL() class Gateway { Send=ACLEvent({input:{},results:{sent:success({}),rejected:fail({})},${setting}}); } @Module({antiCorruptionLayers:[Gateway]}) class Integration {}`,
      });
      assert.equal(result.success, false);
      assert.equal("ir" in result, false);
    }
    return "ACL Event semantic DSL rejects endpoint, protocol, credentials, serialization, timeout, retry and idempotency settings";
  },
});
cases.push({
  id: "semantic.pivot-member-shapes",
  requirements: ["EE-PIVOT-001"],
  kind: "negative",
  run: ({ api }) => {
    const valid = `import {Entity,Column,Module} from "@lilka/vane"; @Entity() class Item { id = Column({type:"uuid",identity:true}); } @Module({entities:[Item]}) class Inventory {}`;
    assert.equal(
      api.compileModuleSource({
        fileName: "valid-member.ts",
        sourceText: valid,
      }).success,
      true,
    );
    for (const declaration of [
      'id: string = Column({type:"uuid",identity:true});',
      'static id = Column({type:"uuid",identity:true});',
      'private id = Column({type:"uuid",identity:true});',
      '@Column({type:"uuid",identity:true}) id!: string;',
      '@Column({type:"uuid",identity:true}) id = Column({type:"uuid",identity:true});',
    ]) {
      const result = api.compileModuleSource({
        fileName: "invalid-member.ts",
        sourceText: valid.replace(
          'id = Column({type:"uuid",identity:true});',
          declaration,
        ),
      });
      assert.equal(result.success, false);
      assert.equal("ir" in result, false);
    }
    return "Public instance member factory accepted; explicit annotation, static/private member, legacy decorator and hybrid forms rejected";
  },
});

cases.push({
  id: "semantic.duplicate-name-matrix",
  requirements: ["EE-MOD-003"],
  kind: "negative",
  run: ({ api }) => {
    for (const path of [
      ["entities"],
      ["views"],
      ["sagas"],
      ["antiCorruptionLayers"],
      ["entities", 0, "events"],
      ["antiCorruptionLayers", 0, "events"],
    ]) {
      const d = graph();
      let list = d;
      for (const key of path) list = list[key];
      list.push(structuredClone(list[0]));
      rejection(api, d);
    }
    const result = api.compileSemanticProject([graph(), graph()]);
    assert.equal(result.success, false);
    assert.equal("ir" in result, false);
    return "Duplicate Entity/View/Saga/ACL names, owner Event names and Module names reject; complementary cases cover missing imports/Columns/Events/compensation";
  },
});
cases.push({
  id: "semantic.copied-and-wrong-kind-references",
  requirements: ["EE-PIVOT-001"],
  kind: "negative",
  run: ({ api }) => {
    for (const member of [
      'id = "ordinary";',
      "id: typeof other = other;",
      "id = Event({operation:create({})});",
    ]) {
      const source = `import {Entity,Column,Event,create,Module,View,field} from "@lilka/vane"; const other=Column({type:"uuid",identity:true}); @Entity() class Record {key=Column({type:"uuid",identity:true});${member}} @View({input:{},output:{value:field(Record,"id")},query:{root:Record}}) class Detail {} @Module({entities:[Record],views:[Detail]}) class Records {}`;
      const result = api.compileModuleSource({
        fileName: "forged-reference.ts",
        sourceText: source,
      });
      assert.equal(result.success, false);
      assert.equal("ir" in result, false);
    }
    return "View field rejects ordinary property, copied typeof initializer and wrong-kind Event member rather than trusting structural types";
  },
});

cases.push({
  id: "semantic.exact-operation-and-input",
  requirements: ["EE-EVT-002", "EE-PIVOT-002"],
  kind: "negative",
  run: ({ api }) => {
    const prefix = `import {Entity,Column,Event,create,remove,input,Module} from "@lilka/vane"; @Entity() class Record {id=Column({type:"uuid",identity:true}); Add=Event(`;
    const suffix = ");} @Module({entities:[Record]}) class Records {}";
    for (const options of [
      '{input:{id:"uuid"},operation:create({id:input("id")}),operation:remove(input("id"))}',
      '{input:{id:"unsupported"},operation:create({id:input("id")})}',
    ]) {
      const result = api.compileModuleSource({
        fileName: "invalid-event.ts",
        sourceText: prefix + options + suffix,
      });
      assert.equal(result.success, false);
      assert.equal("ir" in result, false);
    }
    const d = domain();
    d.entities[0].events[0].input.push({ name: "id", type: "uuid" });
    d.entities[0].events[0].operation = {
      kind: "update",
      identity: { kind: "input", input: "id" },
      values: [{ column: "id", value: { kind: "input", input: "id" } }],
    };
    rejection(api, d);
    return "Duplicate persistent operation and unknown input type rejected by public DSL; updating owner identity is rejected before materialization";
  },
});

cases.push({
  id: "semantic.ontology-and-event-owners",
  requirements: ["EE-SEM-001", "EE-VOC-001"],
  kind: "positive",
  run: ({ api }) => {
    const ir = compiled(api, graph());
    const module = ir.module;
    assert.equal(module.name, "Calendar");
    assert.equal(module.entities[0].columns.length, 3);
    assert.equal(module.entities[0].rules.length, 1);
    assert.equal(module.entities[0].events[0].owner.kind, "entity");
    assert.equal(module.views[0].name, "Details");
    assert.ok(module.views[0].query);
    assert.equal(
      module.antiCorruptionLayers[0].events[0].owner.kind,
      "antiCorruptionLayer",
    );
    assert.equal(module.sagas[0].name, "ReserveAndNotify");
    const result = api.compileModuleSource({
      fileName: "nonowner-event.ts",
      sourceText: `import {Entity,Column,Module,View,field,Event,create} from "@lilka/vane"; @Entity() class Entry {id=Column({type:"uuid",identity:true});} @View({input:{},output:{id:field(Entry,"id")},query:{root:Entry}}) class Card { Save=Event({operation:create({})}); } @Module({entities:[Entry],views:[Card]}) class Entries {}`,
    });
    assert.equal(result.success, false);
    assert.equal("ir" in result, false);
    const serialized = api.serializeSemanticIr(ir);
    for (const key of [
      '"retry"',
      '"timeoutMs"',
      '"endpoint"',
      '"credential"',
      '"provider"',
    ])
      assert.ok(!serialized.includes(key));
    return "Public Semantic IR represents Module,Entity,Columns,Rule,Entity/ACL Events,View/query and Saga without technical policies; View cannot own an Event";
  },
});
