import assert from "node:assert/strict";
import { compileModuleSource } from "../src/index.js";

export function phaseFourModule(dag = false) {
  const result = compileModuleSource({
    fileName: "sales.ts",
    sourceText: `
import { Entity, Column, Event, ACLEvent, ACL, View, Saga, Module, create, update, input, literal, field, eq, event, eventRef, success, fail } from "@lilka/vane";
@Entity()
class Order {
  id = Column({type: "uuid", identity: true});
  status = Column({type: "string"});
  Place = Event({input: {id: "uuid"}, operation: create({id: input("id"), status: literal("placed")})});
  Cancel = Event({input: {id: "uuid"}, operation: update(input("id"), {status: literal("cancelled")})});
  Complete = Event({input: {id: "uuid"}, operation: update(input("id"), {status: literal("complete")})});
}
@ACL()
class Gateway {
  Authorize = ACLEvent({input: {id: "uuid"}, results: {
    approved: success({reference: "string"}),
    declined: fail({})
  }});
}
@View({input: {id: "uuid"}, output: {id: field(Order, "id"), status: field(Order, "status")}, query: {root: Order, where: eq(field(Order, "id"), input("id"))}})
class Receipt {}
@Saga({input: {id: "uuid"}, steps: {
  place: event(Order, "Place", {compensateWith: eventRef(Order, "Cancel")}),
  ${dag ? 'branchA: event(Order, "Complete", {causedBy: ["place"], compensateWith: eventRef(Order, "Cancel")}), branchB: event(Order, "Complete", {causedBy: ["place"], compensateWith: eventRef(Order, "Cancel")}), authorize: event(Gateway, "Authorize", {causedBy: ["branchA", "branchB"]})' : 'authorize: event(Gateway, "Authorize", {causedBy: ["place"]}), complete: event(Order, "Complete", {causedBy: ["authorize"]})'}
}, terminal: {step: "${dag ? "authorize" : "complete"}", view: Receipt}})
class PlaceOrder {}
@Module({entities: [Order], antiCorruptionLayers: [Gateway], views: [Receipt], sagas: [PlaceOrder]})
class Sales {}
`,
  });
  assert.equal(result.success, true, JSON.stringify(result));
  if (!result.success) throw new Error("Fixture compilation failed");
  return result.ir.module;
}
