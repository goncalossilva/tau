import type { ReviewReportFinding } from "../schema.js";

const REVIEW_STALE_SECTION_TITLE = "Repository changed";

type ReviewFailure = {
  focus: string;
  model: string;
  error?: string;
};

export function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

export function buildReviewFindingsMarkdown(
  reviewedScopeLine: string,
  findings: ReviewReportFinding[],
  completedReviews: number,
  totalReviews: number,
  footerNotes: string[] = [],
): string {
  const reviewWord = totalReviews === 1 ? "review" : "reviews";
  const completionLine =
    completedReviews === totalReviews
      ? `All ${totalReviews} ${reviewWord} completed`
      : `${completedReviews} of ${totalReviews} ${reviewWord} completed`;

  if (findings.length === 0) {
    return appendMarkdownListSection(
      `${reviewedScopeLine}\n\n${completionLine}.\n\nNo findings.\n`,
      REVIEW_STALE_SECTION_TITLE,
      footerNotes,
    );
  }

  let table = "| # | Focus | Model | Priority | Location | Finding | Suggestion |\n";
  table += "|---|---|---|---|---|---|---|\n";
  findings.forEach((finding, index) => {
    table += `| ${index + 1} | ${escapeMarkdownTableCell(finding.focus)} | ${escapeMarkdownTableCell(finding.model)} | ${escapeMarkdownTableCell(finding.priority)} | ${escapeMarkdownTableCell(finding.location)} | ${escapeMarkdownTableCell(finding.finding)} | ${escapeMarkdownTableCell(finding.suggestion)} |\n`;
  });
  return appendMarkdownListSection(
    `${reviewedScopeLine}\n\n${completionLine}:\n\n${table}\n`,
    REVIEW_STALE_SECTION_TITLE,
    footerNotes,
  );
}

export function buildReviewFailuresMarkdown(failedFocuses: ReviewFailure[]): string {
  const reviewWord = failedFocuses.length === 1 ? "review" : "reviews";
  let table = "| Focus | Model | Error |\n";
  table += "|---|---|---|\n";
  for (const focus of failedFocuses) {
    table += `| ${escapeMarkdownTableCell(focus.focus)} | ${escapeMarkdownTableCell(focus.model)} | ${escapeMarkdownTableCell(focus.error ?? "Unknown failure")} |\n`;
  }
  return `${failedFocuses.length} ${reviewWord} failed:\n\n${table}\n`;
}

function appendMarkdownListSection(markdown: string, title: string, items: string[]): string {
  if (items.length === 0) return markdown;
  return `${markdown.trimEnd()}\n\n${title}:\n${items.map((item) => `- ${item}`).join("\n")}\n`;
}
