import {
  ACL,
  ACLEvent,
  Column,
  Entity,
  Event,
  Module,
  Saga,
  View,
  create,
  eq,
  event,
  fail,
  field,
  input,
  literal,
  reference,
  relation,
  success,
  sum,
  update,
} from "@lilka/vane";
@Entity()
class Shelf {
  id = Column({ type: "uuid", identity: true });
  name = Column({ type: "string", unique: true });
  Add = Event({
    input: { id: "uuid", name: "string" },
    operation: create({ id: input("id"), name: input("name") }),
  });
}
@Entity()
class Book {
  id = Column({ type: "uuid", identity: true });
  shelfId = Column({ type: "uuid", references: reference(Shelf, "id") });
  copies = Column({ type: "integer", minimum: 0 });
  Add = Event({
    input: { id: "uuid", shelfId: "uuid", copies: "integer" },
    operation: create({
      id: input("id"),
      shelfId: input("shelfId"),
      copies: input("copies"),
    }),
  });
  Invalid = Event({
    input: { id: "uuid" },
    operation: update(input("id"), { copies: literal(-1) }),
  });
}
@ACL()
class Courier {
  Notify = ACLEvent({
    input: { id: "uuid" },
    results: { accepted: success({ receipt: "string" }), rejected: fail({}) },
  });
}
@View({
  input: { id: "uuid" },
  output: {
    id: field(Book, "id"),
    copies: field(Book, "copies"),
    shelf: field(Shelf, "name"),
  },
  query: {
    root: Book,
    relations: { shelf: relation(field(Book, "shelfId"), field(Shelf, "id")) },
    where: eq(field(Book, "id"), input("id")),
  },
})
class BookCard {}
@View({
  input: { shelfId: "uuid" },
  output: { copies: sum(field(Book, "copies")) },
  query: {
    root: Shelf,
    relations: { books: relation(field(Book, "shelfId"), field(Shelf, "id")) },
    where: eq(field(Shelf, "id"), input("shelfId")),
  },
})
class ShelfTotal {}
@Saga({
  input: { id: "uuid", shelfId: "uuid", copies: "integer" },
  steps: {
    add: event(Book, "Add"),
    notify: event(Courier, "Notify", { causedBy: ["add"] }),
  },
  terminal: { step: "notify", view: BookCard },
})
class AddAndNotify {}
@Module({
  entities: [Shelf, Book],
  views: [BookCard, ShelfTotal],
  antiCorruptionLayers: [Courier],
  sagas: [AddAndNotify],
})
class Library {}
