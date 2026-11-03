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
