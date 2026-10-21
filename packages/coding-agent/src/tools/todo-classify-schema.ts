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
	"reason?": type("string").describe(
		"reason required for not-a-requirement, relink=true, or owner-backed supersession",
	),
	"relink?": type("boolean").describe(
		"relink=true changes rows on an already-linked requirement (linked -> linked only); requires reason and at least one row",
	),
	"supersededBy?": type("string").describe(
		"exact newer owner Rn authorizing a classification change; requires reason and records append-only history",
	),
	"resources?": type("string")
		.array()
		.describe("absolute files or checkouts whose identity is the audited artifact for every linked row"),
	"deployment?": type("string").describe(
		"linked rows only; deploy:<HTTP(S)URL>@<version> field=<dotJSONpath> or deploy:<UNIT.service>@<version> scope=<user|system> env=<ENV_IDENTIFIER>; mutually exclusive with resources; replacing a saved binding requires relink=true and reason",
	),
});

export type TodoToolSchema<TodoParams> = FluentType<TodoParams | typeof classifyTodoSchema.infer>;

export type TodoToolParams<TodoParams> = TodoParams | typeof classifyTodoSchema.infer;

export function createTodoToolSchema<TodoParams>(todoSchema: FluentType<TodoParams>): TodoToolSchema<TodoParams> {
	return todoSchema.or(classifyTodoSchema) as TodoToolSchema<TodoParams>;
}
