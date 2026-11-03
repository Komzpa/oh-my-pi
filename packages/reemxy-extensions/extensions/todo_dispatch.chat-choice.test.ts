import { expect, test } from "bun:test";
import { chatChoiceMatch } from "./todo_dispatch";

const SHADE =
	"Предлагаю сделать всё в один оттенок: одна заливка и одна полоса слева.\n\nDo / Leave / Other?\n\nЧто ещё в работе: ...";

test("chatChoiceMatch finds a chat Do/Leave/Other and ignores replies carrying a review link", () => {
	expect(chatChoiceMatch(SHADE)).toBe("Do / Leave / Other?");
	expect(chatChoiceMatch("Answer: Do, Leave or Other?")).toContain("Do, Leave or Other");
	expect(chatChoiceMatch("Do/Leave?")).toBe("Do/Leave?");
	expect(chatChoiceMatch(`${SHADE}\nhttp://nucat:8767/review/form-models-2026-11-03-r3/`)).toBeUndefined();
	expect(chatChoiceMatch("Done: rows landed; leaving the shade unchanged.")).toBeUndefined();
	expect(chatChoiceMatch("")).toBeUndefined();
});

test("chatChoiceMatch catches option-list questions in any language and leaves prose alone", () => {
	expect(chatChoiceMatch("Предлагаю так: четыре варианта.\n\nДелаем / Оставляем / Другое?")).toBe(
		"Делаем / Оставляем / Другое?",
	);
	expect(chatChoiceMatch("**Accept / Redo / Drop?**")).toBe("**Accept / Redo / Drop?**");
	expect(chatChoiceMatch("Делаем / Оставляем / Другое?\nhttp://nucat:8767/review/dc-models-r1/")).toBeUndefined();
	// Prose with a slash or a question is not an option list.
	expect(chatChoiceMatch("Ставка lease $/кВт·мес, а не £/МВт?")).toBeUndefined();
	expect(chatChoiceMatch("Should the worker retry the suite after 20:00?")).toBeUndefined();
	expect(chatChoiceMatch("Waiting on the suite (~20:00) and the verdict.")).toBeUndefined();
	expect(chatChoiceMatch("CBRE H2 2025: $196; JLL 2025: от $129 (>20 МВт) до $157 (1-5 МВт);")).toBeUndefined();
});
