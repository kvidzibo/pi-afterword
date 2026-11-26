import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setImmediate as nextTick } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

const piBin = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const require = createRequire(piBin);
const tuiPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-tui"));
const { createJiti } = require("jiti");
const afterword = await createJiti(import.meta.url, {
	alias: {
		"@earendil-works/pi-coding-agent": join(dirname(piBin), "index.js"),
		"@earendil-works/pi-tui": tuiPath,
	}, tryNative: false,
}).import(fileURLToPath(new URL("../index.ts", import.meta.url)), { default: true });
const { SessionManager } = await import(pathToFileURL(join(dirname(piBin), "core/session-manager.js")).href);
const { convertToLlm } = await import(pathToFileURL(join(dirname(piBin), "index.js")).href);
const { getCurrentSystemPrompt } = await import("@earendil-works/pi-ai");
const startRun = (handlers: Map<string, Function>, ctx: unknown, forceSystemPrompt?: string, started = true) => {
	const systemPromptOptions: any = { sections: {} };
	handlers.get("before_agent_start")!({ type: "before_agent_start", prompt: "", systemPromptOptions }, ctx);
	if (forceSystemPrompt !== undefined) systemPromptOptions.forceSystemPrompt = forceSystemPrompt; // Pi sets it after all handlers.
	if (started) handlers.get("agent_start")!({ type: "agent_start" }, ctx);
};
const themeModule = await import(pathToFileURL(join(dirname(piBin), "modes/interactive/theme/theme.js")).href);
themeModule.initTheme("dark");
const { getKeybindings, visibleWidth } = await import(pathToFileURL(tuiPath).href);

