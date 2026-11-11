Ask the user with one HTML form; returns a pending identity immediately. Continue independent work while the user replies; no answer, recommendation, silence, or timeout grants consent.

Ask only for materially different tradeoffs the user must decide. Default: act using code/config/docs/history and conventions. Several viable choices: pick conservative/standard, proceed, state choice.

<instruction>
- `html`: one `<form>` of plain semantic HTML, rendered natively in the user's terminal. NEVER `<script>`, `<style>`, or `style=`.
- Every control needs a `name`. Explicit form submissions arrive as normal user-chat replies identified by tool-call ID and field name. `/tree` re-answer returns submitted form data as JSON: radio or select values, checkbox arrays, numeric values, text, and hidden inputs.
- One-of: `<input type="radio">`; many-of: `type="checkbox"`; long lists: `<select>`. Wrap each control in a `<label>`; group a question in a `<fieldset>` with a `<legend>`, or put it in a `<p>` right before the group.
- Radio and checkbox groups automatically get an "Other" free-text answer: its text arrives as the radio's value, or as an extra checkbox array entry. NEVER add your own "Other" option or a text field for it.
- Free input: `<input type="text|number|date|email|url">`, `<textarea>`; `placeholder`, `min`/`max`, `pattern`, `required` are enforced.
- Preselect your recommendation with `checked`/`selected`/`value`. A pending form never applies those defaults as a user answer.
- Context the user needs to decide (findings, tradeoffs, diffs, drafts) goes inside the form: `<p>`, `<ul>`, `<table>`, `<pre>`.
- Pictures: `<img src="…" alt="…">` (an http(s) URL, a `data:` URI, or a file path relative to the working directory) and inline `<svg>` diagrams, as their own blocks; inside a `<label>` an image shows only its `alt`.
- NEVER add buttons (`<button>`, `type="submit"`): the UI supplies Submit and Cancel.
- Keep forms short: a few questions, 2–5 options each; ask follow-ups in a later call.
</instruction>

When ask.gate is enabled, choice fields require preselected options and a recent completed result from the configured shadow profile. Passing calls return working defaults without a dialog: proceed immediately and put the choices on a styled review page, with only its link in chat. Use critical.kind (irreversible/public/hands/credential) and a concrete critical.reason only for a genuine mission-critical stop.
