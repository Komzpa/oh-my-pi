/** Every assigned row must have a verdict before an audit can be submitted. */
export function rowAuditOutputSchema(rows: readonly string[]): Record<string, unknown> {
	return {
		type: "object",
		required: ["rows"],
		properties: {
			rows: {
				type: "array",
				minItems: rows.length,
				maxItems: rows.length,
				items: {
					type: "object",
					required: ["row", "verdict", "findings"],
					properties: {
						row: { type: "string", enum: [...rows] },
						verdict: { type: "string", enum: ["pass", "fail", "inconclusive"] },
						findings: { type: "string" },
					},
				},
				allOf: rows.map(row => ({
					contains: { type: "object", required: ["row"], properties: { row: { const: row } } },
				})),
			},
		},
	};
}
