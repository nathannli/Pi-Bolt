/**
 * Herdr (https://herdr.dev) support for Pi-Bolt: in a Herdr pane, report the agent's state (idle, working, blocked) and the
 * command that reopens its session, so Herdr shows `pi-bolt` in its sidebar, notifies when it finishes or needs the user, and
 * brings the same session back in the same pane after a Herdr server restart.
 *
 * Herdr's own Pi integration (`herdr integration install pi`, ~/.pi/agent/extensions/herdr-agent-state.ts) reports as `pi` and
 * restores with `pi --session`, which is not Pi-Bolt, so Pi-Bolt does not load that file (integration-file.ts) and
 * reports for itself, as Herdr's "Add Herdr support to your agent" describes: its own source and agent name, its own resume
 * command. Outside Herdr (HERDR_ENV and HERDR_PANE_ID unset) it does nothing. Reports go over Herdr's socket, or on
 * Windows through the `herdr` executable (transport.ts). Disable it with
 * `-builtin:herdr` in the `extensions` setting.
 *
 * Only the interactive session reports: print, JSON and RPC runs, and subagents (sessions without a UI), would otherwise
 * take over the pane of the session that started them.
 */

import { isAbsolute } from "node:path";
import { COMMAND_NAME } from "../../config.ts";
import type { ExtensionContext, ExtensionFactory } from "../../core/extensions/types.ts";
import { type HerdrRequest, type HerdrTransport, herdrFromEnvironment } from "./transport.ts";

const SOURCE = "herdr:pi-bolt";
const AGENT = "pi-bolt";

type AgentState = "working" | "blocked" | "idle";

/**
 * pi-herdr (an extension that runs agents in Herdr panes) also reports this pane's state, as `pi`, and the last report holds
 * the pane: Herdr would show `pi` and lose the resume command. Its PI_HERDR_NO_SELF_REPORT switch turns that off. pi-herdr
 * reads it when it loads, before this extension runs, so this is called at startup.
 */
export function quietOtherHerdrReporters(env: NodeJS.ProcessEnv = process.env): void {
	if (herdrFromEnvironment(env)) env.PI_HERDR_NO_SELF_REPORT ??= "1";
}

async function send(transport: HerdrTransport, request: HerdrRequest): Promise<void> {
	if (await transport(request, 500)) return;
	await transport(request, 1500);
}

/**
 * The command Herdr runs to reopen this session after a server restart: `pi-bolt --session <file>`. Herdr refuses a
 * report whose command has an apostrophe or a control character in it or is over 8 KiB, so such a session gets no command
 * (its state still reaches Herdr).
 */
export function resumeArgv(sessionFile: string | undefined): string[] | undefined {
	if (!sessionFile || !isAbsolute(sessionFile)) return undefined;
	const argv = [COMMAND_NAME, "--session", sessionFile];
	if (argv.some((arg) => arg.includes("'") || hasControlCharacter(arg))) return undefined;
	if (argv.reduce((bytes, arg) => bytes + Buffer.byteLength(arg), 0) > 8192) return undefined;
	return argv;
}

/** Rust's char::is_control, which Herdr checks: C0, DEL and C1. */
function hasControlCharacter(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
	}
	return false;
}

