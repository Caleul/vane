import {
	Column,
	Entity,
	Event,
	Module,
	Rule,
	Saga,
	View,
	column,
	create,
	update,
	remove,
	add,
	lte,
	eq,
	and,
	asc,
	event,
	field,
	input,
	reference,
	type EventInput,
	type ViewInput,
	type ViewOutput,
} from "@lilka/vane";
@Entity()
export class Project {
	id = Column({ type: "uuid", identity: true });
	name = Column({ type: "string", minLength: 1 });
	Create = Event({
		input: { id: "uuid", name: "string" },
		operation: create({ id: input("id"), name: (() => "hidden")() }),
	});
	Update = Event({
		input: { id: "uuid", name: "string" },
		operation: update(input("id"), { name: input("name") }),
	});
	Delete = Event({ input: { id: "uuid" }, operation: remove(input("id")) });
}
@Entity()
export class Todo {
	id = Column({ type: "uuid", identity: true });
	projectId = Column({ type: "uuid", references: reference(Project, "id") });
	title = Column({ type: "string", minLength: 1 });
	totalUnits = Column({ type: "integer", minimum: 0 });
	completedUnits = Column({ type: "integer", minimum: 0 });
	@Rule({ expression: lte(column("completedUnits"), column("totalUnits")) })
	WithinTotal() {}
	Create = Event({
		input: {
			id: "uuid",
			projectId: "uuid",
			title: "string",
			totalUnits: "integer",
			completedUnits: "integer",
		},
		operation: create({
			id: input("id"),
			projectId: input("projectId"),
			title: input("title"),
			totalUnits: input("totalUnits"),
			completedUnits: input("completedUnits"),
		}),
	});
	Update = Event({
		input: { id: "uuid", title: "string", totalUnits: "integer" },
		operation: update(input("id"), {
			title: input("title"),
			totalUnits: input("totalUnits"),
		}),
	});
	Complete = Event({
		input: { id: "uuid", units: "integer" },
		operation: update(input("id"), {
			completedUnits: add(column("completedUnits"), input("units")),
		}),
	});
	Delete = Event({ input: { id: "uuid" }, operation: remove(input("id")) });
}
const TodoCardContract = View({
	input: { id: "uuid" },
	output: {
		id: field(Todo, "id"),
		projectId: field(Todo, "projectId"),
		title: field(Todo, "title"),
		totalUnits: field(Todo, "totalUnits"),
		completedUnits: field(Todo, "completedUnits"),
	},
	query: { root: Todo, where: eq(field(Todo, "id"), input("id")) },
});
@TodoCardContract
export class TodoCard {}
@View({
	input: { id: "uuid" },
	output: { id: field(Project, "id"), name: field(Project, "name") },
	query: { root: Project, where: eq(field(Project, "id"), input("id")) },
})
class ProjectCard {}
@View({
	input: {
		projectId: "uuid",
		completedUnits: "integer",
		limit: "integer",
		offset: "integer",
	},
	output: {
		id: field(Todo, "id"),
		title: field(Todo, "title"),
		completedUnits: field(Todo, "completedUnits"),
	},
	query: {
		root: Todo,
		where: and(
			eq(field(Todo, "projectId"), input("projectId")),
			eq(field(Todo, "completedUnits"), input("completedUnits")),
		),
		orderBy: [asc(field(Todo, "title")), asc(field(Todo, "id"))],
		pagination: { limit: input("limit"), offset: input("offset") },
	},
})
class TodoList {}
@Saga({
	input: { id: "uuid", name: "string" },
	steps: { apply: event(Project, "Create") },
	terminal: { step: "apply", view: ProjectCard },
})
class ProjectCreate {}
@Saga({
	input: { id: "uuid", name: "string" },
	steps: { apply: event(Project, "Update") },
	terminal: { step: "apply", view: ProjectCard },
})
class ProjectUpdate {}
@Saga({
	input: { id: "uuid" },
	steps: { apply: event(Project, "Delete") },
	terminal: { step: "apply", view: ProjectCard },
})
class ProjectDelete {}
@Saga({
	input: {
		id: "uuid",
		projectId: "uuid",
		title: "string",
		totalUnits: "integer",
		completedUnits: "integer",
	},
	steps: { apply: event(Todo, "Create") },
	terminal: { step: "apply", view: TodoCard },
})
class TodoCreate {}
@Saga({
	input: { id: "uuid", title: "string", totalUnits: "integer" },
	steps: { apply: event(Todo, "Update") },
	terminal: { step: "apply", view: TodoCard },
})
class TodoUpdate {}
@Saga({
	input: { id: "uuid", units: "integer" },
	steps: { apply: event(Todo, "Complete") },
	terminal: { step: "apply", view: TodoCard },
})
class TodoComplete {}
@Saga({
	input: { id: "uuid" },
	steps: { apply: event(Todo, "Delete") },
	terminal: { step: "apply", view: TodoCard },
})
class TodoDelete {}
@Module({
	entities: [Project, Todo],
	views: [ProjectCard, TodoCard, TodoList],
	sagas: [
		ProjectCreate,
		ProjectUpdate,
		ProjectDelete,
		TodoCreate,
		TodoUpdate,
		TodoComplete,
		TodoDelete,
	],
})
export class Tasks {}
export type CreateTodoInput = EventInput<Todo["Create"]>;
export type TodoCardInput = ViewInput<typeof TodoCardContract>;
export type TodoCardRow = ViewOutput<typeof TodoCardContract>;
