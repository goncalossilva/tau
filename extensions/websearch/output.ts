import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  withFileMutationQueue,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";

interface OutputDetails {
  truncation?: Omit<TruncationResult, "content">;
  fullOutputPath?: string;
}

/** Limit the complete model-facing text; retain full output only in a private, published file. */
export async function limitOutput(
  output: string,
  signal?: AbortSignal,
): Promise<{ text: string; details: OutputDetails }> {
  signal?.throwIfAborted();
  if (!truncateHead(output).truncated) return { text: output, details: {} };

  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-websearch-"));
  try {
    const fullOutputPath = path.join(directory, "output.txt");
    const notice = `\n\n[Output truncated (${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} limit). Full output saved to: ${fullOutputPath}]`;
    const maxBytes = DEFAULT_MAX_BYTES - Buffer.byteLength(notice, "utf8");
    const maxLines = DEFAULT_MAX_LINES - (notice.split("\n").length - 1);
    if (maxBytes <= 0 || maxLines <= 0) {
      throw new Error("Websearch output path is too long for the truncation notice.");
    }
    const { content, ...truncation } = truncateHead(output, { maxBytes, maxLines });
    await withFileMutationQueue(fullOutputPath, async () => {
      await writeFile(fullOutputPath, output, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
        signal,
      });
    });
    signal?.throwIfAborted();
    // Published files remain readable after completion/shutdown, like native tool output files.
    return { text: content + notice, details: { truncation, fullOutputPath } };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
