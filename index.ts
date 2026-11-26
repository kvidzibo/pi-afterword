import { createHash } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { getCurrentSystemMessage, type Message, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { convertToLlm, DynamicBorder, ExtensionSelectorComponent, getAgentDir, keyHint, rawKeyHint, serializeConversation, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, ScrollView, Spacer, Text } from "@earendil-works/pi-tui";

const MIN_AGENT_TURNS = 10;
const DEADLINE_MS = 20_000;
const TARGET_WORDS = 25;
const MAX_WORDS = 30;
const RETRY_WORDS = [20, 15]; // Each shortening retry asks for fewer words.
const INSTRUCTION = `Afterword request: leave one durable, non-obvious lesson you learned in this conversation for future agents. Prefer a verified cause-and-fix, surprising constraint, or failed approach and why it failed. Include specific context needed to apply it. If no such lesson exists, preserve the most consequential decision and its rationale. Avoid PR status, test counts, completion summaries, and routine next steps. Aim for at most ${TARGET_WORDS} words; never exceed ${MAX_WORDS} whitespace-separated words. Reply with only the message, without a heading; do not call tools or continue other work. Do not include secrets or credentials.`;
const IMAGES_BLOCKED = "Image reading is disabled.";
const shorten = (words: number, target: number) => `That lesson has ${words} words; the limit is ${MAX_WORDS}. Rewrite it in at most ${target} words, keeping the specific context needed to apply it. Reply with only the message, without a heading; do not call tools.`;

type ShutdownTrigger = "quit" | "new";
type Reason = ShutdownTrigger | "done";

// /new replaces the chat pane and extension instance, but reuses the loaded module.
const newSessionNotices = new Map<string | undefined, string[]>();

function isShutdownTrigger(reason: unknown): reason is ShutdownTrigger {
	return reason === "quit" || reason === "new";
}
type Attempt = { started: number; ms?: number; stopReason?: string; words?: number; usage?: { cost?: { total?: number } } };

/** Pi's estimate for every request behind a note; unknown if any request lacks one. */
function totalCost(attempts: Attempt[]): number | null {
	let total = 0;
	for (const attempt of attempts) {
		const cost = attempt.usage?.cost?.total;
		if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return null;
		total += cost;
	}
	return total;
}
const formatCost = (cost: unknown) => typeof cost === "number" ? `$${cost.toFixed(4)}` : "unknown";

/** Categories are safe to show; detail goes only to the session file. */
class Failure extends Error {
	constructor(readonly category: string, readonly detail?: string) { super(category); }
}
const detail = (error: unknown) => String(error instanceof Error ? error.message : error).slice(0, 200);

type Completion = { taskId: number; signal: AbortSignal; waitUntil: (work: Promise<unknown>) => void };

async function database() {
	const directory = join(getAgentDir(), "afterword");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	chmodSync(directory, 0o700);
	const path = join(directory, "afterword.db");
	closeSync(openSync(path, "a", 0o600));
	chmodSync(path, 0o600);
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(path);
	try {
		db.exec(`PRAGMA busy_timeout = 0;
			CREATE TABLE IF NOT EXISTS afterwords (
				id INTEGER PRIMARY KEY,
				session_id TEXT NOT NULL,
				context_hash TEXT NOT NULL,
				task_id INTEGER,
				reason TEXT NOT NULL,
				cwd TEXT NOT NULL,
				model TEXT NOT NULL,
				thinking_level TEXT,
				cost REAL,
				created_at TEXT NOT NULL,
				note TEXT NOT NULL,
				UNIQUE (session_id, context_hash)
			)`);
		const columns = new Set(db.prepare("PRAGMA table_info(afterwords)").all().map((column) => column.name));
		for (const [name, type] of [["thinking_level", "TEXT"], ["cost", "REAL"]]) {
			if (!columns.has(name)) db.exec(`ALTER TABLE afterwords ADD COLUMN ${name} ${type}`);
		}
		return db;
	} catch (error) { db.close(); throw error; }
}

/** Pi's own request conversion when images are blocked: each run of images becomes one placeholder. */
function withoutImages(messages: Message[]): Message[] {
	return messages.map((message) => {
		if (message.role !== "user" && message.role !== "toolResult" || !Array.isArray(message.content) || !message.content.some((block) => block.type === "image")) return message;
		const content = message.content.map((block) => block.type === "image" ? { type: "text" as const, text: IMAGES_BLOCKED } : block);
		return { ...message, content: content.filter((block, i) => !(i > 0 && [block, content[i - 1]].every((part) => part.type === "text" && part.text === IMAGES_BLOCKED))) } as Message;
	});
}

/** No full transcript is persisted; state-only Pinote entries do not affect the key. */
function snapshot(pi: ExtensionAPI, ctx: ExtensionContext, forcedPrompt: string | undefined) {
	// Raw active-branch history survives compaction, resume, and extension reloads.
	const turns = ctx.sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "assistant").length;
	if (turns < MIN_AGENT_TURNS) return;
	const messages = ctx.sessionManager.buildSessionProjection().messages;
	if (!messages.some((message) => message.role === "compactionSummary" || message.role === "branchSummary" ||
		message.role === "assistant" && message.content.some((block) => block.type === "text" || block.type === "toolCall"))) return;
	let history = convertToLlm(messages);
	const conversation = serializeConversation(history);
	if (!conversation.trim()) return;
	const hash = createHash("sha256").update(conversation).digest("hex");
	// Like Pi, send a prompt an extension replaced for the last run instead of the recorded ones.
	if (forcedPrompt !== undefined) {
		const current = getCurrentSystemMessage(history);
		history = [{ role: "system", content: forcedPrompt, ...(current?.toolsAdded ? { toolsAdded: current.toolsAdded } : {}), timestamp: current?.timestamp ?? Date.now() },
			...history.filter((message) => message.role !== "system")];
	}
	const settings = pi.getSettings();
	return {
		history: settings.images?.blockImages ? withoutImages(history) : history, hash, sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd,
		model: ctx.model, thinkingLevel: pi.getThinkingLevel(), thinkingBudgets: settings.thinkingBudgets, busy: !ctx.isIdle(),
	};
}

