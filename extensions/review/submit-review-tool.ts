import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";

const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;

export const SUBMIT_REVIEW_EXTENSION_PATH = fileURLToPath(import.meta.url);

const SUBMIT_REVIEW_PARAMS = Type.Object(
  {
    findings: Type.Array(
      Type.Object(
        {
          priority: StringEnum(PRIORITIES, {
            description:
              "Priority level: P0 critical/blocking, P1 urgent, P2 normal, P3 low/nice-to-have.",
          }),
          location: Type.String({
            minLength: 1,
            description:
              "File path and line for the finding, e.g. src/file.ts:42. Use path only if no single line applies.",
          }),
          finding: Type.String({
            minLength: 1,
            description:
              "Concise explanation of what is wrong, why it matters, and the concrete scenario where it fails.",
          }),
          suggestion: Type.String({
            minLength: 1,
            description: "Specific, actionable fix for this finding.",
          }),
        },
        { additionalProperties: false },
      ),
      { description: "Final review findings" },
    ),
    note: Type.Optional(
      Type.String({
        description: "Optional note when submitting zero findings or explaining uncertainty.",
      }),
    ),
  },
  { additionalProperties: false },
);

const submitReviewTool = defineTool({
  name: "submit_review",
  label: "Submit Review",
  description: "Submit the final review findings. Use exactly once as your final action.",
  promptSnippet: "Submit the final review findings",
  promptGuidelines: ["Use submit_review exactly once as your final action."],
  parameters: SUBMIT_REVIEW_PARAMS,

  async execute(_toolCallId, params) {
    return {
      content: [{ type: "text", text: "Review submitted." }],
      details: params,
      terminate: true,
    };
  },
});

export default function reviewSubmitExtension(pi: ExtensionAPI): void {
  pi.registerTool(submitReviewTool);
}