export function createHerdrExtension(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): ExtensionFactory {
	return (pi) => {
		const herdr = herdrFromEnvironment(env, platform);
		if (!herdr) return;
		const { transport, paneId } = herdr;

		// Herdr ignores a report whose number is not above the last one from this source, across restarts of Pi-Bolt too.
		let seq = Date.now() * 1000;
		const nextSeq = () => ++seq;

		let reporting = false;
		let sessionFile: string | undefined;
		let sessionId: string | undefined;
		let agentActive = false;
		let uiPrompt = false;
		const blockedLabels: string[] = [];
		const runningSubagents = new Set<string>();
		let last: { state: AgentState; message?: string; sessionFile?: string } | undefined;

		function updateSession(ctx: ExtensionContext) {
			try {
				const file = ctx.sessionManager.getSessionFile();
				sessionFile = typeof file === "string" && isAbsolute(file) ? file : undefined;
			} catch {
				sessionFile = undefined;
			}
			try {
				const id = ctx.sessionManager.getSessionId();
				sessionId = typeof id === "string" && id.length > 0 ? id : undefined;
			} catch {
				sessionId = undefined;
			}
		}

		function desiredState(): { state: AgentState; message?: string } {
			if (blockedLabels.length > 0) return { state: "blocked", message: blockedLabels[blockedLabels.length - 1] };
			// A dialog during a run is a tool or extension waiting for the user; one opened at the prompt is the user's own.
			if (uiPrompt && agentActive) return { state: "blocked" };
			if (agentActive || runningSubagents.size > 0) return { state: "working" };
			return { state: "idle" };
		}

		// One report in flight at a time; only the newest waiting one is sent. A session report goes out before the state
		// report queued after it: Herdr applies a state report only once the session is anchored.
		let inFlight = false;
		let queuedSession: HerdrRequest | undefined;
		let queued: HerdrRequest | undefined;
		async function drain() {
			if (inFlight) return;
			inFlight = true;
			try {
				while (queuedSession || queued) {
					const request = queuedSession ?? queued;
					if (!request) break;
					if (queuedSession) queuedSession = undefined;
					else queued = undefined;
					await send(transport, request);
				}
			} finally {
				inFlight = false;
			}
		}

		/** Tells Herdr which session this pane's agent has opened (Herdr's `pane.report_agent_session`). */
		function reportSession(sessionStartSource: string) {
			if (!sessionFile && !sessionId) return;
			const argv = resumeArgv(sessionFile);
			queuedSession = {
				method: "pane.report_agent_session",
				params: {
					pane_id: paneId,
					source: SOURCE,
					agent: AGENT,
					seq: nextSeq(),
					session_start_source: sessionStartSource,
					...(sessionFile ? { agent_session_path: sessionFile } : { agent_session_id: sessionId }),
					...(argv ? { resume_argv: argv } : {}),
				},
			};
			void drain();
		}

		function publish(force = false) {
			if (!reporting) return;
			const next = { ...desiredState(), sessionFile };
			if (
				!force &&
				last &&
				last.state === next.state &&
				last.message === next.message &&
				last.sessionFile === next.sessionFile
			) {
				return;
			}
			last = next;
			const argv = resumeArgv(sessionFile);
			queued = {
				method: "pane.report_agent",
				params: {
					pane_id: paneId,
					source: SOURCE,
					agent: AGENT,
					state: next.state,
					...(next.message ? { message: next.message } : {}),
					seq: nextSeq(),
					...(sessionFile
						? { agent_session_path: sessionFile }
						: sessionId
							? { agent_session_id: sessionId }
							: {}),
					...(argv ? { resume_argv: argv } : {}),
				},
			};
			void drain();
		}

		pi.on("session_start", (event, ctx) => {
			if (ctx.mode !== "tui") return;
			reporting = true;
			updateSession(ctx);
			reportSession(event.reason);
			// A reload replaces this extension in the middle of a run without another agent_start.
			agentActive = ctx.isIdle() === false;
			publish(true);
		});

		pi.on("agent_start", (_event, ctx) => {
			if (!reporting) return;
			updateSession(ctx);
			reportSession("startup");
			agentActive = true;
			publish();
		});

		pi.on("agent_settled", (_event, ctx) => {
			if (!reporting || !ctx.isIdle()) return;
			agentActive = false;
			publish();
		});

		pi.on("ui_prompt_start", () => {
			uiPrompt = true;
			publish();
		});

		pi.on("ui_prompt_end", () => {
			uiPrompt = false;
			publish();
		});

		// Extensions that wait for the user outside a dialog (pi-ask-user, pi-subagents) say so on this channel, which
		// Herdr's own Pi integration also listens to: { active: boolean, label?: string }.
		pi.events.on("herdr:blocked", (data) => {
			const { active, label } = (data ?? {}) as { active?: unknown; label?: unknown };
			if (active) blockedLabels.push(typeof label === "string" ? label : "");
			else blockedLabels.pop();
			publish();
		});

		// Background subagents keep working after the run that started them settles.
		for (const [event, running] of [
			["subagents:started", true],
			["subagents:completed", false],
			["subagents:failed", false],
		] as const) {
			pi.events.on(event, (data) => {
				const id = (data as { id?: unknown } | undefined)?.id;
				if (typeof id !== "string") return;
				if (running) runningSubagents.add(id);
				else runningSubagents.delete(id);
				publish();
			});
		}

		pi.on("session_shutdown", async (event) => {
			if (!reporting) return;
			reporting = false;
			// Another session in this process (new, resume, fork) or a reload reports again from its session_start.
			if (event.reason !== "quit") return;
			queuedSession = undefined;
			queued = undefined;
			// One short try: Herdr also notices the exit once the pane is back at its shell prompt.
			await transport(
				{
					method: "pane.release_agent",
					params: { pane_id: paneId, source: SOURCE, agent: AGENT, seq: nextSeq() },
				},
				500,
			);
		});
	};
}

export default createHerdrExtension();
