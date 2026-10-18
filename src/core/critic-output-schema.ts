export const CRITIC_OUTPUT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["summary", "decisions", "checked", "residual_risks"],
	properties: {
		summary: { type: "string", pattern: "\\S" },
		decisions: {
			type: "array",
			items: {
				anyOf: [
					{
						type: "object",
						additionalProperties: false,
						required: ["ref", "action"],
						properties: {
							ref: { type: "string", pattern: "\\S" },
							action: { type: "string", enum: ["drop"] },
						},
					},
					{
						type: "object",
						additionalProperties: false,
						required: ["ref", "action", "severity", "confidence"],
						properties: {
							ref: { type: "string", pattern: "\\S" },
							action: { type: "string", enum: ["keep"] },
							severity: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
							confidence: { type: "number", minimum: 0, maximum: 1 },
						},
					},
				],
			},
		},
		checked: {
			type: "array",
			minItems: 1,
			items: { type: "string", pattern: "\\S" },
		},
		residual_risks: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["text", "blocks"],
				properties: {
					text: { type: "string", pattern: "\\S" },
					blocks: { type: "boolean" },
				},
			},
		},
	},
};
