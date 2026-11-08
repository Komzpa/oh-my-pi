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
						checks: {
							type: "array",
							items: {
								type: "object",
								required: ["command", "exitCode"],
								properties: {
									command: { type: "string", minLength: 1 },
									exitCode: { type: "number" },
									gate: { type: "boolean" },
								},
							},
						},
						screenshots: {
							type: "array",
							items: {
								type: "object",
								required: ["path"],
								properties: { path: { type: "string", minLength: 1 }, width: { type: "number" } },
							},
						},
					},
					anyOf: [
						{ properties: { verdict: { const: "inconclusive" } } },
						{ required: ["checks"], properties: { checks: { minItems: 1 } } },
						{ required: ["screenshots"], properties: { screenshots: { minItems: 1 } } },
					],
				},
				allOf: rows.map(row => ({
					contains: { type: "object", required: ["row"], properties: { row: { const: row } } },
				})),
			},
		},
	};
}
