import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";

const TRIAGE_DECISIONS = ["address", "push_back", "research", "ignore"] as const;

export const SUBMIT_TRIAGE_EXTENSION_PATH = fileURLToPath(import.meta.url);

const SUBMIT_TRIAGE_PARAMS = Type.Object(
  {
    items: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1, description: "Input feedback id being triaged." }),
          decision: StringEnum(TRIAGE_DECISIONS, {
            description: "Triage decision: address, push_back, research, or ignore.",
          }),
          summary: Type.String({
            minLength: 1,
            description: "Brief description of the feedback item.",
          }),
          rationale: Type.String({
            minLength: 1,
            description: "Why this triage decision is correct.",
          }),
          action: Type.String({
            minLength: 1,
            description: "What to do next for this feedback item.",
          }),
        },
        { additionalProperties: false },
      ),
      { description: "Final triage items" },
    ),
  },
  { additionalProperties: false },
);

const submitTriageTool = defineTool({
  name: "submit_triage",
  label: "Submit Triage",
  description: "Submit the final PR feedback triage. Use exactly once as your final action.",
  promptSnippet: "Submit the final PR feedback triage",
  promptGuidelines: ["Use submit_triage exactly once as your final action."],
  parameters: SUBMIT_TRIAGE_PARAMS,

  async execute(_toolCallId, params) {
    return {
      content: [{ type: "text", text: "Triage submitted." }],
      details: params,
      terminate: true,
    };
  },
});

export default function triageSubmitExtension(pi: ExtensionAPI): void {
  pi.registerTool(submitTriageTool);
}
