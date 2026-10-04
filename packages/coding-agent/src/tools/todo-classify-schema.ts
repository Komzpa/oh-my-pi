import { type, type FluentType } from "@oh-my-pi/omptype";

const ClassifyClassification = type('"linked" | "not-a-requirement" | "merged"');

export const classifyTodoSchema = type({
	op: type.unit("classify"),
	"id?": type("string").describe("requirement id (Rn) for classify"),
	"classification?": ClassifyClassification.describe(
		"classify decision: linked needs rows, not-a-requirement needs reason, merged needs mergeInto",
	),
	"rows?": type("string").array().describe("exact todo row contents for classify linked"),
	"mergeInto?": type("string").describe("target Rn for classify merged"),
	"reason?": type("string").describe("reason required when classify uses not-a-requirement"),
});

export type TodoToolSchema<TodoParams> = FluentType<TodoParams | typeof classifyTodoSchema.infer>;

export type TodoToolParams<TodoParams> = TodoParams | typeof classifyTodoSchema.infer;

export function createTodoToolSchema<TodoParams>(todoSchema: FluentType<TodoParams>): TodoToolSchema<TodoParams> {
	return todoSchema.or(classifyTodoSchema) as TodoToolSchema<TodoParams>;
}
