import assert from "node:assert/strict";
import test from "node:test";
import { compileModuleSource } from "../src/index.js";

const options = `{ input: { id: "uuid" }, output: { id: field(Book,"id"), title: field(Book,"title") }, query: { root: Book } }`;
const source = `import {Entity,Column,View,Module,field} from "@lilka/vane";
@Entity() class Book { id=Column({type:"uuid",identity:true}); title=Column({type:"string",nullable:true}); }
const CardContract = View(${options});
@CardContract class Card {}
@Module({entities:[Book],views:[Card]}) class Books {}`;
function compile(sourceText: string) {
  return compileModuleSource({ fileName: "named-view.ts", sourceText });
}
test("a named local View const preserves the exact inline semantic declaration", () => {
  const named = compile(source);
  const inline = compile(
    source
      .replace(`const CardContract = View(${options});`, "")
      .replace("@CardContract", `@View(${options})`),
  );
  assert.equal(named.success, true, JSON.stringify(named));
  assert.deepEqual(named, inline);
});
test("named View resolution remains static, local, immutable and non-evaluating", () => {
  const invalid = [
    source.replace("const CardContract", "let CardContract"),
    source.replace("const CardContract", "var CardContract"),
    source.replace("const CardContract", "const CardContract: ClassDecorator"),
    source.replace("@CardContract", "const Alias = CardContract; @Alias"),
    source.replace(`View(${options})`, `(() => View(${options}))()`),
    source
      .replace(`const CardContract = View(${options});`, "")
      .replace(
        "@CardContract class Card {}",
        `@CardContract class Card {} const CardContract = View(${options});`,
      ),
    source.replace(
      `const CardContract = View(${options});`,
      'import { CardContract } from "./external.js";',
    ),
    source.replace('field(Book,"title")', 'field(Book,"missing")'),
    source.replace(
      'title=Column({type:"string",nullable:true});',
      'title!: Book["id"];',
    ),
  ];
  for (const value of invalid) {
    const result = compile(value);
    assert.equal(result.success, false, value);
    assert.equal("ir" in result, false);
  }
});