test("command browses saved messages across projects without generating or modifying notes", async () => {
	const temp = mkdtempSync("/tmp/pi-afterword-browser-test-");
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = temp;
	let command: any;
	const notices: string[] = [];
	const details: string[] = [];
	const plain = (lines: string[]) => lines.map(stripVTControlCharacters);
	const compact = (text: string) => text.replace(/\s/gu, "");
	const note = (i: number) => `Message ${i}: Keep useful verified lessons accessible across sessions and projects without automatically injecting them into future model conversations.`;
	let browse: (component: any, terminal: { rows: number }) => void;
	let customCalls = 0;
	const ctx = {
		mode: "tui",
		ui: {
			notify: (message: string) => notices.push(message),
			select: async () => { assert.fail("Browsing uses one scrolling custom list, not select pagination"); },
			custom: async (factory: Function) => {
				customCalls++;
				assert.ok(customCalls <= 12, "Deterministic browsing must terminate");
				let closed = false;
				let result: unknown;
				const terminal = { rows: 70 };
				const component = factory({ terminal, requestRender: () => {} }, themeModule.theme, getKeybindings(), (value: unknown) => {
					assert.equal(closed, false, "Each custom view closes once");
					closed = true;
					result = value;
				});
				browse(component, terminal);
				assert.ok(closed, "Interactions close every custom view before returning");
				return result;
			},
		},
	};
	try {
		afterword({ registerCommand: (name: string, definition: any) => {
			assert.equal(name, "pi-afterword"); command = definition;
		}, on: () => {} });
		await command.handler("", { ...ctx, mode: "rpc" });
		assert.match(notices.pop()!, /requires interactive/);
		await command.handler("", ctx);
		assert.match(notices.pop()!, /No saved afterwords/);
		const db = new DatabaseSync(join(temp, "afterword", "afterword.db"));
		try {
			const insert = db.prepare("INSERT INTO afterwords (session_id, context_hash, task_id, reason, cwd, model, created_at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
			for (let i = 1; i <= 7; i++) insert.run(`session-${i}`, `hash-${i}`, i === 7 ? 381 : null,
				i === 7 ? "done" : "quit", `/project-${i}`, "test/model", "2026-06-01T12:00:00.000Z", note(i));
			db.prepare("UPDATE afterwords SET model = 'test/other-model', thinking_level = 'minimal' WHERE id = 7").run();
			const before = db.prepare("SELECT * FROM afterwords ORDER BY id").all();
			let lists = 0;
			let savedList: string[];
			browse = (component, terminal) => {
				const initial = plain(component.render(100)).join("\n");
				if (/Afterwords ·/.test(initial)) {
					lists++;
					if (lists === 1) {
						assert.match(initial, /7 saved · newest first/);
						assert.match(initial, /#7 · 2026-06-01 12:00 · test\/other-model · thinking: minimal/);
						assert.match(initial, /#6 · 2026-06-01 12:00 · test\/model · thinking: unknown/);
						assert.deepEqual([...initial.matchAll(/#(\d+) ·/g)].map((match) => Number(match[1])), [7, 6, 5, 4, 3, 2, 1]);
						for (let i = 1; i <= 7; i++) assert.ok(compact(initial).includes(compact(note(i))), `Full text of note ${i}, including beyond 60 characters`);
						assert.doesNotMatch(initial, /…|\.\.\./, "No preview ellipsis");
					}
					terminal.rows = 24;
					const returned = component.render(60);
					assert.ok(returned.length <= terminal.rows - 5, "List leaves room for the native footer");
					if (lists > 1) assert.deepEqual(returned, savedList, "Details preserve list selection and exact scroll position");
					if (lists === 2) {
						for (const key of ["\u001b[B", "j", "\u001b[B", "j", "\u001b[B", "j"]) {
							component.handleInput(key); component.render(60);
						}
						assert.match(plain(component.render(60)).join("\n"), /7\/7/, "Arrows and j select beyond the old five-note page");
						for (const key of ["\u001b[A", "k", "j"]) { component.handleInput(key); component.render(60); }
						assert.match(plain(component.render(60)).join("\n"), /6\/7/);
					}
					savedList = component.render(60);
					component.handleInput(lists === 3 ? "\u001b" : "\r");
				} else {
					terminal.rows = 24;
					details.push(plain(component.render(60)).join("\n"));
					assert.match(details.at(-1)!, /Afterword #/);
					component.handleInput(details.length === 1 ? "\r" : "\u001b");
				}
			};
			await command.handler("", ctx);
			assert.equal(lists, 3);
			assert.equal(details.length, 2);
			assert.match(details[0], /Afterword #7/);
			assert.match(details[0], /future model conversations\./);
			assert.match(compact(details[0]), /test\/other-model·thinking:minimal/);
			assert.match(details[0], /task 381/);
			assert.match(details[0], /\/project-7/);
			assert.match(details[1], /Afterword #2/);
			assert.match(compact(details[1]), /test\/model·thinking:unknown/);
			assert.doesNotMatch(details[1], /task /);
			assert.deepEqual(db.prepare("SELECT * FROM afterwords ORDER BY id").all(), before);
			const longNote = `BEGIN ${Array(18).fill("界e\u0301".repeat(34)).join(" ")} END`;
			db.prepare("UPDATE afterwords SET note = ? WHERE id = 7").run(longNote);
			const longBefore = db.prepare("SELECT * FROM afterwords ORDER BY id").all();
			let longLists = 0;
			let longDetails = 0;
			browse = (component, terminal) => {
				terminal.rows = 24;
				const render = (width: number) => {
					const lines: string[] = component.render(width);
					assert.ok(lines.every((line) => visibleWidth(line) <= width), "Wrapping respects terminal columns, including wide and combining characters");
					return lines;
				};
				const start = render(40);
				if (/Afterwords ·/.test(plain(start).join("\n"))) {
					longLists++;
					assert.ok(start.length <= 19, "List height is bounded by rows minus five");
					if (longLists === 2) {
						assert.deepEqual(start, savedList, "Returning from a long detail restores a nonzero list scroll position");
						component.handleInput("\u001b");
						return;
					}
					assert.match(plain(start).join("\n"), /BEGIN/);
					const seen = [plain(start).join("\n")];
					let end = start;
					for (let i = 0; i < 100 && !/END/.test(plain(end).join("\n")); i++) {
						component.handleInput("\u001b[6~"); end = render(40); seen.push(plain(end).join("\n"));
					}
					assert.match(plain(end).join("\n"), /END/, "PgDn reaches the end of a note taller than the viewport");
					assert.doesNotMatch(seen.join("\n"), /…|\.\.\./);
					assert.match(plain(end).join("\n"), /1\/7/, "Line paging remains within the oversized first note");
					for (let i = 0; i < 100; i++) { component.handleInput("\u001b[5~"); render(40); }
					assert.deepEqual(render(40), start, "PgUp restores the beginning of full list content");
					terminal.rows = 18;
					const narrow = render(30);
					assert.ok(narrow.length <= 13, "Narrow resized list stays below rows minus five");
					component.handleInput("\u001b[6~");
					let narrowText = render(30);
					for (let i = 0; i < 10 && !/BEGIN/.test(plain(narrowText).join("\n")); i++) {
						component.handleInput("\u001b[6~"); narrowText = render(30);
						assert.ok(narrowText.length <= 13, "Paging keeps the narrow list bounded");
					}
					assert.match(plain(narrowText).join("\n"), /BEGIN/, "Narrow list can scroll from the wrapped metadata into its text");
					terminal.rows = 24;
					render(40);
					component.handleInput("\u001b[6~");
					savedList = render(40);
					assert.notDeepEqual(savedList, start, "Detail is opened with a nonzero list scroll offset");
					component.handleInput("\r");
				} else {
					longDetails++;
					assert.match(plain(start).join("\n"), /Afterword #7/);
					assert.ok(start.length <= 21, "Detail leaves room for the native footer");
					assert.match(plain(start).join("\n"), /BEGIN/);
					for (let i = 0; i < 30; i++) { component.handleInput("\u001b[6~"); render(40); }
					assert.match(plain(render(40)).join("\n"), /END/);
					terminal.rows = 18;
					assert.ok(render(30).length <= 15, "Resize keeps the detail bounded");
					for (let i = 0; i < 100; i++) { component.handleInput("\u001b[5~"); render(30); }
					assert.match(plain(render(30)).join("\n"), /BEGIN/);
					component.handleInput("\u001b");
				}
			};
			await command.handler("", ctx);
			assert.equal(longLists, 2);
			assert.equal(longDetails, 1);
			assert.deepEqual(db.prepare("SELECT * FROM afterwords ORDER BY id").all(), longBefore, "Browsing is read-only; no model APIs are provided");
			db.exec("DROP TABLE afterwords; CREATE TABLE afterwords (id INTEGER)");
			await command.handler("", ctx);
			assert.match(notices.pop()!, /could not be read/);
		} finally { db.close(); }
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(temp, { recursive: true, force: true });
	}
});

test("legacy databases retain saved models and unknown thinking levels across repeated opens", async () => {
	const temp = mkdtempSync("/tmp/pi-afterword-upgrade-");
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = temp;
	mkdirSync(join(temp, "afterword"));
	const db = new DatabaseSync(join(temp, "afterword", "afterword.db"));
	try {
		db.exec(`CREATE TABLE afterwords (
			id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, context_hash TEXT NOT NULL,
			task_id INTEGER, reason TEXT NOT NULL, cwd TEXT NOT NULL, model TEXT NOT NULL,
			created_at TEXT NOT NULL, note TEXT NOT NULL, UNIQUE (session_id, context_hash)
		);
		INSERT INTO afterwords VALUES (1, 'session', 'hash', NULL, 'quit', '/project',
			'legacy/original-model', '2026-06-01T12:00:00.000Z', 'Keep the verified lesson.');`);
		const original = db.prepare("SELECT * FROM afterwords").get();
		let command: any;
		afterword({ registerCommand: (_name: string, definition: any) => { command = definition; }, on: () => {} });
		const ctx = { mode: "tui", ui: {
			notify: () => assert.fail("Legacy notes should remain browsable"),
			custom: async (factory: Function) => {
				const component = factory({ terminal: { rows: 30 }, requestRender: () => {} }, themeModule.theme, getKeybindings(), () => {});
				const text = component.render(120).map(stripVTControlCharacters).join("\n");
				assert.match(text, /#1 · 2026-06-01 12:00 · legacy\/original-model · thinking: unknown/);
				assert.match(text, /Keep the verified lesson\./);
			},
		} };
		await command.handler("", ctx);
		await command.handler("", ctx);
		assert.equal(db.prepare("SELECT thinking_level FROM afterwords").get()!.thinking_level, null);
		const { thinking_level, ...saved } = db.prepare("SELECT * FROM afterwords").get()!;
		assert.deepEqual(saved, { ...original });
	} finally {
		db.close();
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(temp, { recursive: true, force: true });
	}
});

test("startup count is UI-only, read-only, and limited to interactive launches", async () => {
	const temp = mkdtempSync("/tmp/pi-afterword-count-");
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = temp;
	const path = join(temp, "afterword", "afterword.db");
	const handlers = new Map<string, Function>();
	const notices: unknown[] = [];
	const session = SessionManager.inMemory(temp);
	const pi = {
		on: (event: string, handler: Function) => handlers.set(event, handler),
		registerCommand: () => {},
		events: { on: () => () => {} },
	}; // No message, entry, or model APIs: using any would fail the test.
	const ctx = {
		mode: "tui", sessionManager: session,
		ui: { notify: (message: string, type: string) => notices.push({ message, type }) },
	};
	const start = (reason = "startup", mode = "tui") => handlers.get("session_start")!({ reason }, { ...ctx, mode });
	try {
		afterword(pi);
		const entries = structuredClone(session.getEntries());
		const projection = session.buildSessionProjection();
		await start();
		assert.deepEqual(notices.pop(), { message: "Afterwords: 0", type: "info" });
		assert.equal(existsSync(dirname(path)), false, "Startup does not create storage");
		mkdirSync(dirname(path));
		const db = new DatabaseSync(path);
		try {
			db.exec("CREATE TABLE afterwords (note TEXT); INSERT INTO afterwords VALUES ('first'), ('second')");
		} finally { db.close(); }
		const bytes = readFileSync(path);
		await start();
		assert.deepEqual(notices.pop(), { message: "Afterwords: 2", type: "info" });
		assert.deepEqual(readFileSync(path), bytes, "Counting never changes stored notes");
		for (const reason of ["reload", "new", "resume", "fork"]) await start(reason);
		for (const mode of ["rpc", "json", "print"]) await start("startup", mode);
		assert.deepEqual(notices, [], "No count outside interactive process startup");
		assert.deepEqual(session.getEntries(), entries, "No persisted count entry");
		assert.deepEqual(session.buildSessionProjection(), projection, "No model context changes");
		if (process.getuid?.() !== 0) {
			chmodSync(dirname(path), 0o000);
			try {
				await start();
				assert.deepEqual(notices.pop(), { message: "Afterwords: unavailable.", type: "warning" }, "Access failure is not an empty database");
			} finally { chmodSync(dirname(path), 0o700); }
		}
		writeFileSync(path, "not a database");
		await start();
		assert.deepEqual(notices.pop(), { message: "Afterwords: unavailable.", type: "warning" });
		assert.equal(readFileSync(path, "utf8"), "not a database", "Unreadable storage is not repaired or overwritten");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(temp, { recursive: true, force: true });
	}
});

// Real Pi projection and SQLite, deterministic provider only.
test("afterwords survive Done and quit once, reject invalid output, and cannot save after timeout", async (t) => {
	const temp = mkdtempSync("/tmp/pi-afterword-test-");
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = temp;
	const path = join(temp, "afterword", "afterword.db");
	const terminal: string[] = [];
	t.mock.method(console, "log", (message: string) => terminal.push(message));
	const handlers = new Map<string, Function>();
	const listeners = new Map<string, Function>();
	const notices: string[] = [];
	const logs: any[] = [];
	let thinking = "high";
	const settings: any = { thinkingBudgets: { high: 4096 } };
	const pi = {
		registerCommand: () => {},
		on: (event: string, handler: Function) => handlers.set(event, handler),
		events: { on: (event: string, handler: Function) => { listeners.set(event, handler); return () => { listeners.delete(event); }; } },
		appendEntry: (customType: string, data: any) => { assert.equal(customType, "pi-afterword"); logs.push(data); },
		getThinkingLevel: () => thinking,
		getSettings: () => structuredClone(settings),
	};
	let note = "Keep completion hooks outside Pinote's serial queue so callbacks can query task state without deadlocking the final database write operation. Keep the waitUntil registration synchronous to prevent task completion races.";
	const usage = { input: 2, output: 40, cacheRead: 9000, cacheWrite: 30, totalTokens: 9072, cost: { input: 0, output: 0.0008, cacheRead: 0.0018, cacheWrite: 0.0002, total: 0.0028 } };
	const result = () => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: note }], usage });
	let calls = 0;
	const requests: any[][] = [];
	let provider: () => Promise<any> = async () => result();
	const session = SessionManager.inMemory(temp);
	const append = (text: string) => {
		session.appendMessage({ role: "user", content: text, timestamp: Date.now() });
		session.appendMessage({ role: "assistant", content: [{ type: "text", text: `Verified ${text}` }], timestamp: Date.now(), stopReason: "stop" });
	};
	let idle = true;
	let replacedPrompt = false;
	const signals: AbortSignal[] = [];
	const ctx = {
		mode: "tui", hasUI: true, cwd: temp, sessionManager: session, isIdle: () => idle,
		model: { provider: "test", id: "afterword", contextWindow: 32768, reasoning: true },
		modelRegistry: { streamSimple(model: unknown, context: any, options: any) {
			calls++;
			assert.equal(model, ctx.model);
			requests.push(context.messages);
			assert.ok(options.signal instanceof AbortSignal);
			signals.push(options.signal);
			const { signal: _signal, ...rest } = options;
			assert.deepEqual(rest, { reasoning: thinking === "off" ? undefined : thinking, thinkingBudgets: settings.thinkingBudgets,
				sessionId: session.getSessionId(), disableContinuation: true, transport: "sse" }, "Session settings for cache reuse; no output cap or cache opt-out");
			if (/^That lesson has \d+ words; the limit is 30\. Rewrite it in at most \d+ words/.test(context.messages.at(-1).content)) {
				assert.deepEqual(context.messages.slice(0, -2), requests.at(-2), "Shortening continues the same conversation");
				assert.equal(context.messages.at(-2).role, "assistant");
				return { result: provider };
			}
			const history = convertToLlm(session.buildSessionProjection().messages);
			if (!settings.images?.blockImages && !replacedPrompt) assert.deepEqual(context.messages.slice(0, -1), history, "Repeats the session's own request");
			const question = context.messages.at(-1);
			assert.equal(question.role, "user");
			assert.match(question.content, /durable, non-obvious lesson you learned in this conversation/);
			assert.match(question.content, /If no such lesson exists, preserve the most consequential decision and its rationale/);
			assert.match(question.content, /Avoid PR status, test counts, completion summaries, and routine next steps/);
			assert.match(question.content, /Aim for at most 25 words; never exceed 30 whitespace-separated words/);
			assert.match(question.content, /do not call tools/);
			return { result: provider };
		} },
		ui: { notify: (message: string) => notices.push(message) },
	};
	const rows = () => {
		const db = new DatabaseSync(path);
		try { return db.prepare("SELECT * FROM afterwords ORDER BY id").all(); }
		finally { db.close(); }
	};
	const deleteLast = () => { // Later assertions count rows from before this case.
		const db = new DatabaseSync(path);
		try { db.exec("DELETE FROM afterwords WHERE id = (SELECT MAX(id) FROM afterwords)"); }
		finally { db.close(); }
	};
	const done = (signal = new AbortController().signal) => {
		const work: Promise<unknown>[] = [];
		listeners.get("pinote:task-completed")!({ taskId: 381, signal, waitUntil: (promise: Promise<unknown>) => work.push(promise) });
		assert.equal(work.length, 1, "Registers completion promise synchronously");
		return Promise.all(work);
	};
	try {
		afterword(pi);
		await handlers.get("session_start")!({ reason: "startup" }, ctx);
		await handlers.get("session_shutdown")!({ reason: "reload" }, ctx);
		assert.equal(calls, 0, "Reload never requests an afterword");
		assert.equal(listeners.size, 0);
		await handlers.get("session_start")!({ reason: "reload" }, ctx);
		await done();
		assert.equal(calls, 0, "Empty session has no afterword");
		for (let i = 0; i < 9; i++) append(`verified step ${i}`);
		const ninthTurn = session.getLeafId()!;
		append("abandoned tenth turn");
		session.branch(ninthTurn);
		await done();
		await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
		assert.equal(calls, 0, "Done and quit skip nine agent turns; abandoned branches do not count");
		assert.deepEqual(notices.splice(0), ["Afterwords: 0"]);
		assert.equal(existsSync(path), false, "Below the minimum does not create storage");
		await handlers.get("session_start")!({ reason: "reload" }, ctx);
		session.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "check", name: "bash", arguments: { command: "true" } }], timestamp: Date.now(), stopReason: "toolUse" });
		session.appendMessage({ role: "toolResult", toolCallId: "check", toolName: "bash", content: [{ type: "text", text: "Verified queue isolation" }], isError: false, timestamp: Date.now() });
		let finishDone!: (value: any) => void;
		provider = () => new Promise((resolve) => { finishDone = resolve; });
		const pinoteLifetime = new AbortController();
		const completing = done(pinoteLifetime.signal);
		for (let i = 0; i < 100 && !finishDone; i++) await nextTick();
		assert.equal(typeof finishDone, "function");
		assert.deepEqual(notices.splice(0), ["Generating afterword…"]);
		assert.deepEqual(terminal, []);
		pinoteLifetime.abort("quit"); // Pinote’s earlier shutdown handler tears down its lifetime first.
		const quitting = handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
		finishDone(result());
		await Promise.all([completing, quitting]);
		provider = async () => result();
		assert.equal(calls, 1, "Concurrent Done and quit share one request");
		let saved = rows();
		assert.equal(saved.length, 1);
		assert.equal(saved[0].note, note);
		assert.deepEqual(terminal.splice(0), [`Afterword saved:\n${saved[0].note}`]);
		assert.equal(String(saved[0].note).split(" ").length, 30);
		assert.equal(saved[0].task_id, 381);
		assert.equal(saved[0].reason, "done");
		assert.equal(saved[0].session_id, session.getSessionId());
		assert.equal(saved[0].model, "test/afterword");
		assert.equal(saved[0].thinking_level, "high", "The session's thinking level");
		assert.deepEqual(logs.at(-1).attempts.map((attempt: any) => attempt.usage), [usage], "Diagnostics record token usage and cost");
		assert.equal(statSync(path).mode & 0o777, 0o600);
		assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
		assert.equal(listeners.size, 0, "Shutdown detaches completion listener");
		await handlers.get("session_start")!({ reason: "reload" }, ctx);
		await done();
		assert.equal(calls, 1, "SQLite deduplication survives extension reload");
		await handlers.get("session_shutdown")!({ reason: "new" }, ctx);
		assert.equal(calls, 1, "/new does not regenerate an unchanged Done lesson");
		assert.deepEqual(notices, []);
		assert.deepEqual(terminal, []);
		await handlers.get("session_start")!({ reason: "resume" }, ctx);
		append("new information");
		ctx.model.reasoning = false;
		thinking = "off";
		note = "New verified information can produce another afterword in the same session.";
		await handlers.get("session_shutdown")!({ reason: "new" }, ctx);
		saved = rows();
		assert.equal(saved.length, 2);
		assert.equal(saved[1].reason, "new");
		assert.equal(saved[1].session_id, session.getSessionId());
		assert.equal(saved[1].thinking_level, "off");
		assert.equal(saved[1].task_id, null);
		afterword(pi); // /new binds a fresh extension instance before showing the note.
		await handlers.get("session_start")!({ reason: "new", previousSessionFile: session.getSessionFile() }, ctx);
		assert.deepEqual(notices.splice(0), ["Generating afterword…", `Afterword saved:\n${saved[1].note}`]);
		append("invalid response");
		note = Array(31).fill("word").join(" ");
		await done();
		assert.equal(rows().length, 2, "Overlong text is rejected, not silently cut");
		assert.deepEqual(notices.splice(0), ["Generating afterword…", "Afterword was not saved (note too long). Task completion will continue."]);
		assert.deepEqual(requests.slice(-3).map((request) => request.at(-1).content.match(/^That lesson has 31 words; the limit is 30\. Rewrite it in at most (\d+) words/)?.[1]),
			[undefined, "20", "15"], "Two shortening retries asking for fewer words, then give up");
		assert.partialDeepStrictEqual(logs.at(-1), { outcome: "failed", trigger: "done", taskId: 381, model: "test/afterword", failure: "note too long" });
		assert.deepEqual(logs.at(-1).attempts.map((attempt: any) => [attempt.stopReason, attempt.words]), [["stop", 31], ["stop", 31], ["stop", 31]]);
		assert.doesNotMatch(JSON.stringify(logs), /word word/, "Diagnostics never contain note text");
		const short = "The model shortened its own overlong note when asked.";
		const replies = [Array(31).fill("word").join(" "), short];
		provider = async () => { note = replies.shift()!; return result(); };
		await done();
		provider = async () => result();
		assert.equal(rows().at(-1)!.note, short);
		assert.equal(requests.at(-1)!.at(-2).content[0].text, Array(31).fill("word").join(" "), "The model sees its own rejected note");
		assert.partialDeepStrictEqual(logs.at(-1), { outcome: "saved", attempts: [{ words: 31, usage }, { words: 9, usage }] });
		deleteLast();
		append("blocked images");
		const image = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
		session.appendMessage({ role: "user", content: [{ type: "text", text: "See" }, image, image, { type: "text", text: "and" }, image], timestamp: Date.now() });
		settings.images = { blockImages: true };
		const entries = session.getEntries().length;
		await done();
		settings.images = { blockImages: false };
		assert.equal(session.getEntries().length, entries, "The request never enters the session");
		const blocked = "Image reading is disabled.";
		assert.deepEqual(requests.at(-1)!.at(-2).content, [{ type: "text", text: "See" }, { type: "text", text: blocked }, { type: "text", text: "and" }, { type: "text", text: blocked }], "Pi's blocked-image placeholders");
		assert.deepEqual(requests.at(-1)!.slice(0, -2), convertToLlm(session.buildSessionProjection().messages).slice(0, -1));
		deleteLast();
		append("run with a replaced prompt");
		const tool = { name: "bash", description: "Run a command", parameters: { type: "object", properties: {} } };
		session.appendMessage({ role: "system", content: "", sections: { project: "PROJECT-MARKER" }, toolsAdded: [tool], timestamp: Date.now() });
		session.appendMessage({ role: "system", content: "", sections: { project: null }, timestamp: Date.now() });
		append("after the system messages");
		const recordedPrompt = getCurrentSystemPrompt(convertToLlm(session.buildSessionProjection().messages));
		for (const forced of ["Prompt replaced for this run", recordedPrompt]) {
			startRun(handlers, ctx, forced);
			replacedPrompt = true;
			await done();
			replacedPrompt = false;
			const replaced = requests.at(-1)!;
			assert.partialDeepStrictEqual(replaced[0], { role: "system", content: forced, toolsAdded: [tool] }, "Pi's per-run prompt projection, even for identical text");
			assert.deepEqual(replaced.slice(1, -1), convertToLlm(session.buildSessionProjection().messages).filter((message: any) => message.role !== "system"));
			assert.doesNotMatch(JSON.stringify(replaced), /PROJECT-MARKER/, "Never sends recorded prompt sections Pi replaced");
			deleteLast();
		}
		startRun(handlers, ctx, undefined, false);
		append("after a run that failed to start");
		replacedPrompt = true;
		await done();
		replacedPrompt = false;
		assert.doesNotMatch(JSON.stringify(requests.at(-1)), /PROJECT-MARKER/, "Only a started run replaces the last run's prompt");
		deleteLast();
		handlers.get("session_tree")!({ type: "session_tree" }, ctx);
		append("after tree navigation");
		await done(); // The mock asserts the recorded history, system messages included.
		deleteLast();
		startRun(handlers, ctx);
		append("after an unforced run");
		await done();
		assert.match(JSON.stringify(requests.at(-1)), /PROJECT-MARKER/, "Unforced runs keep Pi's recorded system messages");
		deleteLast();
		append("agent still running");
		idle = false;
		const beforeBusy = calls;
		await done();
		idle = true;
		assert.equal(calls, beforeBusy, "Never sends a session request during a running turn");
		assert.deepEqual(notices.splice(0).at(-1), "Afterword was not saved (agent busy). Task completion will continue.");
		assert.partialDeepStrictEqual(logs.at(-1), { outcome: "failed", failure: "agent busy", attempts: [] });
		const becomingBusy = done(); // A turn starts while the duplicate check is pending.
		idle = false;
		await becomingBusy;
		idle = true;
		assert.equal(calls, beforeBusy, "Idle is rechecked when the request would be sent");
		assert.equal(logs.at(-1).failure, "agent busy");
		let finishTurn!: (value: any) => void;
		provider = () => new Promise((resolve) => { finishTurn = resolve; });
		const overtaken = done();
		for (let i = 0; i < 100 && !finishTurn; i++) await nextTick();
		handlers.get("agent_start")!({ type: "agent_start" }, ctx);
		assert.equal(signals.at(-1)!.aborted, true, "A real turn ends the afterword request");
		finishTurn(result());
		await overtaken;
		provider = async () => result();
		assert.equal(logs.at(-1).failure, "interrupted");
		notices.splice(0);
		append("tool call instead of a note");
		provider = async () => ({ stopReason: "toolUse", content: [{ type: "toolCall", id: "call", name: "bash", arguments: {} }], usage });
		await done();
		provider = async () => result();
		assert.partialDeepStrictEqual(logs.at(-1), { outcome: "failed", failure: "incomplete response", attempts: [{ stopReason: "toolUse" }] });
		assert.equal(signals.at(-1)!.aborted, true, "A rejected response's provider request is ended");
		append("reply over both limits");
		replies.push(Array(350).fill("sixsix").join(" "), short);
		provider = async () => { note = replies.shift()!; return result(); };
		await done();
		assert.equal(rows().at(-1)!.note, short, "A reply over the character limit is still shortened by its word count");
		append("provider echoes the rejected note");
		const secret = Array(31).fill("secret").join(" ");
		replies.push(secret);
		provider = async () => {
			if (!replies.length) return { stopReason: "error", errorMessage: `Invalid input: ${secret}`, content: [] };
			note = replies.shift()!; return result();
		};
		await done();
		assert.partialDeepStrictEqual(logs.at(-1), { outcome: "failed", failure: "model error", detail: undefined });
		provider = async () => ({ stopReason: "error", errorMessage: "429 rate limited", content: [] });
		await done();
		assert.partialDeepStrictEqual(logs.at(-1), { failure: "model error", detail: "429 rate limited" });
		assert.doesNotMatch(JSON.stringify(logs), /secret|sixsix/, "Diagnostics never contain note text, even echoed by the provider");
		deleteLast();
		notices.splice(0);
		const projection = session.buildSessionProjection.bind(session);
		session.buildSessionProjection = () => { throw new Error("isolated snapshot failure"); };
		const failedSnapshot = done(); // Must register its rejection rather than throw from the bus listener.
		await assert.rejects(failedSnapshot, /isolated snapshot failure/);
		session.buildSessionProjection = projection;
		append("expired elapsed deadline");
		note = "A valid result must not be saved after its elapsed deadline.";
		let elapsed = 0;
		const clock = t.mock.method(performance, "now", () => elapsed);
		provider = async () => { elapsed = 20_001; return result(); };
		await done();
		clock.mock.restore();
		assert.equal(rows().length, 2, "Elapsed deadline is enforced even before the timer can run");
		assert.equal(logs.at(-1).failure, "timed out");
		append("contended database write");
		const blocker = new DatabaseSync(path);
		try {
			provider = async () => { blocker.exec("BEGIN IMMEDIATE"); return result(); };
			await done(); // Must settle while the competing write lock is still held.
		} finally { blocker.exec("ROLLBACK"); blocker.close(); }
		assert.equal(rows().length, 2, "Write contention never queues a late insert");
		assert.equal(logs.at(-1).failure, "database error");
		append("cancelled response");
		const aborted = new AbortController(); aborted.abort();
		const beforeAbort = calls;
		await done(aborted.signal);
		assert.equal(calls, beforeAbort);

		append("hung provider");
		let release!: (value: any) => void;
		provider = () => new Promise((resolve) => { release = resolve; });
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const now = performance.now.bind(performance);
		const hung = t.mock.method(performance, "now", () => now() + elapsed);
		elapsed = 0;
		const pending = done();
		for (let i = 0; i < 100 && !release; i++) await nextTick();
		assert.equal(typeof release, "function");
		elapsed = 20_000;
		t.mock.timers.tick(20_000);
		await pending;
		hung.mock.restore();
		assert.equal(logs.at(-1).failure, "timed out");
		assert.ok(logs.at(-1).attempts[0].ms >= 20_000, "A still-pending request reports its elapsed time");
		t.mock.timers.reset();
		note = "This late result must never be saved.";
		release(result());
		await nextTick();
		assert.equal(rows().length, 2, "An uncooperative provider cannot write after timeout");
		const keep = session.appendMessage({ role: "user", content: "Continue after compaction", timestamp: Date.now() });
		session.appendCompaction("Verified queue isolation; remaining checks pending.", keep, 1000);
		assert.deepEqual(session.buildSessionProjection().messages.map((message: any) => message.role), ["system", "compactionSummary", "user"], "Compaction keeps the prompt checkpoint");
		note = "Queue isolation was verified before compaction; finish the remaining checks.";
		thinking = "medium";
		provider = async () => ({ ...result(), provider: "physical", model: "routed-alias", responseModel: "resolved-model", thinkingLevel: "low" });
		await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
		assert.equal(rows().length, 3, "Compacted-away assistant messages still support an afterword");
		assert.equal(rows()[2].model, "physical/resolved-model", "Prefer the provider-reported generating model over the routed alias");
		assert.equal(rows()[2].thinking_level, "medium", "The session's level, not one reported by the provider");
		assert.deepEqual(terminal, ["Generating afterword…", `Afterword saved:\n${rows()[2].note}`]);
		await handlers.get("session_start")!({ reason: "reload" }, ctx);
		await handlers.get("session_shutdown")!({ reason: "reload" }, ctx);
		await handlers.get("session_start")!({ reason: "startup" }, { ...ctx, mode: "rpc" });
		assert.equal(listeners.size, 0, "Noninteractive sessions never request notes");
	} finally {
		t.mock.timers.reset();
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(temp, { recursive: true, force: true });
	}
});