async function record(ctx: ExtensionContext, state: NonNullable<ReturnType<typeof snapshot>>, reason: Reason, taskId: number | undefined, signal: AbortSignal, deadline: number, attempts: Attempt[], onGenerating: () => void): Promise<string | undefined> {
	const check = () => {
		signal.throwIfAborted();
		if (performance.now() >= deadline) throw new Failure("timed out");
	};
	const storage = async <T>(work: () => T | Promise<T>): Promise<T> => {
		try { return await work(); }
		catch (error) { throw error instanceof Failure || signal.aborted ? error : new Failure("database error", detail(error)); }
	};
	check();
	const { history, hash, sessionId, cwd, model, thinkingLevel, thinkingBudgets, busy } = state;
	if (!model) throw new Failure("no session model");
	if (await storage(async () => {
		const db = await database();
		try { return db.prepare("SELECT id FROM afterwords WHERE session_id = ? AND context_hash = ?").get(sessionId, hash); }
		finally { db.close(); }
	})) return;
	// Repeat the session's own request plus one question, so providers can reuse its prompt cache.
	// The request never enters the session. Continuation state and Codex's per-session WebSocket
	// (SSE still sends the session's cache key) stay with the real conversation.
	let messages: Message[] = [...history, { role: "user", content: INSTRUCTION, timestamp: Date.now() }];
	const options: SimpleStreamOptions = { reasoning: thinkingLevel === "off" ? undefined : thinkingLevel, thinkingBudgets, sessionId, disableContinuation: true, transport: "sse" };
	let result, author, note: string;
	while (true) {
		check(); // Never start a request whose result could not be saved.
		// A request with the session's ID can replace a running turn's request (Claude Code bridge).
		// Checked before each request: nothing awaits between this and sending it.
		if (busy || !ctx.isIdle()) throw new Failure("agent busy");
		if (!attempts.length) onGenerating();
		const attempt: Attempt = { started: performance.now() };
		attempts.push(attempt);
		// A shortening request carries the note, which a provider error may echo: keep its detail out of the log.
		const safe = (text?: string) => attempts.length === 1 ? text?.slice(0, 200) : undefined;
		try {
			result = await ctx.modelRegistry.streamSimple(model, { messages }, { ...options, signal }).result();
		} catch (error) {
			throw signal.aborted ? error : new Failure("model error", safe(detail(error)));
		} finally { attempt.ms = Math.round(performance.now() - attempt.started); }
		author ??= result;
		attempt.stopReason = result.stopReason;
		attempt.usage = result.usage;
		note = result.content.filter((block) => block.type === "text").map((block) => block.text).join(" ").replace(/\s+/gu, " ").trim();
		attempt.words = note ? note.split(" ").length : 0;
		check();
		if (result.stopReason !== "stop") throw new Failure(result.stopReason === "error" ? "model error" : "incomplete response", safe(result.errorMessage));
		if (!note || /[\u0000-\u001f\u007f-\u009f]/u.test(note)) throw new Failure("invalid note");
		if (attempt.words <= MAX_WORDS) {
			if (note.length > 2000) throw new Failure("invalid note");
			break;
		}
		// Overlong text is never cut: the model shortens its own note in the same conversation.
		if (attempts.length > RETRY_WORDS.length) throw new Failure("note too long");
		messages = [...messages, result, { role: "user", content: shorten(attempt.words, RETRY_WORDS[attempts.length - 1]), timestamp: Date.now() }];
	}
	return storage(async () => {
		const db = await database();
		try {
			db.exec("BEGIN IMMEDIATE"); // Never wait for locks during shutdown.
			check();
			const inserted = db.prepare("INSERT OR IGNORE INTO afterwords (session_id, context_hash, task_id, reason, cwd, model, thinking_level, cost, created_at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
				.run(sessionId, hash, taskId ?? null, reason, cwd, `${author.provider ?? model.provider}/${author.responseModel ?? author.model ?? model.id}`, thinkingLevel, totalCost(attempts), new Date().toISOString(), note);
			check();
			db.exec("COMMIT");
			return inserted.changes ? note : undefined;
		} catch (error) {
			try { db.exec("ROLLBACK"); } catch { /* BEGIN may have failed. */ }
			throw error;
		} finally { db.close(); }
	});
}

export default function (pi: ExtensionAPI): void {
	if (process.env.PI_DELEGATE_CHILD === "1" || process.env.PI_REVIEW_WRAPPER_ACTIVE === "1") return;
	pi.registerCommand("pi-afterword", {
		description: "Browse saved afterword messages",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/pi-afterword requires interactive mode.", "error");
				return;
			}
			let notes;
			try {
				const db = await database();
				try {
					notes = db.prepare("SELECT id, note, created_at, cwd, reason, task_id, model, thinking_level, cost FROM afterwords ORDER BY created_at DESC, id DESC").all();
				} finally { db.close(); }
			} catch {
				ctx.ui.notify("Saved afterwords could not be read.", "error");
				return;
			}
			if (!notes.length) {
				ctx.ui.notify("No saved afterwords yet.", "info");
				return;
			}
			let selected = 0;
			let listTop = 0;
			while (true) {
				const index = await ctx.ui.custom<number | undefined>((tui, theme, keybindings, done) => {
					const scroll = new ScrollView(new Text(), { scrollbar: "hidden" });
					let starts: number[] = [];
					let previousWidth: number | undefined;
					let previousHeight: number | undefined;
					let revealSelection = false;
					const border = () => new DynamicBorder((text) => theme.fg("border", text));
					return {
						capturesViewportInput: true,
						render(width: number) {
							const header = new Container();
							header.addChild(border());
							header.addChild(new Spacer(1));
							header.addChild(new Text(theme.fg("accent", theme.bold(`Afterwords · ${notes.length} saved · newest first`)), 1, 0));
							header.addChild(new Spacer(1));
							const footer = new Container();
							footer.addChild(new Text(theme.fg("dim", `${selected + 1}/${notes.length}`), 1, 0));
							footer.addChild(new Spacer(1));
							footer.addChild(new Text(rawKeyHint("↑↓", "navigate") + "  " +
								keyHint("tui.select.pageUp", "up") + "  " + keyHint("tui.select.pageDown", "down") + "  " +
								keyHint("tui.select.confirm", "details") + "  " + keyHint("tui.select.cancel", "close"), 1, 0));
							footer.addChild(new Spacer(1));
							footer.addChild(border());
							const above = header.render(width);
							const below = footer.render(width);
							const height = Math.max(1, tui.terminal.rows - above.length - below.length - 5);
							const indent = Math.min(3, Math.max(0, width - 1));
							const lines: string[] = [];
							starts = [];
							// SelectList truncates rows; Text supplies full, terminal-column-aware wrapping instead.
							for (const [i, row] of notes.entries()) {
								starts.push(lines.length);
								const active = i === selected;
								const label = theme.fg(active ? "accent" : "muted", `#${row.id} · ${String(row.created_at).slice(0, 16).replace("T", " ")} · ${row.model} · thinking: ${row.thinking_level ?? "unknown"} · cost: ${formatCost(row.cost)}`);
								const text = new Text(`${label}\n${theme.fg(active ? "accent" : "text", String(row.note))}`, 0, 0);
								for (const [j, line] of text.render(width - indent).entries()) {
									const prefix = active && j === 0 && indent === 3 ? theme.fg("accent", " → ") : " ".repeat(indent);
									lines.push(prefix + line);
								}
								lines.push("");
							}
							starts.push(lines.length);
							scroll.updateLayout(lines.length, height, () => tui.requestRender());
							if (previousWidth === undefined) scroll.scrollTo(listTop);
							else if (previousWidth !== width || previousHeight !== height) revealSelection = true;
							if (revealSelection) {
								const start = starts[selected];
								const end = starts[selected + 1] - 1;
								scroll.scrollTo(start < scroll.scrollTop || end - start > height ? start : Math.max(scroll.scrollTop, end - height));
								revealSelection = false;
							}
							previousWidth = width;
							previousHeight = height;
							listTop = scroll.scrollTop;
							return [...above, ...lines.slice(listTop, listTop + height), ...below];
						},
						invalidate() {},
						handleInput(data: string) {
							if (keybindings.matches(data, "tui.select.cancel")) { done(undefined); return; }
							if (keybindings.matches(data, "tui.select.confirm")) { done(selected); return; }
							if (keybindings.matches(data, "tui.select.up") || data === "k") {
								selected = Math.max(0, selected - 1);
								revealSelection = true;
							} else if (keybindings.matches(data, "tui.select.down") || data === "j") {
								selected = Math.min(notes.length - 1, selected + 1);
								revealSelection = true;
							} else if (keybindings.matches(data, "tui.select.pageUp") || keybindings.matches(data, "tui.select.pageDown")) {
								scroll.scrollBy((keybindings.matches(data, "tui.select.pageUp") ? -1 : 1) * scroll.viewportHeight);
								selected = Math.max(0, starts.findLastIndex((start, i) => i < notes.length && start <= scroll.scrollTop));
							}
							listTop = scroll.scrollTop;
							tui.requestRender();
						},
					};
				});
				if (index === undefined) return;
				const row = notes[index];
				await ctx.ui.custom<void>((tui, _theme, keybindings, done) => {
					const text = new Text(`${row.note}\n\n${row.created_at} · ${row.model} · thinking: ${row.thinking_level ?? "unknown"} · cost: ${formatCost(row.cost)}\n${row.reason}${row.task_id === null ? "" : ` · task ${row.task_id}`}\n${row.cwd}`, 0, 0);
					const scroll = new ScrollView(text, { scrollbar: "hidden" });
					return {
						capturesViewportInput: true,
						render(width: number) {
							const lines = text.render(Math.max(1, width - 2));
							const height = Math.max(1, tui.terminal.rows - 16); // Reserve native dialog chrome and Pi's footer.
							scroll.updateLayout(lines.length, height, () => tui.requestRender());
							const description = lines.slice(scroll.scrollTop, scroll.scrollTop + height).join("\n");
							return new ExtensionSelectorComponent(`Afterword #${row.id} · ${scroll.scrollTop + 1}/${lines.length}`,
								["Back"], () => done(), () => done(), { description }).render(width);
						},
						invalidate() { text.invalidate(); },
						handleInput(data: string) {
							if (keybindings.matches(data, "tui.select.confirm") || keybindings.matches(data, "tui.select.cancel")) done();
							else if (keybindings.matches(data, "tui.select.up")) scroll.scrollBy(-1);
							else if (keybindings.matches(data, "tui.select.down")) scroll.scrollBy(1);
							else if (keybindings.matches(data, "tui.select.pageUp")) scroll.scrollBy(-scroll.viewportHeight);
							else if (keybindings.matches(data, "tui.select.pageDown")) scroll.scrollBy(scroll.viewportHeight);
						},
					};
				});
			}
		},
	});
	let shuttingDown: ShutdownTrigger | undefined;
	let unsubscribe: (() => void) | undefined;
	let lifetime = new AbortController();
	const active = new Map<string, Promise<void>>();
	// Pi forgets a per-run replacement prompt once the run settles. It sets forceSystemPrompt on
	// these shared options after all before_agent_start handlers; a run may still fail to start.
	type RunOptions = { forceSystemPrompt?: string } | undefined;
	let pendingOptions: RunOptions;
	let runOptions: RunOptions;
	pi.on("before_agent_start", (event) => { pendingOptions = event.systemPromptOptions; });
	pi.on("session_tree", () => { runOptions = undefined; }); // The run belonged to the branch just left.
	// A real turn that starts during generation takes precedence over the afterword request.
	const generating = new Set<AbortController>();
	pi.on("agent_start", () => {
		runOptions = pendingOptions;
		for (const controller of generating) controller.abort();
	});

	// Async converts snapshot/setup exceptions into registered work, not bus errors.
	const leaveAfterword = async (ctx: ExtensionContext, reason: Reason, taskId?: number, source?: AbortSignal): Promise<void> => {
		const deadline = performance.now() + DEADLINE_MS;
		const state = snapshot(pi, ctx, runOptions?.forceSystemPrompt);
		if (!state) return Promise.resolve();
		// Done followed by quit or /new shares in-flight work; SQLite deduplicates saved history.
		const key = `${state.sessionId}:${state.hash}`;
		if (active.has(key)) return active.get(key)!;
		const controller = new AbortController();
		const signal = AbortSignal.any([controller.signal, lifetime.signal]);
		// Pinote can tear down first on quit or /new; our own awaited shutdown hook finishes this work.
		const onSourceAbort = () => { if (!isShutdownTrigger(source?.reason)) controller.abort(); };
		generating.add(controller);
		source?.addEventListener("abort", onSourceAbort, { once: true });
		if (source?.aborted) onSourceAbort();
		let timer: ReturnType<typeof setTimeout>;
		let timedOut = false;
		let onAbort: () => void;
		const interrupted = new Promise<never>((_resolve, reject) => {
			onAbort = () => reject(new Error("Afterword interrupted"));
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
			timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(0, deadline - performance.now()));
		});
		const quitting = () => shuttingDown === "quit" || source?.reason === "quit";
		const notify = (message: string) => {
			if (quitting() && !process.stdin.isRaw) console.log(message);
			else ctx.ui.notify(message, "info");
		};
		const attempts: Attempt[] = [];
		// Session-file diagnostics only: custom entries never reach the model or the conversation hash.
		let logged = false;
		const log = (outcome: string, failure?: Failure) => {
			if (logged) return; // A failed notice must not relabel a saved note.
			logged = true;
			try {
				pi.appendEntry("pi-afterword", {
					outcome, trigger: reason, taskId, model: state.model && `${state.model.provider}/${state.model.id}`,
					ms: Math.round(performance.now() - deadline + DEADLINE_MS), failure: failure?.category, detail: failure?.detail,
					// An interrupted request is still pending: report its elapsed time so far.
					attempts: attempts.map(({ started, ms, ...rest }) => ({ ms: ms ?? Math.round(performance.now() - started), ...rest })),
				});
			} catch { /* The session may already be closed or replaced. */ }
		};
		const work = Promise.race([record(ctx, state, reason, taskId, signal, deadline, attempts, () => notify("Generating afterword…")), interrupted])
			.then((note) => {
				if (attempts.length) log(note ? "saved" : "duplicate");
				if (!note) return;
				const cost = totalCost(attempts);
				const message = `Afterword saved${cost === null ? "" : ` (cost ${formatCost(cost)})`}:\n${note}`;
				if (shuttingDown === "new" || source?.reason === "new") {
					const file = ctx.sessionManager.getSessionFile();
					const notices = newSessionNotices.get(file) ?? [];
					notices.push(message);
					newSessionNotices.set(file, notices);
				} else if (quitting() && process.stdin.isRaw) {
					// Signal shutdown runs before Pi restores the fullscreen terminal.
					process.once("exit", () => {
						try { writeSync(1, `${message}\n`); } catch { /* Terminal disconnected. */ }
					});
				} else notify(message);
			})
			.catch((error) => {
				const failure = timedOut ? new Failure("timed out") : signal.aborted ? new Failure("interrupted")
					: error instanceof Failure ? error : new Failure("unexpected error", detail(error));
				log("failed", failure);
				// Never show provider errors or generated text: only the category.
				if (!lifetime.signal.aborted && !source?.aborted) {
					if (reason === "done") ctx.ui.notify(`Afterword was not saved (${failure.category}). Task completion will continue.`, "warning");
					else console.error(`pi-afterword: note was not saved (${failure.category}).`);
				}
			})
			.finally(() => {
				clearTimeout(timer);
				signal.removeEventListener("abort", onAbort);
				// Rejected responses (e.g. a tool call) can leave a provider request open: end it.
				controller.abort();
				source?.removeEventListener("abort", onSourceAbort);
				generating.delete(controller);
				active.delete(key);
			});
		active.set(key, work);
		return work;
	};

	pi.on("session_start", async (event, ctx) => {
		unsubscribe?.();
		lifetime = new AbortController();
		shuttingDown = undefined;
		pendingOptions = runOptions = undefined;
		if (ctx.mode !== "tui") return;
		if (event.reason === "new") {
			const notices = newSessionNotices.get(event.previousSessionFile);
			if (notices) {
				newSessionNotices.delete(event.previousSessionFile);
				ctx.ui.notify(notices.join("\n\n"), "info");
			}
		}
		unsubscribe = pi.events.on("pinote:task-completed", (data: unknown) => {
			if (!data || typeof data !== "object") return;
			const event = data as Completion;
			if (!Number.isSafeInteger(event.taskId) || event.taskId < 1 || !(event.signal instanceof AbortSignal) || typeof event.waitUntil !== "function") return;
			// Registration must happen synchronously: the shared bus does not await handlers.
			event.waitUntil(leaveAfterword(ctx, "done", event.taskId, event.signal));
		});
		if (event.reason !== "startup") return;
		try {
			let count = 0;
			const path = join(getAgentDir(), "afterword", "afterword.db");
			try {
				statSync(path);
				const { DatabaseSync } = await import("node:sqlite");
				const db = new DatabaseSync(path, { readOnly: true });
				try { count = db.prepare("SELECT COUNT(*) AS count FROM afterwords").get()!.count as number; }
				finally { db.close(); }
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			// Native notifications are UI-only: no session entry or model context.
			ctx.ui.notify(`Afterwords: ${count}`, "info");
		} catch {
			ctx.ui.notify("Afterwords: unavailable.", "warning");
		}
	});
	pi.on("session_shutdown", async (event, ctx) => {
		try {
			if (isShutdownTrigger(event.reason) && ctx.mode === "tui") {
				shuttingDown = event.reason;
				await leaveAfterword(ctx, event.reason);
			}
		} catch {
			console.error("pi-afterword: note was not saved (session context unavailable).");
		} finally {
			lifetime.abort();
			unsubscribe?.();
			unsubscribe = undefined;
		}
	});
}
