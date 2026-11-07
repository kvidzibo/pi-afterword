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
			const before = db.prepare("SELECT * FROM afterwords ORDER BY id").all();
			let lists = 0;
			let savedList: string[];
			browse = (component, terminal) => {
				const initial = plain(component.render(100)).join("\n");
				if (/Afterwords ·/.test(initial)) {
					lists++;
					if (lists === 1) {
						assert.match(initial, /7 saved · newest first/);
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
			assert.match(details[0], /task 381/);
			assert.match(details[0], /\/project-7/);
			assert.match(details[1], /Afterword #2/);
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
					const narrowText = render(30);
					assert.ok(narrowText.length <= 13, "Paging keeps the narrow list bounded");
					assert.match(plain(narrowText).join("\n"), /BEGIN/, "Narrow list can scroll from the selected label into its text");
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
	const handlers = new Map<string, Function>();
	const listeners = new Map<string, Function>();
	const notices: string[] = [];
	const pi = {
		registerCommand: () => {},
		on: (event: string, handler: Function) => handlers.set(event, handler),
		events: { on: (event: string, handler: Function) => { listeners.set(event, handler); return () => { listeners.delete(event); }; } },
	};
	let note = "Keep completion hooks outside Pinote's serial queue so callbacks can query task state without deadlocking the final database write operation. Keep the waitUntil registration synchronous to prevent task completion races.";
	const result = () => ({ stopReason: "stop", content: [{ type: "text", text: note }] });
	let calls = 0;
	let provider: () => Promise<any> = async () => result();
	const session = SessionManager.inMemory(temp);
	const append = (text: string) => {
		session.appendMessage({ role: "user", content: text, timestamp: Date.now() });
		session.appendMessage({ role: "assistant", content: [{ type: "text", text: `Verified ${text}` }], timestamp: Date.now(), stopReason: "stop" });
	};
	const ctx = {
		mode: "tui", hasUI: true, cwd: temp, sessionManager: session,
		model: { provider: "test", id: "afterword", contextWindow: 32768 },
		modelRegistry: { streamSimple(model: unknown, context: any, options: any) {
			calls++;
			assert.equal(model, ctx.model);
			assert.equal(context.messages.length, 2);
			assert.equal(context.tools, undefined, "No executable tools in final request");
			assert.match(context.messages[0].content, /untrusted reference material/);
			assert.match(context.messages[0].content, /durable, non-obvious lesson/);
			assert.match(context.messages[0].content, /If no such lesson exists, preserve the most consequential decision and its rationale/);
			assert.match(context.messages[0].content, /Avoid PR status, test counts, completion summaries, and routine next steps/);
			assert.match(context.messages[0].content, /Maximum 30 whitespace-separated words/);
			assert.ok(context.messages[1].content.length <= 64032);
			assert.equal(options.reasoning, "minimal");
			assert.ok(options.signal instanceof AbortSignal);
			return { result: provider };
		} },
		ui: { notify: (message: string) => notices.push(message) },
	};
	const rows = () => {
		const db = new DatabaseSync(path);
		try { return db.prepare("SELECT * FROM afterwords ORDER BY id").all(); }
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
		pinoteLifetime.abort("quit"); // Pinote’s earlier shutdown handler tears down its lifetime first.
		const quitting = handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
		finishDone(result());
		await Promise.all([completing, quitting]);
		provider = async () => result();
		assert.equal(calls, 1, "Concurrent Done and quit share one request");
		let saved = rows();
		assert.equal(saved.length, 1);
		assert.equal(saved[0].note, note);
		assert.equal(String(saved[0].note).split(" ").length, 30);
		assert.equal(saved[0].task_id, 381);
		assert.equal(saved[0].reason, "done");
		assert.equal(saved[0].session_id, session.getSessionId());
		assert.equal(saved[0].model, "test/afterword");
		assert.equal(statSync(path).mode & 0o777, 0o600);
		assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
		assert.equal(listeners.size, 0, "Shutdown detaches completion listener");
		await handlers.get("session_start")!({ reason: "reload" }, ctx);
		await done();
		assert.equal(calls, 1, "SQLite deduplication survives extension reload");
		append("new information");
		note = "New verified information can produce another afterword in the same session.";
		await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
		saved = rows();
		assert.equal(saved.length, 2);
		assert.equal(saved[1].reason, "quit");
		assert.equal(saved[1].task_id, null);
		await handlers.get("session_start")!({ reason: "startup" }, ctx);
		append("invalid response");
		note = Array(31).fill("word").join(" ");
		await done();
		assert.equal(rows().length, 2, "Overlong text is rejected, not silently cut");
		assert.match(notices.at(-1)!, /not saved/);
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
		append("contended database write");
		const blocker = new DatabaseSync(path);
		try {
			provider = async () => { blocker.exec("BEGIN IMMEDIATE"); return result(); };
			await done(); // Must settle while the competing write lock is still held.
		} finally { blocker.exec("ROLLBACK"); blocker.close(); }
		assert.equal(rows().length, 2, "Write contention never queues a late insert");
		append("cancelled response");
		const aborted = new AbortController(); aborted.abort();
		const beforeAbort = calls;
		await done(aborted.signal);
		assert.equal(calls, beforeAbort);

		append("hung provider");
		let release!: (value: any) => void;
		provider = () => new Promise((resolve) => { release = resolve; });
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const pending = done();
		for (let i = 0; i < 100 && !release; i++) await nextTick();
		assert.equal(typeof release, "function");
		t.mock.timers.tick(20_000);
		await pending;
		t.mock.timers.reset();
		note = "This late result must never be saved.";
		release(result());
		await nextTick();
		assert.equal(rows().length, 2, "An uncooperative provider cannot write after timeout");
		const keep = session.appendMessage({ role: "user", content: "Continue after compaction", timestamp: Date.now() });
		session.appendCompaction("Verified queue isolation; remaining checks pending.", keep, 1000);
		assert.deepEqual(session.buildSessionProjection().messages.map((message: any) => message.role), ["compactionSummary", "user"]);
		provider = async () => result();
		note = "Queue isolation was verified before compaction; finish the remaining checks.";
		await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
		assert.equal(rows().length, 3, "Compacted-away assistant messages still support an afterword");
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
