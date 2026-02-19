/**
 * Ghostty terminal title + progress integration.
 *
 * - Shows project/session in the terminal title
 * - Shows a braille spinner in the title while the agent is working
 * - Updates title with the current tool name during tool execution
 * - Pulses Ghostty's native progress bar while working
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { writeFileSync } from "node:fs";
import path from "node:path";

const STATUS_SPINNER_INTERVAL_MS = 80;
const STATUS_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const COMPLETION_FLASH_MS = 800;

let sessionName: string | undefined;
let currentTool: string | undefined;
let isWorking = false;
let frameIndex = 0;
let spinnerTimer: ReturnType<typeof setInterval> | undefined;
let completionTimer: ReturnType<typeof setTimeout> | undefined;

function ghosttyWrite(seq: string): void {
	try {
		writeFileSync("/dev/tty", seq);
	} catch {
		// /dev/tty may be unavailable (e.g. subagent context)
	}
}

function setProgress(state: number, value?: number): void {
	const args = value !== undefined ? `${state};${value}` : `${state}`;
	ghosttyWrite(`\x1b]9;4;${args}\x07`);
}

function buildTitle(extra?: string): string {
	const segments: string[] = ["π", path.basename(process.cwd())];
	if (sessionName) segments.push(sessionName);
	if (extra) segments.push(extra);
	return segments.join(" · ");
}

function clearSpinnerTimer(): void {
	if (!spinnerTimer) return;
	clearInterval(spinnerTimer);
	spinnerTimer = undefined;
}

function clearCompletionTimer(): void {
	if (!completionTimer) return;
	clearTimeout(completionTimer);
	completionTimer = undefined;
}

function currentFrame(): string {
	return STATUS_SPINNER_FRAMES[frameIndex % STATUS_SPINNER_FRAMES.length];
}

function renderWorkingTitle(ctx: ExtensionContext): void {
	ctx.ui.setTitle(`${currentFrame()} ${buildTitle(currentTool)}`);
}

function startSpinner(ctx: ExtensionContext): void {
	clearSpinnerTimer();
	clearCompletionTimer();

	isWorking = true;
	currentTool = undefined;
	frameIndex = 0;

	setProgress(3);
	renderWorkingTitle(ctx);

	spinnerTimer = setInterval(() => {
		frameIndex = (frameIndex + 1) % STATUS_SPINNER_FRAMES.length;
		renderWorkingTitle(ctx);
	}, STATUS_SPINNER_INTERVAL_MS);
}

function stopSpinner(ctx: ExtensionContext): void {
	isWorking = false;
	currentTool = undefined;
	clearSpinnerTimer();

	setProgress(1, 100);
	ctx.ui.setTitle(buildTitle());

	clearCompletionTimer();
	completionTimer = setTimeout(() => {
		setProgress(0);
		completionTimer = undefined;
	}, COMPLETION_FLASH_MS);
}

function syncSessionTitle(ctx: ExtensionContext): void {
	if (isWorking) {
		renderWorkingTitle(ctx);
		return;
	}
	ctx.ui.setTitle(buildTitle());
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		sessionName = pi.getSessionName();
		syncSessionTitle(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		sessionName = pi.getSessionName();
		syncSessionTitle(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		startSpinner(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		stopSpinner(ctx);
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		currentTool = event.toolName;
		if (!ctx.hasUI || !isWorking) return;
		renderWorkingTitle(ctx);
	});

	pi.on("tool_execution_end", async (_event, ctx) => {
		currentTool = undefined;
		if (!ctx.hasUI || !isWorking) return;
		renderWorkingTitle(ctx);
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		clearSpinnerTimer();
		clearCompletionTimer();
		isWorking = false;
		currentTool = undefined;
		setProgress(0);
	});
}
