---
name: stakeholder-shadow
description: Forecast what every stakeholder would say about a delivered fix or question card, cite dated precedents, and surface conflicts for the owner.
---

# Stakeholder shadow

Forecast the whole stakeholder panel: who says what, and where they disagree.
A forecast is advisory. It never stands in for anyone's decision.
A project-local `.agents/skills/stakeholder-shadow/SKILL.md` overrides this
shipped skill with project-specific profiles, corpus locations and instructions.

## When

- A worker delivers a fix, before owner handoff. Evidenced defects go back for
  redo; a clean result joins the next batch review.
- An artifact will be shown to a team or client.
- A genuinely unresolved question card is about to be published. A real
  stakeholder conflict belongs on a card.
- Never to predict Accept/Redo on a delivered-fix review page.

## How

One ordinary read-only worker at cheap effort applies this skill:

1. Locate the stakeholder profiles and decision corpus supplied by the project.
   Read every profile to END OF FILE. The panel includes EVERY stakeholder
   with a profile; omit someone only when their profile establishes that the
   artifact is outside their scope, and explain the omission.
2. Find dated precedents for each stakeholder in their profile and the supplied
   corpus. Cite source ids and dates. Do not invent people, values or evidence.
   Without a precedent, label the forecast a guess and cap confidence at 0.5.
3. If a cutoff is given, use only evidence dated strictly before it. Record the
   forecast before reading any later answer. Undated evidence cannot establish
   a pre-cutoff precedent.
4. Inspect the complete artifact: row request, accepted spec and decisions,
   immutable commit range, preview URL, full screenshot or question card.
   Report missing or unseen inputs; missing context alone is not a defect.
5. Return:
   - **Verdict.** Delivered fix: `clean`, or `defects` with findings of kind
     `collateral_defect`, `requirement_violation` or `contradicts_decision`.
     Each defect needs who would raise it, its precise location, observation
     and requirement/decision evidence. Question card: `valid`,
     `already_decided`, `false_choice` or `not_ready`, with evidence and the
     action the lead should take instead of asking a bad question.
   - **Remarks, ranked across the whole panel.** Each gives who would say it,
     what they would likely say (a forecast, never a quotation), precedent id
     and date, confidence 0–1, and what they would ask to see instead.
   - **Conflicts.** Every pair/group whose wishes conflict with each other or
     an accepted spec/decision. Give each side's position and precedent, the
     accepted decision if relevant, and the question that would resolve it.
     Conflicts become question cards for the owner. The worker NEVER resolves
     them, chooses a side or changes an accepted spec. A forecast disagreement
     alone is not an evidenced defect.
   - **Agreement.** One line stating what the panel agrees on; say when the
     evidence does not establish agreement.
6. Do not imitate anyone's manner, speak for them, ask the owner directly,
   change files or rebuild the corpus. Follow a caller's JSON output contract
   while preserving verdict, ranked panel remarks, conflicts and agreement.

Keep private profiles and corpus outside committed artifacts. When the harness
records the verdict, do not duplicate its ledger writes.

Classify every finding with severity "blocker" or "later" and an executable action. Blocker means a visible product regression the user would reject on sight, broken build/gates/tests, data loss, or wrong model numbers. Polish, wording, extra evidence/oracles and test-shape nits are later. Only blockers fail delivery; a result with no blockers is clean/pass even with later findings. Missing severity defaults to later except regression/broken-gate kinds. Review only the delta since the recorded audit base, and verify previously reported blockers; do not reopen unchanged accepted scope.
