// ==UserScript==
// @name               Inkstone — ChatGPT & Claude Conversation Exporter
// @name:zh-CN         Inkstone — ChatGPT / Claude 对话导出
// @namespace          https://github.com/ZhenHuangLab/inkstone
// @version            0.5.1
// @description        Grind ChatGPT and Claude conversations into Obsidian-friendly Markdown — high-fidelity export (math / citations / attachments / artifacts)
// @description:zh-CN  砚 · 把 ChatGPT 与 Claude 对话研磨成 Obsidian 友好的 Markdown，高保真导出（公式 / 引用 / 附件 / Artifact）
// @license            GPL-3.0-only
// @icon               data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%231e6b72%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22M12%203v12%22%2F%3E%3Cpath%20d%3D%22m7%2010%205%205%205-5%22%2F%3E%3Cpath%20d%3D%22M4%2017v2a2%202%200%200%200%202%202h12a2%202%200%200%200%202-2v-2%22%2F%3E%3C%2Fsvg%3E
// @downloadURL        https://github.com/ZhenHuangLab/inkstone/releases/latest/download/inkstone.user.js
// @updateURL          https://github.com/ZhenHuangLab/inkstone/releases/latest/download/inkstone.user.js
// @match              https://chatgpt.com/*
// @match              https://chat.openai.com/*
// @match              https://claude.ai/*
// @grant              GM_getValue
// @grant              GM_setValue
// @run-at             document-idle
// @noframes
// ==/UserScript==

(function() {
	"use strict";
	var ApiError = class extends Error {
		status;
		constructor(status, message) {
			super(message);
			this.status = status;
			this.name = "ApiError";
		}
	};
	var CancelledError = class extends Error {
		constructor() {
			super("已取消");
			this.name = "CancelledError";
		}
	};
	var SizeLimitError = class extends Error {
		actualBytes;
		constructor(actualBytes) {
			super(`附件大小 ${actualBytes} 字节超出上限`);
			this.actualBytes = actualBytes;
			this.name = "SizeLimitError";
		}
	};
	var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	var jitter = (base, spread = base) => base + Math.random() * spread;
	function parseRetryAfterSeconds(raw, now = Date.now()) {
		if (raw == null || raw.trim() === "") return 0;
		const seconds = Number(raw);
		if (Number.isFinite(seconds) && seconds > 0) return seconds;
		const at = Date.parse(raw);
		return Number.isFinite(at) && at > now ? Math.ceil((at - now) / 1e3) : 0;
	}
	function ensureAlive(cancel) {
		if (cancel?.cancelled) throw new CancelledError();
	}
	function createFetcher(cfg) {
		let spacingMs = cfg.spacingBaseMs;
		let requestsSinceRest = 0;
		let nextSlotAt = 0;
		let cooldownUntil = 0;
		let global429Streak = 0;
		let requests = 0;
		let hits429 = 0;
		let retryAfterHits = 0;
		let maxRetryAfterSec = 0;
		const slowDown = () => {
			spacingMs = Math.min(spacingMs * 1.5, cfg.spacingMaxMs);
		};
		const acquireSlot = async (cancel) => {
			for (;;) {
				ensureAlive(cancel);
				cancel?.beforeRequest?.();
				const now = Date.now();
				const target = Math.max(nextSlotAt, cooldownUntil);
				if (now >= target) {
					nextSlotAt = now + jitter(spacingMs, spacingMs * .4);
					if (cfg.restEveryN > 0 && ++requestsSinceRest >= cfg.restEveryN) {
						requestsSinceRest = 0;
						cooldownUntil = Math.max(cooldownUntil, now + cfg.restDurationMs);
					}
					return;
				}
				await sleep(Math.min(target - now, 500));
			}
		};
		const request = async (url, init = {}, cancel) => {
			let delay = 2e3;
			let headerless429s = 0;
			for (let attempt = 0;; attempt++) {
				await acquireSlot(cancel);
				ensureAlive(cancel);
				cancel?.beforeRequest?.();
				requests++;
				const res = await fetch(url, {
					credentials: "include",
					...init
				});
				if (res.ok) {
					global429Streak = 0;
					return res;
				}
				const retryable = res.status === 429 || res.status >= 500;
				let retryAfterMs = 0;
				if (res.status === 429) {
					hits429++;
					global429Streak++;
					slowDown();
					const retryAfterSec = parseRetryAfterSeconds(res.headers.get("retry-after"));
					retryAfterMs = retryAfterSec * 1e3;
					if (retryAfterMs > 0) {
						retryAfterHits++;
						maxRetryAfterSec = Math.max(maxRetryAfterSec, retryAfterSec);
						cooldownUntil = Math.max(cooldownUntil, Date.now() + retryAfterMs);
					} else if (global429Streak >= 5) cooldownUntil = Math.max(cooldownUntil, Date.now() + 15e3);
				}
				cancel?.beforeRequest?.();
				if (!retryable || attempt >= cfg.maxAttempts) throw new ApiError(res.status, `HTTP ${res.status}: ${url}`);
				if (res.status === 429) {
					if (retryAfterMs <= 0 && global429Streak < 5) {
						headerless429s++;
						if (headerless429s > 1) throw new ApiError(429, `HTTP 429（条目级，快速放弃）: ${url}`);
						await sleep(jitter(delay));
					}
				} else await sleep(jitter(delay));
				delay = Math.min(delay * 2, 3e4);
			}
		};
		return {
			request,
			stats: () => ({
				spacingMs: Math.round(spacingMs),
				requests,
				hits429,
				retryAfterHits,
				cooldownMs: Math.max(0, cooldownUntil - Date.now()),
				maxRetryAfterSec
			})
		};
	}
	async function fetchBinary$2(fetcher, url, cancel, maxBytes) {
		const res = await fetcher.request(url, {}, cancel);
		const declared = Number(res.headers.get("content-length"));
		if (maxBytes != null && declared > maxBytes) {
			try {
				await res.body?.cancel();
			} catch {}
			throw new SizeLimitError(declared);
		}
		const bytes = new Uint8Array(await res.arrayBuffer());
		if (maxBytes != null && bytes.length > maxBytes) throw new SizeLimitError(bytes.length);
		return {
			bytes,
			contentType: res.headers.get("content-type")
		};
	}
	async function mapConcurrent(items, concurrency, fn, cancel) {
		let next = 0;
		let aborted = null;
		const n = Math.max(1, Math.min(concurrency, items.length));
		const workers = Array.from({ length: n }, async () => {
			while (aborted == null && !cancel?.cancelled) {
				const i = next++;
				if (i >= items.length) return;
				try {
					await fn(items[i], i);
				} catch (e) {
					aborted = e;
					return;
				}
			}
		});
		await Promise.all(workers);
		if (aborted != null) throw aborted;
		ensureAlive(cancel);
	}
	var BatchSafetyError = class extends Error {
		constructor(message) {
			super(message);
			this.name = "BatchSafetyError";
		}
	};
	function createBatchSafetyGuard(policy, getStats) {
		const baseline = getStats();
		return () => {
			const current = getStats();
			const requests = Math.max(0, current.requests - baseline.requests);
			if (policy.maxRequests != null && requests >= policy.maxRequests) throw new BatchSafetyError(`本批次已发出 ${requests} 次 HTTP 请求，达到安全上限并停止`);
			const retryAfterHits = Math.max(0, current.retryAfterHits - baseline.retryAfterHits);
			if (policy.maxRetryAfterHits != null && retryAfterHits >= policy.maxRetryAfterHits) throw new BatchSafetyError(`服务端已返回 Retry-After 全局限流信号，本批次安全中止（最长等待 ${current.maxRetryAfterSec}s）`);
			const hits429 = Math.max(0, current.hits429 - baseline.hits429);
			if (policy.max429Hits != null && hits429 >= policy.max429Hits) throw new BatchSafetyError(`本批次已遇到 ${hits429} 次 HTTP 429，为保护账号安全停止后续请求`);
		};
	}
	function failureLimitReached(policy, failed, attempted) {
		return failed >= policy.failureAbortMin && attempted > 0 && failed / attempted > policy.failureAbortRatio;
	}
	var FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
	var FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
	function mapLinesOutsideFencedCode(text, lineFn) {
		let fence = null;
		return text.split("\n").map((line) => {
			if (fence) {
				const close = FENCE_CLOSE.exec(line);
				if (close && close[1].charAt(0) === fence.charAt(0) && close[1].length >= fence.length) fence = null;
				return line;
			}
			const open = FENCE_OPEN.exec(line);
			if (open) {
				fence = open[1];
				return line;
			}
			return lineFn(line);
		}).join("\n");
	}
	function mapTextSegmentsOutsideCode(text, fn) {
		const lines = text.split("\n");
		const out = [];
		let buf = [];
		let fence = null;
		const flush = () => {
			if (buf.length > 0) {
				out.push(mapOutsideInlineCode(buf.join("\n"), fn));
				buf = [];
			}
		};
		for (const line of lines) {
			if (fence) {
				out.push(line);
				const close = FENCE_CLOSE.exec(line);
				if (close && close[1].charAt(0) === fence.charAt(0) && close[1].length >= fence.length) fence = null;
				continue;
			}
			const open = FENCE_OPEN.exec(line);
			if (open) {
				flush();
				out.push(line);
				fence = open[1];
			} else buf.push(line);
		}
		flush();
		return out.join("\n");
	}
	function inlineCodeSpans(line) {
		const runs = [...line.matchAll(/`+/g)].map((m) => ({
			start: m.index,
			length: m[0].length
		}));
		const spans = [];
		for (let i = 0; i < runs.length; i++) {
			const open = runs[i];
			const close = runs.findIndex((run, j) => j > i && run.length === open.length);
			if (close < 0) continue;
			spans.push([open.start, runs[close].start + open.length]);
			i = close;
		}
		return spans;
	}
	function mapOutsideInlineCode(segment, fn) {
		return segment.split(/(`+[^`]*`+)/).map((part, i) => i % 2 === 1 ? part : fn(part)).join("");
	}
	function demoteHeadings(text, depth = 1) {
		return mapLinesOutsideFencedCode(text, (line) => {
			const m = /^( {0,3})(#{1,6})([ \t].*|)$/.exec(line);
			if (!m) return line;
			const level = Math.min(6, m[2].length + depth);
			return m[1] + "#".repeat(level) + m[3];
		});
	}
	function stripHeadings(text) {
		return mapLinesOutsideFencedCode(text, (line) => {
			const m = /^ {0,3}#{1,6}([ \t].*|)$/.exec(line);
			if (!m) return line;
			const inner = m[1].replace(/[ \t]+#+[ \t]*$/, "").trim();
			return inner === "" ? "" : `**${inner}**`;
		});
	}
	function transformHeadings(text, mode) {
		return mode === "strip" ? stripHeadings(text) : demoteHeadings(text);
	}
	function convertMath(text, escapeCurrency = true) {
		return mapTextSegmentsOutsideCode(text, (segment) => convertSegment(segment, escapeCurrency));
	}
	function convertSegment(seg, escapeCurrency) {
		if (escapeCurrency) seg = seg.replace(/(?<![\\$])\$(?=\d)/g, "\\$");
		seg = seg.replace(/[ \t]*\\\[\s*([\s\S]*?)\s*\\\][ \t]*/g, (_m, body) => `\n\n$$\n${body}\n$$\n\n`);
		seg = seg.replace(/\\\(\s*([\s\S]*?)\s*\\\)/g, (_m, body) => `$${body}$`);
		return seg;
	}
	var MARKER_OPEN = String.fromCharCode(57360);
	var MARKER_CLOSE = String.fromCharCode(57361);
	var MARKER = new RegExp(`${MARKER_OPEN}(\\d+)${MARKER_CLOSE}`, "g");
	var inlineAssetMarker = (index) => `${MARKER_OPEN}${index}${MARKER_CLOSE}`;
	function replaceInlineAssetMarkers(text, replace) {
		return text.replace(MARKER, (_marker, index) => replace(Number(index)));
	}
	function assetLink(style, path, opts = {}) {
		if (style === "markdown") {
			const label = escapeLinkLabel(opts.label ?? path.split("/").pop() ?? path);
			return `${opts.embed ? "!" : ""}[${label}](${encodeURI(path)})`;
		}
		if (opts.embed) return `![[${path}]]`;
		const alias = opts.label?.replace(/[[\]|]/g, "-");
		return `[[${path}${alias ? `|${alias}` : ""}]]`;
	}
	var assetToken = (index) => `%%INKSTONE-ASSET-${index}%%`;
	function fillAssetTokens(markdown, replacements) {
		return markdown.replace(/%%INKSTONE-ASSET-(\d+)%%/g, (token, index) => replacements[Number(index)] ?? token);
	}
	function renderAssetOccurrence(style, ref, outcome) {
		if ("note" in outcome) return ref.label ? `${ref.label} ${outcome.note}` : outcome.note;
		return assetLink(style, outcome.path, {
			embed: ref.kind === "image",
			label: ref.label ?? (ref.kind === "image" ? void 0 : ref.name ?? outcome.fileName)
		});
	}
	var CONTROL_CHARS = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}]`, "g");
	function filenameFor(title, convId) {
		return `${sanitizeName(title).slice(0, 80).replace(/-+$/, "") || "Untitled"}-${convId.slice(0, 8)}.md`;
	}
	function sanitizeName(name) {
		return name.replace(CONTROL_CHARS, "").replace(/[/\\:*?"<>|#^[\]\s]+/g, "-").replace(/-{2,}/g, "-").replace(/^[-.]+|-+$/g, "");
	}
	function sanitizeSubdir(input) {
		return input.split("/").map((seg) => sanitizeName(seg)).filter((seg) => seg !== "").join("/");
	}
	function renderConversation(conv, copts = {}) {
		const thoughts = copts.thoughts === true;
		const toolTraces = copts.toolTraces === true;
		const headingMode = copts.headingMode ?? "demote";
		const sources = [];
		const assets = [];
		const assetAt = (ref) => {
			assets.push(ref);
			return assetToken(assets.length - 1);
		};
		const prose = (text) => transformHeadings(convertMath(text, conv.source === "chatgpt"), headingMode);
		const renderBlock = (b) => {
			switch (b.kind) {
				case "prose": {
					if (b.sources) sources.push(...b.sources);
					const text = prose(b.text);
					const inline = b.assets;
					if (!inline) return text;
					return replaceInlineAssetMarkers(text, (i) => {
						const ref = inline[i];
						return ref ? assetAt(ref) : "";
					});
				}
				case "thinking": {
					if (!thoughts) return null;
					if (b.sources) sources.push(...b.sources);
					const items = b.items.map((t) => (t.summary?.trim() ? `**${t.summary.trim()}**\n\n` : "") + prose(t.text)).filter((s) => s.trim() !== "");
					return items.length === 0 ? null : callout("quote", "思考过程", items.join("\n\n"), true);
				}
				case "tool": {
					if (b.gated !== false && !toolTraces) return null;
					const body = b.fenced === false ? b.body : fence(b.body, b.lang ?? "");
					return callout(b.tone ?? "example", b.title, body, true);
				}
				case "document": {
					const body = b.docType.startsWith("code/") ? fence(b.content, b.docType.slice(5)) : prose(b.content);
					return callout("abstract", b.label, body);
				}
				case "asset": return assetAt(b.ref);
				case "assetList": return b.refs.map((r) => `- ${assetAt(r)}`).join("\n");
				case "note": return b.text;
				case "raw": return callout("warning", b.label, fence(JSON.stringify(b.json, null, 2), "json"), true);
			}
		};
		const renderTurn = (turn) => {
			const rendered = turn.blocks.map(renderBlock).filter((s) => s != null && s.trim() !== "");
			if (rendered.length === 0) return null;
			return [turn.role === "user" ? "# User" : `# ${conv.assistantHeading}`, ...rendered].join("\n\n");
		};
		let body = conv.turns.map(renderTurn).filter((s) => s != null).join("\n\n");
		const deduped = dedupeSources(sources);
		if (deduped.length > 0) body += `\n\n# Sources\n\n${deduped.map((s) => `- [${escapeLinkLabel(s.title)}](${s.url})`).join("\n")}`;
		const tidied = mapTextSegmentsOutsideCode(body, (s) => s.replace(/\n{3,}/g, "\n\n"));
		return {
			markdown: `${[
				"---",
				`title: ${yamlQuote(conv.title)}`,
				`chat_id: ${conv.id}`,
				`url: ${conv.url}`,
				`created: ${conv.created}`,
				`updated: ${conv.updated}`,
				conv.model ? `model: ${conv.model}` : null,
				conv.models && conv.models.length > 1 ? `models:\n${conv.models.map((s) => `  - ${s}`).join("\n")}` : null,
				...(conv.extra ?? []).map(([k, v]) => `${k}: ${v}`),
				"tags:",
				...conv.tags.map((t) => `  - ${t}`),
				"---"
			].filter((l) => l != null).join("\n")}\n\n${tidied.trim()}\n`,
			title: conv.title,
			assets
		};
	}
	function fence(code, lang = "") {
		const longest = (code.match(/`+/g) ?? []).reduce((n, run) => Math.max(n, run.length), 2);
		const f = "`".repeat(Math.max(3, longest + 1));
		return `${f}${lang}\n${code.replace(/\n$/, "")}\n${f}`;
	}
	function callout(type, title, body, folded = false) {
		return `${`> [!${type}]${folded ? "-" : ""} ${title}`}\n${body.split("\n").map((l) => l === "" ? ">" : `> ${l}`).join("\n")}`;
	}
	function dedupeSources(sources) {
		const seen = new Map();
		for (const s of sources) if (!seen.has(s.url)) seen.set(s.url, s);
		return [...seen.values()];
	}
	function escapeLinkLabel(s) {
		return s.replace(/([[\]])/g, "\\$1");
	}
	function yamlQuote(s) {
		return `"${s.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
	}
	function toIso(t) {
		if (t == null || t === "") return "";
		const d = typeof t === "number" ? new Date(t * 1e3) : new Date(t);
		return Number.isNaN(d.getTime()) ? "" : d.toISOString();
	}
	var fetcher$1 = createFetcher({
		spacingBaseMs: 800,
		spacingMaxMs: 4e3,
		restEveryN: 80,
		restDurationMs: 25e3,
		maxAttempts: 7
	});
	var throttleStats$1 = () => fetcher$1.stats();
	async function getAccessToken(cancel) {
		const data = await (await fetcher$1.request(`${location.origin}/api/auth/session`, {}, cancel)).json();
		if (!data.accessToken) throw new Error("拿不到 accessToken：请确认已登录 ChatGPT 后重试");
		return data.accessToken;
	}
	var auth = (token) => ({ Authorization: `Bearer ${token}` });
	async function listConversationsPage$1(token, offset, limit, cancel) {
		const url = `${location.origin}/backend-api/conversations?offset=${offset}&limit=${limit}&order=updated`;
		return await (await fetcher$1.request(url, { headers: auth(token) }, cancel)).json();
	}
	var PROJECT_PAGE_LIMIT = 50;
	var projectNames = new Map();
	var projectNameOf = (gizmoId) => gizmoId ? projectNames.get(gizmoId) : void 0;
	var projectsInFlight = null;
	function listProjects(token, cancel) {
		projectsInFlight ??= fetchProjects(token, cancel).finally(() => {
			projectsInFlight = null;
		});
		return projectsInFlight;
	}
	async function fetchProjects(token, cancel) {
		const out = [];
		let cursor = null;
		for (;;) {
			ensureAlive(cancel);
			const url = `${location.origin}/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=0` + (cursor == null ? "" : `&cursor=${encodeURIComponent(String(cursor))}`);
			const page = await (await fetcher$1.request(url, { headers: auth(token) }, cancel)).json();
			for (const entry of page.items ?? []) {
				const g = entry.gizmo?.gizmo;
				if (!g?.id) continue;
				const name = (g.display?.name ?? "").trim() || "未命名项目";
				projectNames.set(g.id, name);
				out.push({
					id: g.id,
					name
				});
			}
			cursor = page.cursor ?? null;
			if (cursor == null) return out;
		}
	}
	async function listProjectConversationsPage(token, gizmoId, cursor, cancel) {
		const url = `${location.origin}/backend-api/gizmos/${encodeURIComponent(gizmoId)}/conversations?cursor=${encodeURIComponent(cursor)}&limit=${PROJECT_PAGE_LIMIT}`;
		return await (await fetcher$1.request(url, { headers: auth(token) }, cancel)).json();
	}
	var SOURCE_ALL = "all";
	var SOURCE_MAIN = "main";
	function timeOf(i) {
		const t = i.update_time ?? i.create_time;
		if (typeof t === "number") return t;
		if (typeof t === "string") {
			const ms = Date.parse(t);
			return Number.isNaN(ms) ? -Infinity : ms / 1e3;
		}
		return -Infinity;
	}
	function makeStream(nextPage) {
		const buf = [];
		const stream = {
			done: false,
			peek: () => buf[0],
			take: () => buf.shift(),
			async fill() {
				const page = await nextPage();
				if (page == null) stream.done = true;
				else buf.push(...page);
			}
		};
		return stream;
	}
	function createConversationPager$1(token, cancel, source = SOURCE_ALL) {
		const onlyProject = source === SOURCE_ALL || source === SOURCE_MAIN ? null : source;
		const seen = new Set();
		let offset = 0;
		let limit = 100;
		let emptyRetries = 0;
		let streams = null;
		let done = false;
		async function mainPage() {
			for (;;) {
				ensureAlive(cancel);
				let page;
				try {
					page = await listConversationsPage$1(token, offset, limit, cancel);
				} catch (e) {
					if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429 && limit > 50) {
						limit = 50;
						continue;
					}
					throw e;
				}
				const items = page.items ?? [];
				if (items.length === 0) {
					if (offset === 0 || emptyRetries >= 2) return null;
					emptyRetries++;
					await sleep(4e3 * emptyRetries);
					continue;
				}
				emptyRetries = 0;
				offset += items.length;
				return items;
			}
		}
		function projectPages(gizmoId) {
			let cursor = "0";
			return async () => {
				if (cursor == null) return null;
				ensureAlive(cancel);
				const page = await listProjectConversationsPage(token, gizmoId, cursor, cancel);
				cursor = page.cursor ?? null;
				return (page.items ?? []).map((i) => ({
					...i,
					gizmo_id: i.gizmo_id ?? gizmoId
				}));
			};
		}
		async function buildStreams() {
			if (onlyProject != null) return [makeStream(projectPages(onlyProject))];
			if (source === SOURCE_MAIN) return [makeStream(mainPage)];
			const projects = await listProjects(token, cancel);
			return [makeStream(mainPage), ...projects.map((p) => makeStream(projectPages(p.id)))];
		}
		return { async next() {
			if (done) return {
				items: [],
				done: true
			};
			streams ??= await buildStreams();
			for (;;) {
				for (const s of streams) while (!s.done && s.peek() === void 0) await s.fill();
				const out = [];
				for (;;) {
					let best;
					for (const s of streams) {
						const head = s.peek();
						if (head === void 0) continue;
						if (best === void 0 || timeOf(head) > timeOf(best.peek())) best = s;
					}
					if (best === void 0) {
						done = true;
						break;
					}
					const item = best.take();
					if (!seen.has(item.id)) {
						seen.add(item.id);
						out.push(item);
					}
					if (best.peek() === void 0 && !best.done) break;
				}
				if (out.length > 0 || done) return {
					items: out,
					done
				};
			}
		} };
	}
	async function listAllConversations$1(token, onProgress, cancel) {
		const pager = createConversationPager$1(token, cancel);
		const all = [];
		for (;;) {
			const { items, done } = await pager.next();
			all.push(...items);
			if (items.length > 0) onProgress?.(all.length);
			if (done) return all;
		}
	}
	async function fetchConversation$1(token, id, cancel) {
		return await (await fetcher$1.request(`${location.origin}/backend-api/conversation/${id}`, { headers: auth(token) }, cancel)).json();
	}
	function downloadTarget(data, endpoint) {
		if (!data.download_url) throw new Error(`${endpoint} 未返回 download_url：${JSON.stringify(data).slice(0, 200)}`);
		let filename = data.file_name || null;
		if (!filename) try {
			filename = new URL(data.download_url, location.origin).searchParams.get("fn");
		} catch {}
		return {
			url: data.download_url,
			filename
		};
	}
	async function resolveFileDownload(token, fileId, cancel) {
		return downloadTarget(await (await fetcher$1.request(`${location.origin}/backend-api/files/${fileId}/download`, { headers: auth(token) }, cancel)).json(), `files/${fileId}/download`);
	}
	async function resolveSandboxDownload(token, path, cancel) {
		return downloadTarget(await (await fetcher$1.request(new URL(path, location.origin).href, { headers: auth(token) }, cancel)).json(), "interpreter/download");
	}
	function fetchBinary$1(url, cancel, maxBytes) {
		return fetchBinary$2(fetcher$1, url, cancel, maxBytes);
	}
	function replayCanvas(messages) {
		const ops = new Map();
		const docs = [];
		let current = null;
		for (const msg of messages) {
			const recipient = msg.recipient ?? "all";
			if (msg.author.role !== "assistant" || !recipient.startsWith("canmore.")) continue;
			const payload = parseJson((msg.content.parts ?? []).filter((p) => typeof p === "string").join("\n").trim());
			if (payload == null) continue;
			if (recipient === "canmore.create_textdoc") {
				if (typeof payload["content"] !== "string") continue;
				current = {
					name: typeof payload["name"] === "string" && payload["name"] !== "" ? payload["name"] : "untitled",
					type: typeof payload["type"] === "string" && payload["type"] !== "" ? payload["type"] : "document",
					content: payload["content"],
					broken: false,
					lastGoodMsgId: msg.id
				};
				docs.push(current);
				ops.set(msg.id, {
					kind: "create",
					docName: current.name,
					docType: current.type
				});
			} else if (recipient === "canmore.update_textdoc") {
				if (!current || current.broken) continue;
				const updates = Array.isArray(payload["updates"]) ? payload["updates"] : null;
				if (!updates || updates.length === 0) continue;
				let content = current.content;
				for (const u of updates) content = content == null ? null : applyUpdate(content, u);
				if (content == null) {
					current.broken = true;
					continue;
				}
				current.content = content;
				current.lastGoodMsgId = msg.id;
				ops.set(msg.id, {
					kind: "update",
					docName: current.name,
					docType: current.type
				});
			} else if (recipient === "canmore.comment_textdoc") {
				const comments = (Array.isArray(payload["comments"]) ? payload["comments"] : []).filter((c) => c != null && typeof c === "object").map((c) => ({
					pattern: typeof c["pattern"] === "string" ? c["pattern"] : "",
					comment: typeof c["comment"] === "string" ? c["comment"] : ""
				})).filter((c) => c.comment !== "");
				if (comments.length === 0) continue;
				ops.set(msg.id, {
					kind: "comment",
					docName: current?.name ?? "",
					docType: current?.type ?? "document",
					comments
				});
			}
		}
		for (const doc of docs) {
			const op = ops.get(doc.lastGoodMsgId);
			if (op) op.finalContent = doc.content;
		}
		return ops;
	}
	function applyUpdate(content, u) {
		if (u == null || typeof u !== "object") return null;
		const upd = u;
		const rawPattern = upd["pattern"];
		const replacement = upd["replacement"];
		if (typeof rawPattern !== "string" || typeof replacement !== "string") return null;
		if (/\\\d/.test(replacement)) return null;
		let pattern = rawPattern;
		let flags = "s";
		const inline = /^\(\?([a-zA-Z]+)\)/.exec(pattern);
		if (inline) {
			pattern = pattern.slice(inline[0].length);
			for (const ch of inline[1]) if (ch === "i" || ch === "m") flags += ch;
			else if (ch !== "s") return null;
		}
		if (upd["multiple"] === true) flags += "g";
		let re;
		try {
			re = new RegExp(pattern, flags);
		} catch {
			return null;
		}
		if (!re.test(content)) return null;
		re.lastIndex = 0;
		return content.replace(re, replacement.replace(/\$/g, "$$$$"));
	}
	function parseJson(raw) {
		if (!raw.startsWith("{")) return null;
		try {
			const v = JSON.parse(raw);
			return v != null && typeof v === "object" && !Array.isArray(v) ? v : null;
		} catch {
			return null;
		}
	}
	var cp = (n) => String.fromCharCode(n);
	var PUA_MARKER_RUN = new RegExp(`${cp(57856)}[^${cp(57857)}]*${cp(57857)}`, "g");
	var PUA_MARKER_CAPTURE = new RegExp(`${cp(57856)}([^${cp(57857)}]*)${cp(57857)}`, "g");
	var PUA_SEP = cp(57858);
	var PUA_ANY = new RegExp(`[${cp(57344)}-${cp(63743)}]`, "g");
	var LEGACY_CITATION = /【[^【】\n]*†[^【】\n]*】/g;
	function restoreCitations(text, refs) {
		const sources = [];
		for (const ref of refs ?? []) {
			const matched = ref.matched_text;
			if (!matched || !isCitationMarker(matched) || !text.includes(matched)) continue;
			text = text.split(matched).join(renderRef(ref, sources));
		}
		text = restoreByToken(text, refs ?? [], sources);
		return {
			text: stripResidualMarkers(text),
			sources
		};
	}
	var WEB_REF_TYPES = new Set([
		"webpage",
		"webpage_extended",
		"grouped_webpages",
		"grouped_webpages_model_predicted"
	]);
	function buildTokenMap(refs) {
		const map = new Map();
		for (const ref of refs) {
			if (ref.type === "file") {
				const ip = ref.input_pointer;
				if (ip && typeof ip.message_index === "number" && typeof ip.file_index === "number" && typeof ref.name === "string" && ref.name !== "") map.set(`turn${ip.message_index}file${ip.file_index}`, {
					kind: "file",
					name: ref.name
				});
				continue;
			}
			const items = (ref.items?.length ? ref.items : ref.fallback_items) ?? [];
			for (const item of items) {
				if (typeof item?.url !== "string" || item.url === "") continue;
				for (const rr of item.refs ?? []) if (typeof rr?.turn_index === "number" && typeof rr.ref_type === "string" && typeof rr.ref_index === "number") map.set(`turn${rr.turn_index}${rr.ref_type}${rr.ref_index}`, {
					kind: "web",
					item
				});
			}
		}
		return map;
	}
	function restoreByToken(text, refs, sources) {
		const remaining = refs.filter((r) => !r.matched_text);
		if (remaining.length === 0 || !new RegExp(PUA_MARKER_RUN.source).test(text)) return text;
		const tokens = buildTokenMap(remaining);
		const webRefs = remaining.filter((r) => WEB_REF_TYPES.has(r.type ?? ""));
		const citeMarks = [...text.matchAll(PUA_MARKER_CAPTURE)].filter((m) => m[1].split(PUA_SEP)[0] === "cite").length;
		const positional = citeMarks > 0 && citeMarks === webRefs.length ? webRefs : null;
		let citeIdx = 0;
		return text.replace(PUA_MARKER_CAPTURE, (whole, inner) => {
			const segs = inner.split(PUA_SEP);
			if (segs[0] === "cite" && positional) return renderRef(positional[citeIdx++], sources);
			const items = [];
			const files = [];
			const seenUrl = new Set();
			for (const seg of segs.slice(1)) {
				const hit = tokens.get(seg);
				if (!hit) continue;
				if (hit.kind === "file") {
					if (!files.includes(hit.name)) files.push(hit.name);
				} else if (!seenUrl.has(hit.item.url)) {
					seenUrl.add(hit.item.url);
					items.push(hit.item);
				}
			}
			if (items.length === 0 && files.length === 0) return whole;
			const parts = [];
			if (items.length > 0) parts.push(renderItems(items, sources));
			if (files.length > 0) parts.push(` *(引用文件: ${files.join("、")})*`);
			return parts.join("");
		});
	}
	function isCitationMarker(matched) {
		return new RegExp(PUA_ANY.source).test(matched) || new RegExp(LEGACY_CITATION.source).test(matched);
	}
	function stripResidualMarkers(text) {
		return text.replace(PUA_MARKER_RUN, "").replace(PUA_ANY, "").replace(LEGACY_CITATION, "");
	}
	function renderRef(ref, sources) {
		switch (ref.type) {
			case "webpage":
			case "webpage_extended":
			case "grouped_webpages":
			case "grouped_webpages_model_predicted": return renderItems((ref.items?.length ? ref.items : ref.fallback_items) ?? [], sources);
			case "file": return ref.name ? ` *(引用文件: ${ref.name})*` : "";
			default: return "";
		}
	}
	function renderItems(items, sources) {
		const links = items.filter((i) => typeof i?.url === "string" && i.url !== "").map((i) => {
			const title = (i.title ?? "").trim() || i.url;
			sources.push({
				title,
				url: i.url
			});
			return `[${escapeLabel((i.attribution ?? "").trim() || hostOf$1(i.url) || title)}](${i.url})`;
		});
		return links.length > 0 ? `（${links.join("，")}）` : "";
	}
	function hostOf$1(url) {
		try {
			return new URL(url).hostname.replace(/^www\./, "");
		} catch {
			return "";
		}
	}
	function escapeLabel(s) {
		return s.replace(/([[\]])/g, "\\$1");
	}
	function linearize$1(conv) {
		const mapping = conv.mapping ?? {};
		let cursor = conv.current_node ?? findLatestLeaf(mapping);
		const chain = [];
		const seen = new Set();
		while (cursor && !seen.has(cursor)) {
			seen.add(cursor);
			const node = mapping[cursor];
			if (!node) break;
			if (node.message) chain.push(node.message);
			cursor = node.parent ?? null;
		}
		chain.reverse();
		return chain.filter(isVisible$1);
	}
	function findLatestLeaf(mapping) {
		const hasChild = new Set();
		for (const node of Object.values(mapping)) if (node.parent != null) hasChild.add(node.parent);
		let best = null;
		let bestTime = -Infinity;
		for (const [id, node] of Object.entries(mapping)) {
			if ((node.children ?? []).length > 0 || hasChild.has(id)) continue;
			const t = node.message?.create_time ?? 0;
			if (t >= bestTime) {
				bestTime = t;
				best = id;
			}
		}
		return best;
	}
	function isVisible$1(msg) {
		if (msg.metadata?.is_visually_hidden_from_conversation) return false;
		if (msg.author?.role === "system") return false;
		const c = msg.content;
		const ct = c?.content_type;
		if (ct === "user_editable_context" || ct === "model_editable_context") return false;
		if (ct === "reasoning_recap") return false;
		if (ct === "text" || ct === "multimodal_text") {
			const parts = c.parts ?? [];
			if (parts.length === 0) return false;
			if (parts.every((p) => typeof p === "string" && p.trim() === "")) return false;
		}
		return true;
	}
	function groupTurns$1(messages) {
		const turns = [];
		for (const msg of messages) {
			const role = msg.author?.role === "user" ? "user" : "assistant";
			const last = turns[turns.length - 1];
			if (last && last.role === role) last.messages.push(msg);
			else turns.push({
				role,
				messages: [msg]
			});
		}
		return turns;
	}
	function hashText(value) {
		let hash = 2166136261;
		for (const ch of value) {
			hash ^= ch.charCodeAt(0);
			hash = Math.imul(hash, 16777619);
		}
		return (hash >>> 0).toString(16).padStart(8, "0");
	}
	var LABEL = String.raw`(?:\\.|[^\[\]\\\n]|\[(?:\\.|[^\[\]\\\n])*\])*`;
	var ANGLE_TARGET = String.raw`<(sandbox:(?:\\.|[^<>\\\n])+)>`;
	var BARE_TARGET = String.raw`(sandbox:(?:\\.|[^\s()\\]|\((?:\\.|[^\s()\\])*\))+)`;
	var TITLE = String.raw`(?:[ \t]+(?:"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\((?:\\.|[^()\\\n])*\)))?`;
	var SANDBOX_LINK = new RegExp(String.raw`(!?)\[(${LABEL})\]\([ \t]*(?:${ANGLE_TARGET}|${BARE_TARGET})${TITLE}[ \t]*\)`, "g");
	function extractSandboxLinks(text, conversationId, messageId) {
		if (!text.includes("sandbox:")) return {
			text,
			assets: []
		};
		const assets = [];
		return {
			text: mapLinesOutsideFencedCode(text, (line) => {
				const codeSpans = inlineCodeSpans(line);
				return line.replace(SANDBOX_LINK, (link, bang, label, angle, bare, offset) => {
					if (codeSpans.some(([start, end]) => offset >= start && offset < end)) return link;
					const path = sandboxPath(angle ?? bare ?? "");
					if (path === "") return link;
					assets.push(sandboxAssetRef$1(conversationId, messageId, path, unescapeMarkdown(label).trim(), bang === "!"));
					return inlineAssetMarker(assets.length - 1);
				});
			}),
			assets
		};
	}
	function sandboxAssetRef$1(conversationId, messageId, path, label, embed) {
		const name = path.split("/").filter(Boolean).pop() ?? "";
		const query = new URLSearchParams({
			message_id: messageId,
			sandbox_path: path
		});
		return {
			fileId: `sandbox-${hashText(`${conversationId}\0${messageId}\0${path}`)}`,
			kind: embed ? "image" : "file",
			...name ? { name } : {},
			...label ? { label } : {},
			url: `/backend-api/conversation/${encodeURIComponent(conversationId)}/interpreter/download?${query}`
		};
	}
	function sandboxPath(target) {
		const raw = unescapeMarkdown(target).slice(8);
		try {
			return decodeURIComponent(raw);
		} catch {
			return raw;
		}
	}
	function unescapeMarkdown(text) {
		return text.replace(/\\([!-/:-@[-`{-~])/g, "$1");
	}
	function conversationToIR$1(conv, fallbackId = "", projectName) {
		const convId = String(conv.conversation_id ?? conv.id ?? fallbackId);
		const title = (conv.title ?? "").trim() || "Untitled";
		const messages = linearize$1(conv);
		const rawSlugs = messages.filter((m) => m.author.role === "assistant" && m.metadata?.model_slug).map((m) => m.metadata.model_slug);
		const modelSlugs = [...new Set(rawSlugs)];
		const model = rawSlugs[rawSlugs.length - 1] ?? conv.default_model_slug;
		const ctx = {
			conversationId: convId,
			canvas: replayCanvas(messages)
		};
		const turns = groupTurns$1(messages).map((t) => ({
			role: t.role,
			blocks: t.messages.flatMap((m) => messageBlocks$1(m, ctx))
		}));
		const branchMeta = messages.map((m) => m.metadata).find((md) => md?.branching_from_conversation_id);
		const extra = [];
		if (branchMeta) {
			const branchedFrom = filenameFor(branchMeta.branching_from_conversation_title ?? "", branchMeta.branching_from_conversation_id).replace(/\.md$/, "");
			extra.push(["branched_from", yamlQuote(`[[${branchedFrom}]]`)]);
			extra.push(["branched_from_url", `https://chatgpt.com/c/${branchMeta.branching_from_conversation_id}`]);
		}
		if (projectName) extra.unshift(["project", yamlQuote(projectName)]);
		const gizmoId = conv.gizmo_id ?? null;
		return {
			source: "chatgpt",
			id: convId,
			title,
			url: `https://chatgpt.com${gizmoId ? `/g/${gizmoId}` : ""}/c/${convId}`,
			created: toIso(conv.create_time),
			updated: toIso(conv.update_time),
			model: model || void 0,
			models: modelSlugs,
			extra,
			tags: ["chatgpt"],
			assistantHeading: "ChatGPT",
			turns
		};
	}
	function messageBlocks$1(msg, ctx) {
		const c = msg.content;
		const recipient = msg.recipient ?? "all";
		const refs = msg.metadata?.content_references;
		const blocks = [];
		const inlineImageIds = new Set();
		const prose = (raw) => proseBlock$1(raw, refs, msg, ctx);
		if (msg.author.role === "tool" && (msg.author.name ?? "").startsWith("canmore.")) return [];
		switch (c.content_type) {
			case "text": {
				const raw = joinTextParts(c);
				if (msg.author.role === "assistant" && recipient.startsWith("canmore.")) {
					const op = ctx.canvas.get(msg.id);
					if (op) blocks.push(canvasBlock(op));
					else blocks.push({
						kind: "tool",
						title: `工具调用 → \`${recipient}\``,
						body: stripResidualMarkers(raw),
						gated: false
					});
				} else if (msg.author.role === "assistant" && recipient !== "all") blocks.push({
					kind: "tool",
					title: `工具调用 → \`${recipient}\``,
					body: stripResidualMarkers(raw)
				});
				else blocks.push(prose(raw));
				break;
			}
			case "multimodal_text":
				for (const p of c.parts ?? []) if (typeof p === "string") blocks.push(prose(p));
				else {
					const { block, fileId } = imageAssetBlock(p);
					blocks.push(block);
					if (fileId) inlineImageIds.add(fileId);
				}
				break;
			case "code":
				blocks.push({
					kind: "tool",
					title: `工具调用 → \`${recipient}\``,
					body: c.text ?? "",
					lang: codeLanguage(c, recipient)
				});
				break;
			case "execution_output":
				blocks.push({
					kind: "tool",
					tone: "note",
					title: "运行输出",
					body: stripResidualMarkers(c.text ?? "")
				});
				break;
			case "thoughts": {
				const sources = [];
				const items = (c.thoughts ?? []).map((t) => {
					const restored = restoreCitations(t.content ?? "", refs);
					sources.push(...restored.sources);
					return {
						summary: t.summary,
						text: restored.text
					};
				});
				blocks.push({
					kind: "thinking",
					items,
					sources
				});
				break;
			}
			default: blocks.push({
				kind: "raw",
				label: `未识别的内容类型 \`${c.content_type}\`（原始 JSON）`,
				json: c
			});
		}
		const attachments = (msg.metadata?.attachments ?? []).filter((a) => a?.id && !inlineImageIds.has(a.id));
		if (attachments.length > 0) blocks.push({
			kind: "assetList",
			refs: attachments.map(fileAssetRef)
		});
		return blocks;
	}
	function proseBlock$1(raw, refs, msg, ctx) {
		const { text, sources } = restoreCitations(raw, refs);
		if (msg.author.role !== "assistant") return {
			kind: "prose",
			text,
			sources
		};
		const links = extractSandboxLinks(text, ctx.conversationId, msg.id);
		return links.assets.length > 0 ? {
			kind: "prose",
			text: links.text,
			sources,
			assets: links.assets
		} : {
			kind: "prose",
			text,
			sources
		};
	}
	function canvasBlock(op) {
		if (op.kind === "comment") return {
			kind: "tool",
			title: `Canvas 批注${op.docName ? ` · ${op.docName}` : ""}`,
			body: (op.comments ?? []).map((c) => `- ${c.comment}`).join("\n"),
			gated: false,
			fenced: false
		};
		if (op.finalContent != null) return {
			kind: "document",
			label: `Canvas · ${op.docName}`,
			docType: op.docType,
			content: op.finalContent
		};
		return {
			kind: "note",
			text: op.kind === "create" ? `*(Canvas 创建「${op.docName}」，终稿见后)*` : `*(Canvas 更新「${op.docName}」，终稿见后)*`
		};
	}
	function imageAssetBlock(p) {
		const fileId = (typeof p.asset_pointer === "string" ? p.asset_pointer : "").split("//")[1] ?? "";
		if (!fileId) return {
			block: {
				kind: "raw",
				label: `未识别的多模态 part \`${p.content_type}\`（原始 JSON）`,
				json: p
			},
			fileId: null
		};
		return {
			block: {
				kind: "asset",
				ref: {
					fileId,
					kind: "image",
					sizeBytes: typeof p.size_bytes === "number" ? p.size_bytes : void 0
				}
			},
			fileId
		};
	}
	function fileAssetRef(a) {
		return {
			fileId: a.id,
			kind: "file",
			name: a.name ?? void 0,
			sizeBytes: typeof a.size === "number" ? a.size : void 0,
			mime: a.mime_type ?? void 0
		};
	}
	function joinTextParts(c) {
		return (c.parts ?? []).filter((p) => typeof p === "string").join("\n");
	}
	function codeLanguage(c, recipient) {
		const lang = (c.language ?? "").trim();
		if (lang && lang !== "unknown") return lang;
		return recipient === "python" ? "python" : "";
	}
	var toItem$1 = (i) => ({
		id: i.id,
		title: i.title ?? "",
		update_time: i.update_time ?? null,
		project: projectNameOf(i.gizmo_id)
	});
	function createChatGPTIRContextResolver(session, cancel, loadProjects = listProjects) {
		let projectsPass = null;
		return async (_id, raw) => {
			const gizmoId = raw.gizmo_id;
			if (!gizmoId) return {};
			const known = projectNameOf(gizmoId);
			if (known) return { projectName: known };
			projectsPass ??= loadProjects(session, cancel);
			try {
				await projectsPass;
			} catch (error) {
				if (cancel?.cancelled) throw error;
				return {};
			}
			return { projectName: projectNameOf(gizmoId) };
		};
	}
	function isVisible(el) {
		if (!(el instanceof HTMLElement) || !el.isConnected) return false;
		const rect = el.getBoundingClientRect();
		if (rect.width < 1 || rect.height < 1) return false;
		const style = getComputedStyle(el);
		return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
	}
	function firstVisible(selectors, root = document) {
		for (const selector of selectors) for (const el of root.querySelectorAll(selector)) if (isVisible(el)) return el;
		return null;
	}
	function bottommostVisible(selectors) {
		for (const selector of selectors) {
			const matches = [...document.querySelectorAll(selector)].filter(isVisible);
			if (matches.length > 0) return matches.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0];
		}
		return null;
	}
	function topPageHeader() {
		return [...document.querySelectorAll("#page-header, header")].filter(isVisible).filter((header) => {
			const rect = header.getBoundingClientRect();
			return rect.top <= 12 && rect.width >= Math.min(320, window.innerWidth * .65);
		}).sort((a, b) => {
			const ar = a.getBoundingClientRect();
			const br = b.getBoundingClientRect();
			return ar.top - br.top || br.width - ar.width;
		})[0] ?? null;
	}
	var CHATGPT_FALLBACK_ACCENT = [
		94,
		106,
		210
	];
	function cssColorIsDark(raw) {
		const match = /^rgba?\(\s*([\d.]+)(?:\s*,\s*|\s+)([\d.]+)(?:\s*,\s*|\s+)([\d.]+)(?:\s*(?:,|\/)\s*([\d.]+%?))?\s*\)$/i.exec(raw.trim());
		if (!match) return null;
		const alphaRaw = match[4];
		const alpha = alphaRaw?.endsWith("%") ? Number(alphaRaw.slice(0, -1)) / 100 : Number(alphaRaw ?? 1);
		if (!Number.isFinite(alpha) || alpha < .5) return null;
		const channels = [
			Number(match[1]),
			Number(match[2]),
			Number(match[3])
		];
		if (channels.some((value) => !Number.isFinite(value))) return null;
		const linear = channels.map((value) => {
			const channel = Math.max(0, Math.min(255, value)) / 255;
			return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
		});
		return .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2] < .45;
	}
	function chatGPTIsDark() {
		const root = document.documentElement;
		const candidates = [root, document.body].filter((el) => Boolean(el));
		for (const el of candidates) {
			if ([...el.classList].some((name) => /(^|[-_])dark($|[-_])/i.test(name))) return true;
			for (const attribute of [
				"data-theme",
				"data-mode",
				"data-color-scheme"
			]) {
				const value = el.getAttribute(attribute)?.trim().toLowerCase();
				if (value === "dark") return true;
				if (value === "light") return false;
			}
		}
		for (const el of candidates) {
			const scheme = getComputedStyle(el).colorScheme.trim().toLowerCase();
			if (scheme.startsWith("dark")) return true;
			if (scheme.startsWith("light")) return false;
		}
		const surfaces = [
			topPageHeader(),
			document.body,
			root,
			document.querySelector("main")
		];
		for (const surface of surfaces) {
			if (!(surface instanceof HTMLElement)) continue;
			const dark = cssColorIsDark(getComputedStyle(surface).backgroundColor);
			if (dark !== null) return dark;
		}
		for (const el of candidates) {
			const foregroundIsDark = cssColorIsDark(getComputedStyle(el).color);
			if (foregroundIsDark !== null) return !foregroundIsDark;
		}
		return matchMedia("(prefers-color-scheme: dark)").matches;
	}
	function resolveChatGPTAccent(theme, readVariable, parse) {
		const name = theme || "default";
		const bg = parse(readVariable(`--${name}-theme-submit-btn-bg`));
		if (!bg) return {
			bg: [...CHATGPT_FALLBACK_ACCENT],
			fg: [
				255,
				255,
				255
			],
			ring: [...CHATGPT_FALLBACK_ACCENT]
		};
		return {
			bg,
			fg: parse(readVariable(`--${name}-theme-submit-btn-text`)),
			ring: parse(readVariable(`--${name}-theme-entity-accent`))
		};
	}
	function rightHeaderActionAnchor(header) {
		const headerRect = header.getBoundingClientRect();
		const rightZone = Math.max(headerRect.left + headerRect.width * .7, window.innerWidth * .75);
		const controls = [...header.querySelectorAll("button, a[role=\"button\"], [data-testid=\"profile-button\"]")].filter(isVisible).filter((el) => {
			const rect = el.getBoundingClientRect();
			return rect.top >= headerRect.top - 8 && rect.top < headerRect.bottom + 8;
		}).sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
		if (controls.length === 0 || controls[controls.length - 1].getBoundingClientRect().right < rightZone) return null;
		let first = controls.length - 1;
		while (first > 0) {
			const prev = controls[first - 1].getBoundingClientRect();
			const next = controls[first].getBoundingClientRect();
			if (next.left - prev.right >= 44 || Math.abs(next.top - prev.top) > 10) break;
			first--;
		}
		return controls[first];
	}
	function besideHeaderAnchor(element, header) {
		return element.getBoundingClientRect().left - 36 - 8 < 8 ? {
			element: header ?? element,
			placement: "below"
		} : {
			element,
			placement: "beside"
		};
	}
	function chatGPTHeaderAnchor() {
		const actionGroup = firstVisible(["#conversation-header-actions"]);
		const header = topPageHeader();
		if (actionGroup) return besideHeaderAnchor(actionGroup, header);
		if (!header) return null;
		const share = firstVisible([
			"[data-testid=\"share-chat-button\"]",
			"[data-testid*=\"share\" i]",
			"button[aria-label*=\"share\" i]",
			"button[aria-label*=\"分享\"]",
			"button[aria-label*=\"共享\"]"
		], header);
		const control = rightHeaderActionAnchor(header) ?? share;
		return control ? besideHeaderAnchor(control, header) : {
			element: header,
			placement: "inset"
		};
	}
	function chatGPTComposerAnchor() {
		const editor = bottommostVisible([
			"#prompt-textarea",
			"[data-testid=\"prompt-textarea\"]",
			"form[data-chatgpt-composer] [data-composer-markdown][contenteditable=\"true\"][role=\"textbox\"]",
			"form[data-chatgpt-composer] .ProseMirror[contenteditable=\"true\"]",
			"[data-composer-markdown][contenteditable=\"true\"][role=\"textbox\"]",
			"[contenteditable=\"true\"][data-lexical-editor=\"true\"][role=\"textbox\"]"
		]);
		if (!editor) return firstVisible(["form[data-chatgpt-composer]", "form[data-type=\"unified-composer\"]"]);
		const container = editor.closest("form[data-chatgpt-composer], form[data-type=\"unified-composer\"], form, [data-testid=\"composer\"], #thread-bottom-container");
		if (isVisible(container)) return container;
		const editorRect = editor.getBoundingClientRect();
		let ancestor = editor.parentElement;
		for (let depth = 0; ancestor && depth < 10; depth++, ancestor = ancestor.parentElement) {
			if (!isVisible(ancestor)) continue;
			const rect = ancestor.getBoundingClientRect();
			if (rect.width >= editorRect.width && rect.height >= editorRect.height + 16 && rect.height <= Math.min(240, window.innerHeight * .4) && rect.top <= editorRect.top && rect.bottom >= editorRect.bottom) return ancestor;
		}
		return editor;
	}
	var chatgptAdapter = {
		id: "chatgpt",
		label: "ChatGPT",
		supportsBatch: true,
		matches: () => /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/.test(location.hostname),
		currentConversationId() {
			const m = /\/c\/([0-9a-f][0-9a-f-]{10,})/i.exec(location.pathname);
			return m ? m[1] : null;
		},
		prepare: (cancel) => getAccessToken(cancel),
		fetchRaw: (session, id, cancel) => fetchConversation$1(session, id, cancel),
		createIRContextResolver: createChatGPTIRContextResolver,
		toIR: (raw, fallbackId, context) => conversationToIR$1(raw, fallbackId, context?.projectName),
		async fetchAsset(session, ref, cancel, maxBytes) {
			const target = ref.url ? await resolveSandboxDownload(session, ref.url, cancel) : await resolveFileDownload(session, ref.fileId, cancel);
			const { bytes, contentType } = await fetchBinary$1(target.url, cancel, maxBytes);
			return {
				bytes,
				filename: target.filename,
				contentType
			};
		},
		throttleStats: throttleStats$1,
		batch: {
			policy: {
				concurrency: 2,
				retryFailed: true,
				retryDelayMs: 2e4,
				failureAbortMin: 25,
				failureAbortRatio: .5
			},
			async listAll(session, onProgress, cancel) {
				return (await listAllConversations$1(session, onProgress, cancel)).map(toItem$1);
			},
			listSources: (session, cancel) => listProjects(session, cancel),
			createPager(session, cancel, source) {
				const pager = createConversationPager$1(session, cancel, source);
				return { async next() {
					const { items, done } = await pager.next();
					return {
						items: items.map(toItem$1),
						done
					};
				} };
			}
		},
		ui: {
			headerAnchor: chatGPTHeaderAnchor,
			composerAnchor: chatGPTComposerAnchor,
			isDark: chatGPTIsDark,
			themeAttributes: [
				"class",
				"style",
				"data-chat-theme",
				"data-theme",
				"data-mode",
				"data-color-scheme"
			],
			accent(parse) {
				const rootEl = document.documentElement;
				const cs = getComputedStyle(rootEl);
				return resolveChatGPTAccent(rootEl.getAttribute("data-chat-theme"), (name) => cs.getPropertyValue(name), parse);
			}
		}
	};
	function selectOrgId(organizations, activeOrgId, choose) {
		const memberships = [...new Map(organizations.filter((org) => typeof org?.uuid === "string" && org.uuid !== "").map((org) => [org.uuid, org])).values()];
		if (memberships.length === 0) throw new Error("拿不到组织 id：请确认已登录 claude.ai 后重试");
		if (activeOrgId && memberships.some((org) => org.uuid === activeOrgId)) return activeOrgId;
		if (memberships.length === 1) return memberships[0].uuid;
		const selected = choose(memberships);
		if (!selected || !memberships.some((org) => org.uuid === selected)) throw new Error("未选择 Claude 工作区，已停止导出；请确认当前工作区后重试");
		return selected;
	}
	function activeOrgFromCookie(cookie) {
		const value = /(?:^|;\s*)lastActiveOrg=([^;]+)/.exec(cookie)?.[1];
		try {
			return value ? decodeURIComponent(value) : null;
		} catch {
			return null;
		}
	}
	var fetcher = createFetcher({
		spacingBaseMs: 1500,
		spacingMaxMs: 8e3,
		restEveryN: 40,
		restDurationMs: 3e4,
		maxAttempts: 1
	});
	var throttleStats = () => fetcher.stats();
	var api = (path) => `${location.origin}${path}`;
	async function resolveOrgId(cancel) {
		const data = await (await fetcher.request(api("/api/organizations"), {}, cancel)).json();
		const list = Array.isArray(data) ? data : data?.organizations;
		if (!Array.isArray(list)) throw new Error("Claude 组织列表结构已变化");
		ensureAlive(cancel);
		return selectOrgId(list, activeOrgFromCookie(document.cookie), (orgs) => {
			const options = orgs.map((org, index) => `${index + 1}. ${org.name || `工作区 ${index + 1}`}`).join("\n");
			const answer = window.prompt(`无法确定当前 Claude 工作区，请输入要导出的工作区序号：\n${options}`);
			return orgs[answer && /^\d+$/.test(answer.trim()) ? Number(answer.trim()) - 1 : -1]?.uuid ?? null;
		});
	}
	function currentConversationId() {
		const m = /\/chat\/([0-9a-f-]{20,})/i.exec(location.pathname);
		return m ? m[1] : null;
	}
	async function fetchConversation(orgId, id, cancel) {
		const url = api(`/api/organizations/${orgId}/chat_conversations/${id}?tree=True&rendering_mode=messages&render_all_tools=true`);
		return await (await fetcher.request(url, { headers: { Accept: "application/json" } }, cancel)).json();
	}
	async function listSandboxFiles(orgId, conversationId, cancel) {
		const listUrl = api(`/api/organizations/${orgId}/conversations/${conversationId}/wiggle/list-files?prefix=`);
		const data = await (await fetcher.request(listUrl, { headers: { Accept: "application/json" } }, cancel)).json();
		if (!data || typeof data !== "object" || !Array.isArray(data.files_metadata)) throw new Error("Claude 沙箱文件清单结构已变化");
		return data.files_metadata.map((item) => {
			if (!item || typeof item !== "object") throw new Error("Claude 沙箱文件清单结构已变化：文件条目缺少 path");
			const raw = item;
			if (typeof raw["path"] !== "string" || raw["path"] === "") throw new Error("Claude 沙箱文件清单结构已变化：文件条目缺少 path");
			const path = raw["path"];
			const downloadUrl = api(`/api/organizations/${orgId}/conversations/${conversationId}/wiggle/download-file?path=${encodeURIComponent(path)}`);
			return {
				...raw,
				path,
				download_url: downloadUrl
			};
		});
	}
	async function listConversationsPage(orgId, offset, limit, cancel) {
		const url = api(`/api/organizations/${orgId}/chat_conversations?limit=${limit}&offset=${offset}`);
		const data = await (await fetcher.request(url, { headers: { Accept: "application/json" } }, cancel)).json();
		if (Array.isArray(data)) return data;
		if (data && typeof data === "object") {
			const nested = data.chat_conversations;
			if (Array.isArray(nested)) return nested;
		}
		throw new Error("Claude 对话列表结构已变化：预期数组");
	}
	function createConversationPager(orgId, cancel, opts = {}) {
		const fetchPage = opts.fetchPage ?? listConversationsPage;
		const emptyRetryBaseMs = opts.emptyRetryBaseMs ?? 4e3;
		const maxRequests = opts.maxRequests ?? 250;
		const maxItems = opts.maxItems ?? 1e4;
		let offset = 0;
		let limit = 50;
		let emptyRetries = 0;
		let done = false;
		let requests = 0;
		const seen = new Set();
		return { async next() {
			if (done) return {
				items: [],
				done: true
			};
			for (;;) {
				ensureAlive(cancel);
				if (requests >= maxRequests) throw new Error(`Claude 列表分页请求已达安全上限（${maxRequests} 次），已停止以防空转`);
				requests++;
				let items;
				try {
					items = await fetchPage(orgId, offset, limit, cancel);
				} catch (e) {
					if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429 && limit > 20) {
						limit = 20;
						continue;
					}
					throw e;
				}
				if (items.length === 0) {
					if (offset === 0 || emptyRetries >= 2) {
						done = true;
						return {
							items: [],
							done: true
						};
					}
					emptyRetries++;
					if (emptyRetryBaseMs > 0) await sleep(emptyRetryBaseMs * emptyRetries);
					continue;
				}
				if (items.some((i) => typeof i?.uuid !== "string" || i.uuid === "")) throw new Error("Claude 对话列表结构已变化：返回条目缺少 uuid");
				const fresh = [...new Map(items.map((i) => [i.uuid, i])).values()].filter((i) => !seen.has(i.uuid));
				if (fresh.length === 0) {
					done = true;
					return {
						items: [],
						done: true
					};
				}
				if (seen.size + fresh.length > maxItems) throw new Error(`Claude 对话数已超过安全上限（${maxItems} 条），已停止本次列表拉取`);
				for (const i of fresh) seen.add(i.uuid);
				emptyRetries = 0;
				offset += items.length;
				return {
					items: fresh,
					done: false
				};
			}
		} };
	}
	async function listAllConversations(orgId, onProgress, cancel, opts = {}) {
		const pager = createConversationPager(orgId, cancel, opts);
		const all = [];
		for (;;) {
			const { items, done } = await pager.next();
			all.push(...items);
			if (items.length > 0) onProgress?.(all.length);
			if (done) return all;
		}
	}
	function fetchBinary(url, cancel, maxBytes) {
		return fetchBinary$2(fetcher, absolute(url), cancel, maxBytes);
	}
	function absolute(url) {
		try {
			return new URL(url, location.origin).href;
		} catch {
			return url;
		}
	}
	var blockKey = (msgUuid, blockIndex) => `${msgUuid}#${blockIndex}`;
	function replayArtifacts(messages) {
		const ops = new Map();
		const docs = new Map();
		for (const msg of messages) {
			const blocks = msg.content ?? [];
			for (let i = 0; i < blocks.length; i++) {
				const block = blocks[i];
				if (block.type !== "tool_use" || block.name !== "artifacts") continue;
				const input = block.input ?? {};
				const id = str$1(input["id"]) || "__artifact__";
				const key = blockKey(msg.uuid, i);
				const command = str$1(input["command"]);
				let doc = docs.get(id);
				if (!doc) {
					doc = {
						title: "",
						mime: "",
						content: "",
						broken: false,
						lastGoodKey: key
					};
					docs.set(id, doc);
				}
				if (str$1(input["title"])) doc.title = str$1(input["title"]);
				if (str$1(input["type"])) doc.mime = str$1(input["type"]);
				if (str$1(input["language"])) doc.language = str$1(input["language"]);
				if (command === "update") {
					if (doc.broken) continue;
					const oldStr = input["old_str"];
					const newStr = input["new_str"];
					if (typeof oldStr !== "string" || typeof newStr !== "string" || !doc.content.includes(oldStr)) {
						doc.broken = true;
						continue;
					}
					doc.content = doc.content.replace(oldStr, () => newStr);
					doc.lastGoodKey = key;
					ops.set(key, {
						kind: "update",
						title: doc.title,
						mime: doc.mime,
						language: doc.language
					});
				} else if (command === "create" || command === "rewrite") {
					const content = input["content"];
					if (typeof content !== "string") {
						doc.broken = true;
						continue;
					}
					doc.content = content;
					doc.broken = false;
					doc.lastGoodKey = key;
					ops.set(key, {
						kind: command,
						title: doc.title,
						mime: doc.mime,
						language: doc.language
					});
				}
			}
		}
		for (const doc of docs.values()) {
			const op = ops.get(doc.lastGoodKey);
			if (op) op.finalContent = doc.content;
		}
		return ops;
	}
	function artifactDocType(mime, language) {
		switch (mime) {
			case "application/vnd.ant.react": return "code/jsx";
			case "text/html": return "code/html";
			case "image/svg+xml": return "code/svg";
			case "application/vnd.ant.mermaid": return "code/mermaid";
			case "application/vnd.ant.code": return `code/${language ?? ""}`;
			case "text/markdown": return "document";
			default: return "document";
		}
	}
	function str$1(v) {
		return typeof v === "string" ? v : "";
	}
	function conversationToIR(conv, fallbackId = "", sandboxFiles = [], sandboxUnavailable = false) {
		const convId = String(conv.uuid ?? fallbackId);
		const title = (conv.name ?? "").trim() || "Untitled";
		const messages = linearize(conv);
		const ctx = buildContext(convId, messages, sandboxFiles, sandboxUnavailable);
		const turns = groupTurns(messages).map((t) => ({
			role: t.role,
			blocks: t.messages.flatMap((m) => messageBlocks(m, ctx))
		}));
		const extra = [];
		const projectName = (conv.project?.name ?? "").trim();
		if (projectName) extra.push(["project", yamlQuote(projectName)]);
		return {
			source: "claude",
			id: convId,
			title,
			url: `https://claude.ai/chat/${convId}`,
			created: toIso(conv.created_at),
			updated: toIso(conv.updated_at),
			model: conv.model || void 0,
			extra,
			tags: ["claude"],
			assistantHeading: "Claude",
			turns,
			...sandboxUnavailable ? { assetDiscoveryFailed: true } : {}
		};
	}
	function linearize(conv) {
		const all = conv.chat_messages ?? [];
		if (all.length === 0) return [];
		const byUuid = new Map(all.map((m) => [m.uuid, m]));
		const leaf = conv.current_leaf_message_uuid;
		let chain = null;
		if (leaf && byUuid.has(leaf)) {
			const path = [];
			const seen = new Set();
			let cur = byUuid.get(leaf);
			while (cur && !seen.has(cur.uuid)) {
				seen.add(cur.uuid);
				path.push(cur);
				cur = cur.parent_message_uuid ? byUuid.get(cur.parent_message_uuid) : void 0;
			}
			if (path.length > 0) chain = path.reverse();
		}
		if (!chain) chain = [...all].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
		return chain.filter((m) => m.sender === "human" || m.sender === "assistant");
	}
	function groupTurns(messages) {
		const turns = [];
		for (const msg of messages) {
			const role = msg.sender === "human" ? "user" : "assistant";
			const last = turns[turns.length - 1];
			if (last && last.role === role) last.messages.push(msg);
			else turns.push({
				role,
				messages: [msg]
			});
		}
		return turns;
	}
	function messageBlocks(msg, ctx) {
		const blocks = [];
		const content = msg.content ?? [];
		for (let i = 0; i < content.length; i++) {
			const b = content[i];
			switch (b.type) {
				case "text":
					blocks.push(proseBlock(b));
					break;
				case "thinking":
					blocks.push(thinkingBlock(b));
					break;
				case "tool_use":
					blocks.push(...toolUseBlocks(b, msg.uuid, i, ctx));
					break;
				case "tool_result":
					blocks.push(toolResultBlock(b));
					break;
				default: blocks.push({
					kind: "raw",
					label: `未识别的内容块 \`${b.type}\`（原始 JSON）`,
					json: b
				});
			}
		}
		blocks.push(...attachmentBlocks(msg));
		if (msg.stop_reason === "user_canceled") blocks.push({
			kind: "note",
			text: "*(这条回复被用户中止)*"
		});
		if (msg.truncated === true) blocks.push({
			kind: "note",
			text: "*(服务端将这条消息标记为 truncated)*"
		});
		return blocks;
	}
	function proseBlock(b) {
		const sources = [];
		for (const c of b.citations ?? []) {
			if (c.is_expired === true) continue;
			const url = str(c.url);
			if (!url) continue;
			sources.push({
				title: str(c.title) || hostOf(url) || url,
				url
			});
		}
		return {
			kind: "prose",
			text: str(b.text),
			sources
		};
	}
	function thinkingBlock(b) {
		const text = str(b.thinking) || str(b.text);
		return {
			kind: "thinking",
			items: [{
				summary: (b.summaries ?? []).map((s) => str(s?.summary)).filter((s) => s !== "").join(" · ") || void 0,
				text
			}]
		};
	}
	function toolUseBlocks(b, msgUuid, index, ctx) {
		const name = str(b.name);
		const input = b.input ?? {};
		if (name === "present_files") {
			let files = sandboxFilesForInput(input, ctx);
			if (files.length === 0 && !ctx.usedPresentFallback) {
				ctx.usedPresentFallback = true;
				files = ctx.sandboxOutputs;
			}
			if (files.length > 0) return [{
				kind: "assetList",
				refs: files.map((file) => sandboxAssetRef(file, ctx.conversationId))
			}];
			if (ctx.sandboxUnavailable) return [{
				kind: "note",
				text: "*(Claude 生成文件清单获取失败，本次未能下载这些文件)*"
			}];
			return [{
				kind: "tool",
				title: "工具调用 → `present_files`",
				body: JSON.stringify(input, null, 2),
				lang: "json"
			}];
		}
		if (name === "artifacts") {
			const op = ctx.artifacts.get(blockKey(msgUuid, index));
			if (!op) return [{
				kind: "tool",
				title: "工具调用 → `artifacts`（重放失败，原始 JSON）",
				body: JSON.stringify(b, null, 2),
				lang: "json",
				gated: false
			}];
			if (op.finalContent != null) return [{
				kind: "document",
				label: `Artifact · ${op.title || "untitled"}`,
				docType: artifactDocType(op.mime, op.language),
				content: op.finalContent
			}];
			return [{
				kind: "note",
				text: op.kind === "create" ? `*(Artifact 创建「${op.title || "untitled"}」，终稿见后)*` : `*(Artifact 更新「${op.title || "untitled"}」，终稿见后)*`
			}];
		}
		if (name === "create_file" && typeof input["file_text"] === "string") {
			const path = str(input["path"]) || "file";
			const sandboxFile = sandboxFileForPath(path, ctx);
			if (sandboxFile && ctx.presentedPaths.has(sandboxFile.path)) return [{
				kind: "tool",
				title: `工具调用 → \`create_file\`（${path}）`,
				body: JSON.stringify(input, null, 2),
				lang: "json"
			}];
			return [{
				kind: "document",
				label: `文件 · ${path}`,
				docType: `code/${langOfPath(path)}`,
				content: input["file_text"]
			}];
		}
		if (name === "visualize:show_widget" && typeof input["widget_code"] === "string") return [{
			kind: "document",
			label: `Widget · ${str(input["title"]) || "untitled"}`,
			docType: "code/jsx",
			content: input["widget_code"]
		}];
		return [{
			kind: "tool",
			title: `工具调用 → \`${name || "unknown"}\``,
			body: JSON.stringify(input, null, 2),
			lang: "json"
		}];
	}
	function buildContext(conversationId, messages, sandboxFiles, sandboxUnavailable) {
		const sandboxByPath = new Map();
		const sandboxByBasename = new Map();
		const sandboxOutputs = [];
		for (const file of sandboxFiles) {
			const path = normalizePath(file.path);
			sandboxByPath.set(path, file);
			if (path.startsWith("/mnt/user-data/outputs/")) sandboxOutputs.push(file);
		}
		for (const file of [...sandboxFiles].sort((a, b) => outputRank(a.path) - outputRank(b.path))) {
			const base = basename(file.path);
			if (base && !sandboxByBasename.has(base)) sandboxByBasename.set(base, file);
		}
		const provisional = {
			conversationId,
			artifacts: replayArtifacts(messages),
			sandboxByPath,
			sandboxByBasename,
			sandboxOutputs,
			presentedPaths: new Set(),
			usedPresentFallback: false,
			sandboxUnavailable
		};
		let sawUnresolvedPresentFiles = false;
		for (const msg of messages) for (const block of msg.content ?? []) {
			if (block.type !== "tool_use" || block.name !== "present_files") continue;
			const matched = sandboxFilesForInput(block.input ?? {}, provisional);
			if (matched.length === 0) sawUnresolvedPresentFiles = true;
			for (const file of matched) provisional.presentedPaths.add(file.path);
		}
		if (sawUnresolvedPresentFiles) for (const file of sandboxOutputs) provisional.presentedPaths.add(file.path);
		return provisional;
	}
	function sandboxFilesForInput(input, ctx) {
		const paths = deepPathStrings(input);
		const out = [];
		const seen = new Set();
		for (const path of paths) {
			const file = sandboxFileForPath(path, ctx);
			if (file && !seen.has(file.path)) {
				seen.add(file.path);
				out.push(file);
			}
		}
		return out;
	}
	function sandboxFileForPath(path, ctx) {
		const normalized = normalizePath(path);
		return ctx.sandboxByPath.get(normalized) ?? ctx.sandboxByBasename.get(basename(normalized));
	}
	function deepPathStrings(value, out = []) {
		if (typeof value === "string") {
			if (/\/(?:mnt\/user-data\/(?:outputs|uploads)|home\/claude)\//.test(normalizePath(value))) out.push(value);
			return out;
		}
		if (Array.isArray(value)) for (const item of value) deepPathStrings(item, out);
		else if (value && typeof value === "object") for (const item of Object.values(value)) deepPathStrings(item, out);
		return out;
	}
	function sandboxAssetRef(file, conversationId) {
		const name = basename(file.path) || "file";
		const mime = str(file.content_type);
		return {
			fileId: `wiggle-${hashSandboxFile(conversationId, file.path)}`,
			kind: isImageFile(name, mime) ? "image" : "file",
			name,
			url: file.download_url,
			sizeBytes: typeof file.size === "number" ? file.size : void 0,
			mime: mime || void 0
		};
	}
	function isImageFile(name, mime) {
		return mime.startsWith("image/") || /\.(?:avif|gif|jpe?g|png|svg|webp)$/i.test(name);
	}
	function normalizePath(path) {
		return path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
	}
	function basename(path) {
		return normalizePath(path).split("/").filter(Boolean).pop() ?? "";
	}
	function outputRank(path) {
		return normalizePath(path).startsWith("/mnt/user-data/outputs/") ? 0 : 1;
	}
	function hashSandboxFile(conversationId, path) {
		return hashText(`${conversationId}\0${normalizePath(path)}`);
	}
	function toolResultBlock(b) {
		const isText = typeof b.content === "string";
		return {
			kind: "tool",
			tone: "note",
			title: b.is_error === true ? "工具返回（错误）" : "工具返回",
			body: isText ? b.content : JSON.stringify(b.content ?? null, null, 2),
			lang: isText ? "" : "json"
		};
	}
	function attachmentBlocks(msg) {
		const out = [];
		const fileRefs = [];
		for (const f of msg.files ?? []) {
			const name = str(f.file_name) || "file";
			const size = typeof f.size_bytes === "number" ? f.size_bytes : void 0;
			const kind = str(f.file_kind);
			if (kind === "image") {
				const url = str(f.preview_url) || str(f.preview_asset?.url);
				if (url) {
					out.push({
						kind: "asset",
						ref: {
							fileId: assetId(f, url),
							kind: "image",
							name,
							url,
							sizeBytes: size
						}
					});
					continue;
				}
			} else if (kind === "document") {
				const url = str(f.document_asset?.url);
				if (url) {
					fileRefs.push({
						fileId: assetId(f, url),
						kind: "file",
						name,
						url,
						sizeBytes: size
					});
					continue;
				}
			}
			out.push({
				kind: "note",
				text: `*(附件：${name}${kind ? ` · ${kind}` : ""} — 无可下载地址)*`
			});
		}
		if (fileRefs.length > 0) out.push({
			kind: "assetList",
			refs: fileRefs
		});
		for (const a of msg.attachments ?? []) {
			const name = str(a.file_name) || str(a.name) || "attachment";
			const content = str(a.extracted_content).trim();
			if (content === "") {
				out.push({
					kind: "note",
					text: `*(附件：${name})*`
				});
				continue;
			}
			out.push({
				kind: "document",
				label: `附件 · ${name}（文本抽取）`,
				docType: "document",
				content
			});
		}
		return out;
	}
	function assetId(f, url) {
		return str(f.file_uuid) || str(f.uuid) || `claude-url-${hashText(url)}`;
	}
	var EXT_LANG = {
		py: "python",
		js: "javascript",
		jsx: "jsx",
		ts: "typescript",
		tsx: "tsx",
		md: "markdown",
		html: "html",
		css: "css",
		json: "json",
		sh: "bash",
		yml: "yaml",
		yaml: "yaml",
		sql: "sql",
		java: "java",
		rb: "ruby",
		go: "go",
		rs: "rust",
		c: "c",
		cpp: "cpp",
		txt: ""
	};
	function langOfPath(path) {
		const file = path.split("/").pop() ?? path;
		return EXT_LANG[file.includes(".") ? file.split(".").pop().toLowerCase() : ""] ?? "";
	}
	function hostOf(url) {
		try {
			return new URL(url).hostname.replace(/^www\./, "");
		} catch {
			return "";
		}
	}
	function str(v) {
		return typeof v === "string" ? v : "";
	}
	var toItem = (item) => ({
		id: item.uuid,
		title: item.name ?? "",
		update_time: item.updated_at ?? null
	});
	var claudeAdapter = {
		id: "claude",
		label: "Claude",
		supportsBatch: true,
		matches: () => /(^|\.)claude\.ai$/.test(location.hostname),
		currentConversationId,
		prepare: (cancel) => resolveOrgId(cancel),
		fetchRaw: (session, id, cancel) => fetchConversation(session, id, cancel),
		createIRContextResolver: (session, cancel) => async (id, raw) => {
			if (!hasPresentFiles(raw)) return { sandboxFiles: [] };
			try {
				return { sandboxFiles: await listSandboxFiles(session, id, cancel) };
			} catch (error) {
				if (cancel?.cancelled || error instanceof BatchSafetyError) throw error;
				return {
					sandboxFiles: [],
					sandboxUnavailable: true
				};
			}
		},
		toIR: (raw, fallbackId, context) => conversationToIR(raw, fallbackId, context?.sandboxFiles ?? [], context?.sandboxUnavailable === true),
		async fetchAsset(_session, ref, cancel, maxBytes) {
			if (!ref.url) throw new Error(`附件 ${ref.name ?? ref.fileId} 没有可下载地址`);
			const { bytes, contentType } = await fetchBinary(ref.url, cancel, maxBytes);
			return {
				bytes,
				filename: null,
				contentType
			};
		},
		throttleStats,
		batch: {
			policy: {
				concurrency: 1,
				retryFailed: false,
				retryDelayMs: 0,
				failureAbortMin: 5,
				failureAbortRatio: .25,
				max429Hits: 3,
				maxRetryAfterHits: 1,
				maxRequests: 1e3
			},
			async listAll(session, onProgress, cancel) {
				return (await listAllConversations(session, onProgress, cancel)).map(toItem);
			},
			createPager(session, cancel) {
				const pager = createConversationPager(session, cancel);
				return { async next() {
					const { items, done } = await pager.next();
					return {
						items: items.map(toItem),
						done
					};
				} };
			}
		},
		ui: {
			headerAnchor: () => {
				const element = document.querySelector("[data-testid=\"wiggle-controls-actions-group\"]") ?? document.querySelector("[data-testid=\"wiggle-controls-actions\"]") ?? document.querySelector("[data-testid=\"wiggle-controls-actions-share\"]") ?? document.querySelector("#dframe-header-actions-slot") ?? document.querySelector("[data-testid=\"share-button\"]") ?? document.querySelector("[data-testid=\"chat-menu-trigger\"]") ?? document.querySelector("header button[aria-haspopup=\"menu\"]") ?? document.querySelector("[data-testid=\"chat-title-split\"]");
				return element ? {
					element,
					placement: "beside"
				} : null;
			},
			composerAnchor: () => (() => {
				const editor = document.querySelector("[data-testid=\"chat-input\"][contenteditable=\"true\"]");
				return editor?.closest(".rounded-composer") ?? editor?.closest("fieldset");
			})() ?? document.querySelector("fieldset div[contenteditable=\"true\"]")?.closest("fieldset") ?? document.querySelector("div[contenteditable=\"true\"][role=\"textbox\"]")?.closest("fieldset") ?? document.querySelector("div.ProseMirror[contenteditable=\"true\"]")?.parentElement ?? null,
			isDark: () => {
				const root = document.documentElement;
				if (root.classList.contains("dark")) return true;
				if (root.getAttribute("data-mode") === "dark") return true;
				const rgb = /(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(getComputedStyle(document.body).backgroundColor);
				if (!rgb) return false;
				const [r, g, b] = [
					Number(rgb[1]),
					Number(rgb[2]),
					Number(rgb[3])
				];
				return (.2126 * r + .7152 * g + .0722 * b) / 255 < .5;
			},
			themeAttributes: [
				"class",
				"data-mode",
				"data-theme"
			],
			accent(_parse) {
				const brandOrange = [
					217,
					119,
					87
				];
				return {
					bg: brandOrange,
					fg: null,
					ring: brandOrange
				};
			}
		}
	};
	function hasPresentFiles(conv) {
		return (conv.chat_messages ?? []).some((msg) => (msg.content ?? []).some((block) => block.type === "tool_use" && block.name === "present_files"));
	}
	var adapters = [chatgptAdapter, claudeAdapter];
	function resolveAdapter() {
		return adapters.find((a) => a.matches()) ?? null;
	}
	var ch2 = {};
	var wk = (function(c, id, msg, transfer, cb) {
		var w = new Worker(ch2[id] || (ch2[id] = URL.createObjectURL(new Blob([c + ";addEventListener(\"error\",function(e){e=e.error;postMessage({$e$:[e.message,e.code,e.stack]})})"], { type: "text/javascript" }))));
		w.onmessage = function(e) {
			var d = e.data, ed = d.$e$;
			if (ed) {
				var err = new Error(ed[0]);
				err["code"] = ed[1];
				err.stack = ed[2];
				cb(err, null);
			} else cb(null, d);
		};
		w.postMessage(msg, transfer);
		return w;
	});
	var u8 = Uint8Array, u16 = Uint16Array, i32 = Int32Array;
	var fleb = new u8([
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		1,
		1,
		1,
		1,
		2,
		2,
		2,
		2,
		3,
		3,
		3,
		3,
		4,
		4,
		4,
		4,
		5,
		5,
		5,
		5,
		0,
		0,
		0,
		0
	]);
	var fdeb = new u8([
		0,
		0,
		0,
		0,
		1,
		1,
		2,
		2,
		3,
		3,
		4,
		4,
		5,
		5,
		6,
		6,
		7,
		7,
		8,
		8,
		9,
		9,
		10,
		10,
		11,
		11,
		12,
		12,
		13,
		13,
		0,
		0
	]);
	var clim = new u8([
		16,
		17,
		18,
		0,
		8,
		7,
		9,
		6,
		10,
		5,
		11,
		4,
		12,
		3,
		13,
		2,
		14,
		1,
		15
	]);
	var freb = function(eb, start) {
		var b = new u16(31);
		for (var i = 0; i < 31; ++i) b[i] = start += 1 << eb[i - 1];
		var r = new i32(b[30]);
		for (var i = 1; i < 30; ++i) for (var j = b[i]; j < b[i + 1]; ++j) r[j] = j - b[i] << 5 | i;
		return {
			b,
			r
		};
	};
	var _a = freb(fleb, 2), fl = _a.b, revfl = _a.r;
	fl[28] = 258, revfl[258] = 28;
	var _b = freb(fdeb, 0);
	_b.b;
	var revfd = _b.r;
	var rev = new u16(32768);
	for (var i = 0; i < 32768; ++i) {
		var x = (i & 43690) >> 1 | (i & 21845) << 1;
		x = (x & 52428) >> 2 | (x & 13107) << 2;
		x = (x & 61680) >> 4 | (x & 3855) << 4;
		rev[i] = ((x & 65280) >> 8 | (x & 255) << 8) >> 1;
	}
	var hMap = (function(cd, mb, r) {
		var s = cd.length;
		var i = 0;
		var l = new u16(mb);
		for (; i < s; ++i) if (cd[i]) ++l[cd[i] - 1];
		var le = new u16(mb);
		for (i = 1; i < mb; ++i) le[i] = le[i - 1] + l[i - 1] << 1;
		var co;
		if (r) {
			co = new u16(1 << mb);
			var rvb = 15 - mb;
			for (i = 0; i < s; ++i) if (cd[i]) {
				var sv = i << 4 | cd[i];
				var r_1 = mb - cd[i];
				var v = le[cd[i] - 1]++ << r_1;
				for (var m = v | (1 << r_1) - 1; v <= m; ++v) co[rev[v] >> rvb] = sv;
			}
		} else {
			co = new u16(s);
			for (i = 0; i < s; ++i) if (cd[i]) co[i] = rev[le[cd[i] - 1]++] >> 15 - cd[i];
		}
		return co;
	});
	var flt = new u8(288);
	for (var i = 0; i < 144; ++i) flt[i] = 8;
	for (var i = 144; i < 256; ++i) flt[i] = 9;
	for (var i = 256; i < 280; ++i) flt[i] = 7;
	for (var i = 280; i < 288; ++i) flt[i] = 8;
	var fdt = new u8(32);
	for (var i = 0; i < 32; ++i) fdt[i] = 5;
	var flm = hMap(flt, 9, 0), fdm = hMap(fdt, 5, 0);
	var shft = function(p) {
		return (p + 7) / 8 | 0;
	};
	var slc = function(v, s, e) {
		if (s == null || s < 0) s = 0;
		if (e == null || e > v.length) e = v.length;
		return new u8(v.subarray(s, e));
	};
	var ec = [
		"unexpected EOF",
		"invalid block type",
		"invalid length/literal",
		"invalid distance",
		"stream finished",
		"no stream handler",
		,
		"no callback",
		"invalid UTF-8 data",
		"extra field too long",
		"date not in range 1980-2099",
		"filename too long",
		"stream finishing",
		"invalid zip data"
	];
	var err = function(ind, msg, nt) {
		var e = new Error(msg || ec[ind]);
		e.code = ind;
		if (Error.captureStackTrace) Error.captureStackTrace(e, err);
		if (!nt) throw e;
		return e;
	};
	var wbits = function(d, p, v) {
		v <<= p & 7;
		var o = p / 8 | 0;
		d[o] |= v;
		d[o + 1] |= v >> 8;
	};
	var wbits16 = function(d, p, v) {
		v <<= p & 7;
		var o = p / 8 | 0;
		d[o] |= v;
		d[o + 1] |= v >> 8;
		d[o + 2] |= v >> 16;
	};
	var hTree = function(d, mb) {
		var t = [];
		for (var i = 0; i < d.length; ++i) if (d[i]) t.push({
			s: i,
			f: d[i]
		});
		var s = t.length;
		var t2 = t.slice();
		if (!s) return {
			t: et,
			l: 0
		};
		if (s == 1) {
			var v = new u8(t[0].s + 1);
			v[t[0].s] = 1;
			return {
				t: v,
				l: 1
			};
		}
		t.sort(function(a, b) {
			return a.f - b.f;
		});
		t.push({
			s: -1,
			f: 25001
		});
		var l = t[0], r = t[1], i0 = 0, i1 = 1, i2 = 2;
		t[0] = {
			s: -1,
			f: l.f + r.f,
			l,
			r
		};
		while (i1 != s - 1) {
			l = t[t[i0].f < t[i2].f ? i0++ : i2++];
			r = t[i0 != i1 && t[i0].f < t[i2].f ? i0++ : i2++];
			t[i1++] = {
				s: -1,
				f: l.f + r.f,
				l,
				r
			};
		}
		var maxSym = t2[0].s;
		for (var i = 1; i < s; ++i) if (t2[i].s > maxSym) maxSym = t2[i].s;
		var tr = new u16(maxSym + 1);
		var mbt = ln(t[i1 - 1], tr, 0);
		if (mbt > mb) {
			var i = 0, dt = 0;
			var lft = mbt - mb, cst = 1 << lft;
			t2.sort(function(a, b) {
				return tr[b.s] - tr[a.s] || a.f - b.f;
			});
			for (; i < s; ++i) {
				var i2_1 = t2[i].s;
				if (tr[i2_1] > mb) {
					dt += cst - (1 << mbt - tr[i2_1]);
					tr[i2_1] = mb;
				} else break;
			}
			dt >>= lft;
			while (dt > 0) {
				var i2_2 = t2[i].s;
				if (tr[i2_2] < mb) dt -= 1 << mb - tr[i2_2]++ - 1;
				else ++i;
			}
			for (; i >= 0 && dt; --i) {
				var i2_3 = t2[i].s;
				if (tr[i2_3] == mb) {
					--tr[i2_3];
					++dt;
				}
			}
			mbt = mb;
		}
		return {
			t: new u8(tr),
			l: mbt
		};
	};
	var ln = function(n, l, d) {
		return n.s == -1 ? Math.max(ln(n.l, l, d + 1), ln(n.r, l, d + 1)) : l[n.s] = d;
	};
	var lc = function(c) {
		var s = c.length;
		while (s && !c[--s]);
		var cl = new u16(++s);
		var cli = 0, cln = c[0], cls = 1;
		var w = function(v) {
			cl[cli++] = v;
		};
		for (var i = 1; i <= s; ++i) if (c[i] == cln && i != s) ++cls;
		else {
			if (!cln && cls > 2) {
				for (; cls > 138; cls -= 138) w(32754);
				if (cls > 2) {
					w(cls > 10 ? cls - 11 << 5 | 28690 : cls - 3 << 5 | 12305);
					cls = 0;
				}
			} else if (cls > 3) {
				w(cln), --cls;
				for (; cls > 6; cls -= 6) w(8304);
				if (cls > 2) w(cls - 3 << 5 | 8208), cls = 0;
			}
			while (cls--) w(cln);
			cls = 1;
			cln = c[i];
		}
		return {
			c: cl.subarray(0, cli),
			n: s
		};
	};
	var clen = function(cf, cl) {
		var l = 0;
		for (var i = 0; i < cl.length; ++i) l += cf[i] * cl[i];
		return l;
	};
	var wfblk = function(out, pos, dat) {
		var s = dat.length;
		var o = shft(pos + 2);
		out[o] = s & 255;
		out[o + 1] = s >> 8;
		out[o + 2] = out[o] ^ 255;
		out[o + 3] = out[o + 1] ^ 255;
		for (var i = 0; i < s; ++i) out[o + i + 4] = dat[i];
		return (o + 4 + s) * 8;
	};
	var wblk = function(dat, out, final, syms, lf, df, eb, li, bs, bl, p) {
		wbits(out, p++, final);
		++lf[256];
		var _a = hTree(lf, 15), dlt = _a.t, mlb = _a.l;
		var _b = hTree(df, 15), ddt = _b.t, mdb = _b.l;
		var _c = lc(dlt), lclt = _c.c, nlc = _c.n;
		var _d = lc(ddt), lcdt = _d.c, ndc = _d.n;
		var lcfreq = new u16(19);
		for (var i = 0; i < lclt.length; ++i) ++lcfreq[lclt[i] & 31];
		for (var i = 0; i < lcdt.length; ++i) ++lcfreq[lcdt[i] & 31];
		var _e = hTree(lcfreq, 7), lct = _e.t, mlcb = _e.l;
		var nlcc = 19;
		for (; nlcc > 4 && !lct[clim[nlcc - 1]]; --nlcc);
		var flen = bl + 5 << 3;
		var ftlen = clen(lf, flt) + clen(df, fdt) + eb;
		var dtlen = clen(lf, dlt) + clen(df, ddt) + eb + 14 + 3 * nlcc + clen(lcfreq, lct) + 2 * lcfreq[16] + 3 * lcfreq[17] + 7 * lcfreq[18];
		if (bs >= 0 && flen <= ftlen && flen <= dtlen) return wfblk(out, p, dat.subarray(bs, bs + bl));
		var lm, ll, dm, dl;
		wbits(out, p, 1 + (dtlen < ftlen)), p += 2;
		if (dtlen < ftlen) {
			lm = hMap(dlt, mlb, 0), ll = dlt, dm = hMap(ddt, mdb, 0), dl = ddt;
			var llm = hMap(lct, mlcb, 0);
			wbits(out, p, nlc - 257);
			wbits(out, p + 5, ndc - 1);
			wbits(out, p + 10, nlcc - 4);
			p += 14;
			for (var i = 0; i < nlcc; ++i) wbits(out, p + 3 * i, lct[clim[i]]);
			p += 3 * nlcc;
			var lcts = [lclt, lcdt];
			for (var it = 0; it < 2; ++it) {
				var clct = lcts[it];
				for (var i = 0; i < clct.length; ++i) {
					var len = clct[i] & 31;
					wbits(out, p, llm[len]), p += lct[len];
					if (len > 15) wbits(out, p, clct[i] >> 5 & 127), p += clct[i] >> 12;
				}
			}
		} else lm = flm, ll = flt, dm = fdm, dl = fdt;
		for (var i = 0; i < li; ++i) {
			var sym = syms[i];
			if (sym > 255) {
				var len = sym >> 18 & 31;
				wbits16(out, p, lm[len + 257]), p += ll[len + 257];
				if (len > 7) wbits(out, p, sym >> 23 & 31), p += fleb[len];
				var dst = sym & 31;
				wbits16(out, p, dm[dst]), p += dl[dst];
				if (dst > 3) wbits16(out, p, sym >> 5 & 8191), p += fdeb[dst];
			} else wbits16(out, p, lm[sym]), p += ll[sym];
		}
		wbits16(out, p, lm[256]);
		return p + ll[256];
	};
	var deo = new i32([
		65540,
		131080,
		131088,
		131104,
		262176,
		1048704,
		1048832,
		2114560,
		2117632
	]);
	var et = new u8(0);
	var dflt = function(dat, lvl, plvl, pre, post, st) {
		var s = st.z || dat.length;
		var o = new u8(pre + s + 5 * (1 + Math.ceil(s / 7e3)) + post);
		var w = o.subarray(pre, o.length - post);
		var lst = st.l;
		var pos = (st.r || 0) & 7;
		if (lvl) {
			if (pos) w[0] = st.r >> 3;
			var opt = deo[lvl - 1];
			var n = opt >> 13, c = opt & 8191;
			var msk_1 = (1 << plvl) - 1;
			var prev = st.p || new u16(32768), head = st.h || new u16(msk_1 + 1);
			var bs1_1 = Math.ceil(plvl / 3), bs2_1 = 2 * bs1_1;
			var hsh = function(i) {
				return (dat[i] ^ dat[i + 1] << bs1_1 ^ dat[i + 2] << bs2_1) & msk_1;
			};
			var syms = new i32(25e3);
			var lf = new u16(288), df = new u16(32);
			var lc_1 = 0, eb = 0, i = st.i || 0, li = 0, wi = st.w || 0, bs = 0;
			for (; i + 2 < s; ++i) {
				var hv = hsh(i);
				var imod = i & 32767, pimod = head[hv];
				prev[imod] = pimod;
				head[hv] = imod;
				if (wi <= i) {
					var rem = s - i;
					if ((lc_1 > 7e3 || li > 24576) && (rem > 423 || !lst)) {
						pos = wblk(dat, w, 0, syms, lf, df, eb, li, bs, i - bs, pos);
						li = lc_1 = eb = 0, bs = i;
						for (var j = 0; j < 286; ++j) lf[j] = 0;
						for (var j = 0; j < 30; ++j) df[j] = 0;
					}
					var l = 2, d = 0, ch_1 = c, dif = imod - pimod & 32767;
					if (rem > 2 && hv == hsh(i - dif)) {
						var maxn = Math.min(n, rem) - 1;
						var maxd = Math.min(32767, i);
						var ml = Math.min(258, rem);
						while (dif <= maxd && --ch_1 && imod != pimod) {
							if (dat[i + l] == dat[i + l - dif]) {
								var nl = 0;
								for (; nl < ml && dat[i + nl] == dat[i + nl - dif]; ++nl);
								if (nl > l) {
									l = nl, d = dif;
									if (nl > maxn) break;
									var mmd = Math.min(dif, nl - 2);
									var md = 0;
									for (var j = 0; j < mmd; ++j) {
										var ti = i - dif + j & 32767;
										var cd = ti - prev[ti] & 32767;
										if (cd > md) md = cd, pimod = ti;
									}
								}
							}
							imod = pimod, pimod = prev[imod];
							dif += imod - pimod & 32767;
						}
					}
					if (d) {
						syms[li++] = 268435456 | revfl[l] << 18 | revfd[d];
						var lin = revfl[l] & 31, din = revfd[d] & 31;
						eb += fleb[lin] + fdeb[din];
						++lf[257 + lin];
						++df[din];
						wi = i + l;
						++lc_1;
					} else {
						syms[li++] = dat[i];
						++lf[dat[i]];
					}
				}
			}
			for (i = Math.max(i, wi); i < s; ++i) {
				syms[li++] = dat[i];
				++lf[dat[i]];
			}
			pos = wblk(dat, w, lst, syms, lf, df, eb, li, bs, i - bs, pos);
			if (!lst) {
				st.r = pos & 7 | w[pos / 8 | 0] << 3;
				pos -= 7;
				st.h = head, st.p = prev, st.i = i, st.w = wi;
			}
		} else {
			for (var i = st.w || 0; i < s + lst; i += 65535) {
				var e = i + 65535;
				if (e >= s) {
					w[pos / 8 | 0] = lst;
					e = s;
				}
				pos = wfblk(w, pos + 1, dat.subarray(i, e));
			}
			st.i = s;
		}
		return slc(o, 0, pre + shft(pos) + post);
	};
	var crct = (function() {
		var t = new Int32Array(256);
		for (var i = 0; i < 256; ++i) {
			var c = i, k = 9;
			while (--k) c = (c & 1 && -306674912) ^ c >>> 1;
			t[i] = c;
		}
		return t;
	})();
	var crc = function() {
		var c = -1;
		return {
			p: function(d) {
				var cr = c;
				for (var i = 0; i < d.length; ++i) cr = crct[cr & 255 ^ d[i]] ^ cr >>> 8;
				c = cr;
			},
			d: function() {
				return ~c;
			}
		};
	};
	var dopt = function(dat, opt, pre, post, st) {
		if (!st) {
			st = { l: 1 };
			if (opt.dictionary) {
				var dict = opt.dictionary.subarray(-32768);
				var newDat = new u8(dict.length + dat.length);
				newDat.set(dict);
				newDat.set(dat, dict.length);
				dat = newDat;
				st.w = dict.length;
			}
		}
		return dflt(dat, opt.level == null ? 6 : opt.level, opt.mem == null ? st.l ? Math.ceil(Math.max(8, Math.min(13, Math.log(dat.length))) * 1.5) : 20 : 12 + opt.mem, pre, post, st);
	};
	var mrg = function(a, b) {
		var o = {};
		for (var k in a) o[k] = a[k];
		for (var k in b) o[k] = b[k];
		return o;
	};
	var wcln = function(fn, fnStr, td) {
		var dt = fn();
		var st = fn.toString();
		var ks = st.slice(st.indexOf("[") + 1, st.lastIndexOf("]")).replace(/\s+/g, "").split(",");
		for (var i = 0; i < dt.length; ++i) {
			var v = dt[i], k = ks[i];
			if (typeof v == "function") {
				fnStr += ";" + k + "=";
				var st_1 = v.toString();
				if (v.prototype) if (st_1.indexOf("[native code]") != -1) {
					var spInd = st_1.indexOf(" ", 8) + 1;
					fnStr += st_1.slice(spInd, st_1.indexOf("(", spInd));
				} else {
					fnStr += st_1;
					for (var t in v.prototype) fnStr += ";" + k + ".prototype." + t + "=" + v.prototype[t].toString();
				}
				else fnStr += st_1;
			} else td[k] = v;
		}
		return fnStr;
	};
	var ch = [];
	var cbfs = function(v) {
		var tl = [];
		for (var k in v) if (v[k].buffer) tl.push((v[k] = new v[k].constructor(v[k])).buffer);
		return tl;
	};
	var wrkr = function(fns, init, id, cb) {
		if (!ch[id]) {
			var fnStr = "", td_1 = {}, m = fns.length - 1;
			for (var i = 0; i < m; ++i) fnStr = wcln(fns[i], fnStr, td_1);
			ch[id] = {
				c: wcln(fns[m], fnStr, td_1),
				e: td_1
			};
		}
		var td = mrg({}, ch[id].e);
		return wk(ch[id].c + ";onmessage=function(e){for(var k in e.data)self[k]=e.data[k];onmessage=" + init.toString() + "}", id, td, cbfs(td), cb);
	};
	var bDflt = function() {
		return [
			u8,
			u16,
			i32,
			fleb,
			fdeb,
			clim,
			revfl,
			revfd,
			flm,
			flt,
			fdm,
			fdt,
			rev,
			deo,
			et,
			hMap,
			wbits,
			wbits16,
			hTree,
			ln,
			lc,
			clen,
			wfblk,
			wblk,
			shft,
			slc,
			dflt,
			dopt,
			deflateSync,
			pbf
		];
	};
	var pbf = function(msg) {
		return postMessage(msg, [msg.buffer]);
	};
	var cbify = function(dat, opts, fns, init, id, cb) {
		var w = wrkr(fns, init, id, function(err, dat) {
			w.terminate();
			cb(err, dat);
		});
		w.postMessage([dat, opts], opts.consume ? [dat.buffer] : []);
		return function() {
			w.terminate();
		};
	};
	var wbytes = function(d, b, v) {
		for (; v; ++b) d[b] = v, v >>>= 8;
	};
	function deflate(data, opts, cb) {
		if (!cb) cb = opts, opts = {};
		if (typeof cb != "function") err(7);
		return cbify(data, opts, [bDflt], function(ev) {
			return pbf(deflateSync(ev.data[0], ev.data[1]));
		}, 0, cb);
	}
	function deflateSync(data, opts) {
		return dopt(data, opts || {}, 0, 0);
	}
	var fltn = function(d, p, t, o) {
		for (var k in d) {
			var val = d[k], n = p + k, op = o;
			if (Array.isArray(val)) op = mrg(o, val[1]), val = val[0];
			if (ArrayBuffer.isView(val)) t[n] = [val, op];
			else {
				t[n += "/"] = [new u8(0), op];
				fltn(val, n, t, o);
			}
		}
	};
	var te = typeof TextEncoder != "undefined" && new TextEncoder();
	var td = typeof TextDecoder != "undefined" && new TextDecoder();
	try {
		td.decode(et, { stream: true });
	} catch (e) {}
	function strToU8(str, latin1) {
		if (latin1) {
			var ar_1 = new u8(str.length);
			for (var i = 0; i < str.length; ++i) ar_1[i] = str.charCodeAt(i);
			return ar_1;
		}
		if (te) return te.encode(str);
		var l = str.length;
		var ar = new u8(str.length + (str.length >> 1));
		var ai = 0;
		var w = function(v) {
			ar[ai++] = v;
		};
		for (var i = 0; i < l; ++i) {
			if (ai + 5 > ar.length) {
				var n = new u8(ai + 8 + (l - i << 1));
				n.set(ar);
				ar = n;
			}
			var c = str.charCodeAt(i);
			if (c < 128 || latin1) w(c);
			else if (c < 2048) w(192 | c >> 6), w(128 | c & 63);
			else if (c > 55295 && c < 57344) c = 65536 + (c & 1047552) | str.charCodeAt(++i) & 1023, w(240 | c >> 18), w(128 | c >> 12 & 63), w(128 | c >> 6 & 63), w(128 | c & 63);
			else w(224 | c >> 12), w(128 | c >> 6 & 63), w(128 | c & 63);
		}
		return slc(ar, 0, ai);
	}
	var exfl = function(ex) {
		var le = 0;
		if (ex) for (var k in ex) {
			var l = ex[k].length;
			if (l > 65535) err(9);
			le += l + 4;
		}
		return le;
	};
	var wzh = function(d, b, f, fn, u, c, ce, co) {
		var fl = fn.length, ex = f.extra, col = co && co.length;
		var exl = exfl(ex);
		wbytes(d, b, ce != null ? 33639248 : 67324752), b += 4;
		if (ce != null) d[b++] = 20, d[b++] = f.os;
		d[b] = 20, b += 2;
		d[b++] = f.flag << 1 | (c < 0 && 8), d[b++] = u && 8;
		d[b++] = f.compression & 255, d[b++] = f.compression >> 8;
		var dt = new Date(f.mtime == null ? Date.now() : f.mtime), y = dt.getFullYear() - 1980;
		if (y < 0 || y > 119) err(10);
		wbytes(d, b, y << 25 | dt.getMonth() + 1 << 21 | dt.getDate() << 16 | dt.getHours() << 11 | dt.getMinutes() << 5 | dt.getSeconds() >> 1), b += 4;
		if (c != -1) {
			wbytes(d, b, f.crc);
			wbytes(d, b + 4, c < 0 ? -c - 2 : c);
			wbytes(d, b + 8, f.size);
		}
		wbytes(d, b + 12, fl);
		wbytes(d, b + 14, exl), b += 16;
		if (ce != null) {
			wbytes(d, b, col);
			wbytes(d, b + 6, f.attrs);
			wbytes(d, b + 10, ce), b += 14;
		}
		d.set(fn, b);
		b += fl;
		if (exl) for (var k in ex) {
			var exf = ex[k], l = exf.length;
			wbytes(d, b, +k);
			wbytes(d, b + 2, l);
			d.set(exf, b + 4), b += 4 + l;
		}
		if (col) d.set(co, b), b += col;
		return b;
	};
	var wzf = function(o, b, c, d, e) {
		wbytes(o, b, 101010256);
		wbytes(o, b + 8, c);
		wbytes(o, b + 10, c);
		wbytes(o, b + 12, d);
		wbytes(o, b + 16, e);
	};
	function zip(data, opts, cb) {
		if (!cb) cb = opts, opts = {};
		if (typeof cb != "function") err(7);
		var r = {};
		fltn(data, "", r, opts);
		var k = Object.keys(r);
		var lft = k.length, o = 0, tot = 0;
		var slft = lft, files = new Array(lft);
		var term = [];
		var tAll = function() {
			for (var i = 0; i < term.length; ++i) term[i]();
		};
		var cbd = function(a, b) {
			mt(function() {
				cb(a, b);
			});
		};
		mt(function() {
			cbd = cb;
		});
		var cbf = function() {
			var out = new u8(tot + 22), oe = o, cdl = tot - o;
			tot = 0;
			for (var i = 0; i < slft; ++i) {
				var f = files[i];
				try {
					var l = f.c.length;
					wzh(out, tot, f, f.f, f.u, l);
					var badd = 30 + f.f.length + exfl(f.extra);
					var loc = tot + badd;
					out.set(f.c, loc);
					wzh(out, o, f, f.f, f.u, l, tot, f.m), o += 16 + badd + (f.m ? f.m.length : 0), tot = loc + l;
				} catch (e) {
					return cbd(e, null);
				}
			}
			wzf(out, o, files.length, cdl, oe);
			cbd(null, out);
		};
		if (!lft) cbf();
		var _loop_1 = function(i) {
			var fn = k[i];
			var _a = r[fn], file = _a[0], p = _a[1];
			var c = crc(), size = file.length;
			c.p(file);
			var f = strToU8(fn), s = f.length;
			var com = p.comment, m = com && strToU8(com), ms = m && m.length;
			var exl = exfl(p.extra);
			var compression = p.level == 0 ? 0 : 8;
			var cbl = function(e, d) {
				if (e) {
					tAll();
					cbd(e, null);
				} else {
					var l = d.length;
					files[i] = mrg(p, {
						size,
						crc: c.d(),
						c: d,
						f,
						m,
						u: s != fn.length || m && com.length != ms,
						compression
					});
					o += 30 + s + exl + l;
					tot += 76 + 2 * (s + exl) + (ms || 0) + l;
					if (!--lft) cbf();
				}
			};
			if (s > 65535) cbl(err(11, 0, 1), null);
			if (!compression) cbl(null, file);
			else if (size < 16e4) try {
				cbl(null, deflateSync(file, p));
			} catch (e) {
				cbl(e, null);
			}
			else term.push(deflate(file, p, cbl));
		};
		for (var i = 0; i < slft; ++i) _loop_1(i);
		return tAll;
	}
	var mt = typeof queueMicrotask == "function" ? queueMicrotask : typeof setTimeout == "function" ? setTimeout : function(fn) {
		fn();
	};
	function makeZip(files) {
		return new Promise((resolve, reject) => {
			zip(files, { level: 6 }, (err, data) => err ? reject(err) : resolve(data));
		});
	}
	function downloadBlob(filename, data, mime = "application/zip") {
		const blob = new Blob([data], { type: mime });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = filename;
		document.body.append(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 6e4);
	}
	var EXT_BY_MIME = {
		"image/avif": ".avif",
		"image/gif": ".gif",
		"image/jpeg": ".jpg",
		"image/png": ".png",
		"image/svg+xml": ".svg",
		"image/webp": ".webp"
	};
	function assetFileName(asset, downloadName, contentType) {
		const raw = sanitizeName(downloadName ?? asset.name ?? "");
		const matchedExt = /\.[A-Za-z0-9]{1,8}$/.exec(raw)?.[0] ?? "";
		const base = (matchedExt ? raw.slice(0, -matchedExt.length) : raw).slice(0, 60).trim();
		const ext = EXT_BY_MIME[(contentType ?? "").split(";")[0].trim().toLowerCase()] ?? matchedExt;
		return (base || (asset.kind === "image" ? "image" : "file")) + ext;
	}
	function assetReferencePath(style, notesPrefix, relativePath) {
		return style === "wikilink" ? `${notesPrefix}${relativePath}` : relativePath;
	}
	function supportsDirectoryPicker() {
		return typeof window.showDirectoryPicker === "function";
	}
	var DB_NAME = "inkstone";
	var STORE = "kv";
	var KEY = "vaultDir";
	function openDb() {
		return new Promise((resolve, reject) => {
			const req = indexedDB.open(DB_NAME, 1);
			req.onupgradeneeded = () => req.result.createObjectStore(STORE);
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
	}
	async function idbRun(mode, fn) {
		const db = await openDb();
		try {
			return await new Promise((resolve, reject) => {
				const req = fn(db.transaction(STORE, mode).objectStore(STORE));
				req.onsuccess = () => resolve(req.result);
				req.onerror = () => reject(req.error);
			});
		} finally {
			db.close();
		}
	}
	async function forgetVaultDir() {
		try {
			await idbRun("readwrite", (s) => s.delete(KEY));
		} catch {}
	}
	async function acquireVaultDir() {
		if (!supportsDirectoryPicker()) return null;
		try {
			const saved = await idbRun("readonly", (s) => s.get(KEY));
			if (saved && await ensurePermission(saved)) return saved;
		} catch {}
		try {
			const handle = await window.showDirectoryPicker({
				id: "inkstone-vault",
				mode: "readwrite"
			});
			try {
				await idbRun("readwrite", (s) => s.put(handle, KEY));
			} catch {}
			return handle;
		} catch (e) {
			if (e instanceof DOMException && e.name === "AbortError") return null;
			throw e;
		}
	}
	async function ensurePermission(handle) {
		if (typeof handle.queryPermission !== "function") return false;
		if (await handle.queryPermission({ mode: "readwrite" }) === "granted") return true;
		return typeof handle.requestPermission === "function" ? await handle.requestPermission({ mode: "readwrite" }) === "granted" : false;
	}
	async function writeVaultFile(root, relPath, data) {
		const parts = relPath.split("/").filter((p) => p !== "" && p !== "." && p !== "..");
		if (parts.length === 0) throw new Error(`非法写入路径：${relPath}`);
		let dir = root;
		for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
		const w = await (await dir.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
		try {
			await w.write(data);
			await w.close();
		} catch (e) {
			await w.abort().catch(() => {});
			throw e;
		}
	}
	function storeGet(key) {
		try {
			if (typeof GM_getValue === "function") return GM_getValue(key) ?? null;
		} catch {}
		try {
			return localStorage.getItem(key);
		} catch {
			return null;
		}
	}
	function storeSet(key, value) {
		try {
			if (typeof GM_setValue === "function") {
				GM_setValue(key, value);
				return;
			}
		} catch {}
		try {
			localStorage.setItem(key, value);
		} catch {}
	}
	var keyFor = (kind) => `inkstone:wm:${kind}`;
	function loadWatermark(kind) {
		let stored = storeGet(keyFor(kind));
		const legacyKind = /^chatgpt:(markdown|json)$/.exec(kind)?.[1];
		const migrate = stored === null && legacyKind != null;
		if (migrate) stored = storeGet(keyFor(legacyKind));
		try {
			const parsed = JSON.parse(stored ?? "{}");
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				if (migrate) saveWatermark(kind, parsed);
				return parsed;
			}
		} catch {}
		return {};
	}
	function saveWatermark(kind, wm) {
		storeSet(keyFor(kind), JSON.stringify(wm));
	}
	function clearWatermarks(kinds) {
		for (const kind of kinds) saveWatermark(kind, {});
	}
	var SETTINGS_KEY = "inkstone:settings";
	var DEFAULT_SETTINGS = {
		maxFileMB: 2,
		linkStyle: "wikilink",
		headingMode: "demote",
		target: "zip",
		notesDir: "conversations",
		attachmentsDir: "attachments",
		fabPos: "header"
	};
	function loadSettings() {
		try {
			const parsed = JSON.parse(storeGet(SETTINGS_KEY) ?? "{}");
			if (parsed && typeof parsed === "object") {
				const s = parsed;
				return {
					maxFileMB: typeof s.maxFileMB === "number" && Number.isFinite(s.maxFileMB) && s.maxFileMB > 0 ? s.maxFileMB : DEFAULT_SETTINGS.maxFileMB,
					linkStyle: s.linkStyle === "markdown" ? "markdown" : "wikilink",
					headingMode: s.headingMode === "strip" ? "strip" : "demote",
					target: s.target === "folder" ? "folder" : "zip",
					notesDir: typeof s.notesDir === "string" ? sanitizeSubdir(s.notesDir) : DEFAULT_SETTINGS.notesDir,
					attachmentsDir: typeof s.attachmentsDir === "string" ? sanitizeSubdir(s.attachmentsDir) : DEFAULT_SETTINGS.attachmentsDir,
					fabPos: s.fabPos === "composer" ? "composer" : "header"
				};
			}
		} catch {}
		return { ...DEFAULT_SETTINGS };
	}
	function saveSettings(patch) {
		storeSet(SETTINGS_KEY, JSON.stringify({
			...loadSettings(),
			...patch
		}));
	}
	function selectChanged(items, wm) {
		return items.filter((i) => wm[i.id] !== String(i.update_time ?? ""));
	}
	function computeFabPlacement(mode, rect, viewport, size, gap, headerPlacement = "beside") {
		if (!Number.isFinite(rect.top) || !Number.isFinite(rect.right) || !Number.isFinite(rect.bottom) || !Number.isFinite(rect.left) || !Number.isFinite(rect.height) || rect.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return null;
		const visibleTop = Math.max(0, rect.top);
		const visibleBottom = Math.min(viewport.height, rect.bottom);
		if (visibleBottom <= visibleTop) return null;
		const visibleHeight = visibleBottom - visibleTop;
		if (mode === "header") {
			if (rect.top < 0) return null;
			if (headerPlacement === "below" || headerPlacement === "beside" && rect.left - gap - size < 8) return {
				right: 8,
				bottom: Math.round(viewport.height - rect.bottom - gap - size),
				panelTop: Math.round(rect.bottom + gap + size + 10)
			};
			return {
				right: headerPlacement === "inset" ? Math.max(8, Math.round(viewport.width - rect.right + 8)) : Math.round(viewport.width - rect.left + gap),
				bottom: Math.round(viewport.height - rect.bottom + (rect.height - size) / 2),
				panelTop: Math.round(rect.bottom + 10)
			};
		}
		const beside = Math.round(viewport.width - rect.right - gap - size);
		if (beside >= 8) {
			const right = beside;
			return {
				right,
				bottom: Math.round(Math.max(8, viewport.height - visibleBottom + (visibleHeight - size) / 2)),
				panelLeft: composerPanelLeft(viewport.width, right, size)
			};
		}
		const right = 20;
		return {
			right,
			bottom: Math.round(Math.min(viewport.height - 60, viewport.height - visibleTop + gap)),
			panelLeft: composerPanelLeft(viewport.width, right, size)
		};
	}
	function composerPanelLeft(viewportWidth, fabRight, fabSize) {
		const fabLeft = viewportWidth - fabRight - fabSize;
		return Math.round(Math.max(16, Math.min(fabLeft, viewportWidth - 192 - 16)));
	}
	var STYLE = `
  :host { all: initial; }
  :host([data-site="chatgpt"]) {
    /* ChatGPT 顶栏 surface 建立独立层叠上下文；仅此站点需要最高层 overlay。 */
    position: fixed; left: 0; top: 0; width: 0; height: 0; overflow: visible;
    z-index: 2147483647; isolation: isolate; pointer-events: none;
  }
  :host {
    --fg: #0d0d0d; --muted: #5d5d63;
    --glass: rgba(255, 255, 255, .62); --solid: #f7f7f8;
    --edge: rgba(255, 255, 255, .65);
    --border: rgba(13, 13, 13, .08);
    --hover: rgba(13, 13, 13, .05); --track: rgba(13, 13, 13, .06);
    --thumb: rgba(255, 255, 255, .9);
    --accent: #0d0d0d; --accent-hover: #3a3a3a; --accent-fg: #ffffff;
    --ring: #0d0d0d; --danger: #b3372a;
    --sheen: rgba(255, 255, 255, .5);
    --cta-glow: 0 5px 18px rgba(0, 0, 0, .22);
    --shadow: 0 16px 48px rgba(0, 0, 0, .16), 0 2px 10px rgba(0, 0, 0, .06);
    --ease: cubic-bezier(.16, 1, .3, 1);
    color-scheme: light;
  }
  :host([data-theme="dark"]) {
    --fg: #f2f2f3; --muted: #a0a0a9;
    --glass: rgba(30, 30, 34, .62); --solid: #2c2c31;
    --edge: rgba(255, 255, 255, .12);
    --border: rgba(255, 255, 255, .10);
    --hover: rgba(255, 255, 255, .07); --track: rgba(255, 255, 255, .08);
    --thumb: rgba(255, 255, 255, .17);
    --accent: #ececec; --accent-hover: #ffffff; --accent-fg: #0d0d0d;
    --ring: #ececec; --danger: #e8836f;
    --sheen: rgba(255, 255, 255, .22);
    --cta-glow: 0 5px 18px rgba(0, 0, 0, .45);
    --shadow: 0 16px 48px rgba(0, 0, 0, .55), 0 2px 10px rgba(0, 0, 0, .3);
    color-scheme: dark;
  }
  * {
    box-sizing: border-box;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, "Segoe UI", Roboto, sans-serif;
  }
  button { cursor: pointer; font-family: inherit; color: inherit; }
  :focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
  input[type="checkbox"] { accent-color: var(--accent); margin: 0; width: 14px; height: 14px; cursor: pointer; }

  .fab {
    /* Claude 的菜单、搜索结果和设置/usage 弹层使用更高的应用层级（通常是 z-50）。
       保持在普通页面内容之上，但不要压过这些页面级弹层。 */
    position: fixed; right: var(--fab-right, 20px); bottom: var(--fab-bottom, 88px); z-index: 40;
    width: 44px; height: 44px; border-radius: 50%; overflow: hidden;
    visibility: hidden; /* 定位完成（.in）前不现身，避免从默认角落跳到输入框旁 */
    color: var(--fg); border: 1px solid var(--border);
    background: var(--glass);
    -webkit-backdrop-filter: blur(16px) saturate(180%);
    backdrop-filter: blur(16px) saturate(180%);
    box-shadow: inset 0 1px 0 var(--edge), 0 6px 20px rgba(0, 0, 0, .18);
    /* right/bottom 过渡只在布局变化的一瞬生效（侧栏开合、输入框长高），平时零开销 */
    transition: transform .15s var(--ease), background-color .2s var(--ease), color .2s var(--ease),
      right .25s var(--ease), bottom .25s var(--ease);
    pointer-events: auto;
  }
  .fab.in { visibility: visible; animation: pop .3s var(--ease); }
  @keyframes pop { from { opacity: 0; transform: scale(.5); } }
  .fab:hover { transform: scale(1.06); }
  .fab:active { transform: scale(.94); }
  .fab svg { display: block; }
  .fab .ic {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    transition: opacity .18s var(--ease), transform .22s var(--ease);
  }
  .fab .ic-arrow { opacity: 0; transform: translateY(-9px); }
  .fab.open { background: var(--accent); color: var(--accent-fg); border-color: transparent;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, .28), var(--cta-glow); }
  .fab.open .ic-dl { opacity: 0; transform: translateY(9px); }
  .fab.open .ic-arrow { opacity: 1; transform: none; }
  .fab::after {
    content: ""; position: absolute; inset: 0; pointer-events: none;
    background: linear-gradient(115deg, transparent 35%, var(--sheen) 50%, transparent 65%);
    transform: translateX(-130%);
  }
  .fab:hover::after { transform: translateX(130%); transition: transform .6s ease; }

  /* header 模式：仿 ChatGPT 顶栏 Share/「…」——36px、圆角 8px、
     底色照抄页面 translucent-surface（透明 + blur(24px) 液态玻璃，无阴影），
     悬浮才出圆角矩形底色；无高光扫过 */
  :host([data-pos="header"]) .fab {
    width: var(--header-fab-size, 36px); height: var(--header-fab-size, 36px); border-radius: 8px;
    background: transparent; border-color: transparent; box-shadow: none;
    -webkit-backdrop-filter: blur(24px); backdrop-filter: blur(24px);
    /* 缩放后旧坐标可能已在视口外，顶栏定位直接到位，不沿旧坐标过渡。 */
    transition: background-color .2s var(--ease), color .2s var(--ease);
  }
  /* ChatGPT 新顶栏本身是全宽 surface；给入口一层轻底色，避免图标与 surface 融在一起。 */
  :host([data-site="chatgpt"][data-pos="header"]) .fab {
    background: var(--hover); border-color: var(--border); box-shadow: inset 0 1px 0 var(--edge);
  }
  :host([data-site="chatgpt"][data-pos="header"][data-theme="dark"]) .fab:not(.open) {
    color: #fff; background: rgba(255, 255, 255, .14); border-color: rgba(255, 255, 255, .2);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, .18), 0 2px 8px rgba(0, 0, 0, .24);
  }
  :host([data-site="chatgpt"][data-pos="header"][data-theme="dark"]) .fab:not(.open):hover {
    background: rgba(255, 255, 255, .21);
  }
  :host([data-pos="header"]) .fab.in { animation: fadein .2s var(--ease); }
  :host([data-pos="header"]) .fab:hover { background: var(--hover); transform: none; }
  :host([data-pos="header"]) .fab:active { background: var(--track); transform: none; }
  :host([data-pos="header"]) .fab::after { content: none; }
  :host([data-pos="header"]) .fab.open {
    background: var(--hover); color: var(--fg); border-color: transparent; box-shadow: none;
  }
  @keyframes fadein { from { opacity: 0; } }

  .panel {
    position: fixed; right: var(--fab-right, 20px); bottom: calc(var(--fab-bottom, 88px) + 56px); z-index: 41;
    width: 304px; padding: 16px; border-radius: 20px;
    color: var(--fg); border: 1px solid var(--border);
    background: var(--glass);
    -webkit-backdrop-filter: blur(24px) saturate(180%);
    backdrop-filter: blur(24px) saturate(180%);
    box-shadow: inset 0 1px 0 var(--edge), var(--shadow);
    font-size: 13px; line-height: 1.5;
    display: none; overflow-y: auto;
    max-height: min(72vh, calc(100vh - var(--fab-bottom, 88px) - 72px));
    max-width: calc(100vw - 32px);
    transform-origin: 100% 100%;
    transition: left .25s var(--ease), right .25s var(--ease), bottom .25s var(--ease);
    pointer-events: auto;
  }
  .panel.open { display: block; animation: rise .22s var(--ease); }
  @keyframes rise { from { opacity: 0; transform: translateY(10px) scale(.97); } }
  /* composer 模式优先从按钮向右上展开；右侧空间不足时贴视口右缘，少盖住输入区。 */
  :host([data-pos="composer"]) .panel {
    left: var(--panel-left, 16px); right: auto;
    width: min(304px, calc(100vw - var(--panel-left, 16px) - 16px));
    transform-origin: 50% 100%;
  }
  :host([data-pos="composer"]) .adv .row { flex-wrap: wrap; }
  /* header 模式：面板从按钮下方展开 */
  :host([data-pos="header"]) .panel {
    bottom: auto; top: var(--panel-top, 56px);
    /* 宽动作组会把按钮推向左侧；304px 面板仍需保留两侧至少 16px 的视口边距。 */
    right: clamp(16px, var(--fab-right, 20px), calc(100vw - 304px - 16px));
    max-height: min(72vh, calc(100vh - var(--panel-top, 56px) - 24px));
    transform-origin: 100% 0;
    transition: none;
  }
  :host([data-pos="header"]) .panel.open { animation-name: drop; }
  @keyframes drop { from { opacity: 0; transform: translateY(-10px) scale(.97); } }
  .head { font-size: 14px; font-weight: 600; letter-spacing: -.01em; }

  .sec {
    font-size: 10px; font-weight: 500; color: var(--muted);
    text-transform: uppercase; letter-spacing: .07em; margin: 14px 0 6px;
  }

  .seg { display: flex; gap: 2px; padding: 3px; border-radius: 11px; background: var(--track); }
  .seg button {
    flex: 1; padding: 6px 0; border: none; border-radius: 8px;
    background: transparent; color: var(--muted); font-size: 12px; font-weight: 500;
    transition: color .15s var(--ease), background .15s var(--ease);
  }
  .seg button:hover:not(:disabled):not(.on) { color: var(--fg); }
  .seg button.on {
    background: var(--thumb); color: var(--fg);
    box-shadow: inset 0 1px 0 var(--edge), 0 1px 5px rgba(0, 0, 0, .16);
  }
  .seg button:disabled { cursor: default; opacity: .5; }

  .picker { display: none; margin-top: 8px; }
  .picker.open { display: block; }
  .picker .srcrow { display: flex; gap: 4px; margin-bottom: 6px; }
  .picker select.src {
    flex-shrink: 0; max-width: 108px; padding: 6px 7px; border: 1px solid var(--border);
    border-radius: 8px; font-size: 12px; background: transparent; color: var(--fg);
    outline: none; cursor: pointer; transition: border-color .15s var(--ease);
  }
  .picker select.src:focus { border-color: var(--accent); }
  .picker select.src option { background: Canvas; color: CanvasText; }
  .picker input[type="search"] {
    flex: 1; min-width: 0; padding: 6px 9px; border: 1px solid var(--border); border-radius: 8px;
    font-size: 12px; background: transparent; color: var(--fg); outline: none;
    transition: border-color .15s var(--ease);
  }
  .picker input[type="search"]::placeholder { color: var(--muted); }
  .picker input[type="search"]:focus { border-color: var(--accent); }
  .picker .tools { display: flex; gap: 4px; margin-bottom: 6px; }
  .picker .tools button {
    padding: 4px 9px; border-radius: 7px; border: 1px solid var(--border);
    background: transparent; font-size: 11px;
    transition: background .15s var(--ease);
  }
  .picker .tools button:hover:not(:disabled) { background: var(--hover); }
  .picker .tools button:disabled { cursor: default; opacity: .5; }
  .picker .list { max-height: 200px; overflow-y: auto; border: 1px solid var(--border); border-radius: 8px; }
  .picker .row { display: flex; align-items: center; gap: 7px; padding: 5px 9px; cursor: pointer; font-size: 12px; }
  .picker .row:hover { background: var(--hover); }
  .picker .row.hidden { display: none; }
  .picker .row .t { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .picker .row .p {
    flex-shrink: 0; max-width: 84px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--muted); font-size: 10px; padding: 1px 5px; border-radius: 999px; border: 1px solid var(--border);
  }
  .picker .row .d { color: var(--muted); font-size: 10px; flex-shrink: 0; font-variant-numeric: tabular-nums; }
  .picker .sentinel { padding: 7px 0; text-align: center; color: var(--muted); font-size: 11px; }
  .picker .sentinel:empty { padding: 0; }
  .picker .empty { display: none; padding: 14px 0; text-align: center; color: var(--muted); font-size: 12px; }
  .picker .empty.visible { display: block; }
  .picker .count { color: var(--muted); font-size: 11px; margin-top: 5px; font-variant-numeric: tabular-nums; }

  .adv-toggle {
    display: flex; align-items: center; gap: 4px; margin-top: 14px; padding: 0;
    border: none; background: none; color: var(--muted);
    font-size: 10px; font-weight: 500; text-transform: uppercase; letter-spacing: .07em;
    transition: color .15s var(--ease);
  }
  .adv-toggle:hover { color: var(--fg); }
  .adv-toggle svg { transition: transform .18s var(--ease); }
  .adv-toggle.open svg { transform: rotate(90deg); }
  .adv { display: none; margin-top: 6px; padding: 4px 12px 10px; border: 1px solid var(--border); border-radius: 10px; }
  .adv.open { display: block; }
  .adv .row {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 6px 0; cursor: pointer;
    transition: opacity .15s var(--ease);
  }
  .adv .row.dis { opacity: .4; pointer-events: none; }
  .adv input[type="number"] {
    width: 56px; padding: 2px 6px; border: 1px solid var(--border); border-radius: 6px;
    font-size: 12px; background: transparent; color: var(--fg);
    text-align: right; font-variant-numeric: tabular-nums; outline: none;
    transition: border-color .15s var(--ease);
  }
  .adv input[type="number"]:focus { border-color: var(--accent); }
  .adv input[type="text"] {
    width: 118px; padding: 2px 6px; border: 1px solid var(--border); border-radius: 6px;
    font-size: 12px; background: transparent; color: var(--fg); outline: none;
    transition: border-color .15s var(--ease);
  }
  .adv input[type="text"]:focus { border-color: var(--accent); }
  .adv input[type="text"]::placeholder { color: var(--muted); }
  .adv select {
    padding: 2px 6px; border: 1px solid var(--border); border-radius: 6px;
    font-size: 12px; background: var(--solid); color: var(--fg); outline: none;
    transition: border-color .15s var(--ease);
  }
  .adv select:focus { border-color: var(--accent); }
  .reset {
    margin-top: 4px; padding: 0; border: none; background: none; color: var(--muted);
    font-size: 11px; text-decoration: underline; text-underline-offset: 2px;
    transition: color .15s var(--ease);
  }
  .reset:hover { color: var(--fg); }

  .go {
    margin-top: 14px; width: 100%; padding: 9px; border-radius: 12px; border: none;
    position: relative; overflow: hidden;
    background: var(--accent); color: var(--accent-fg);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, .28), var(--cta-glow);
    font-size: 13px; font-weight: 600;
    transition: background .15s var(--ease), transform .1s var(--ease);
  }
  .go::after {
    content: ""; position: absolute; inset: 0; pointer-events: none;
    background: linear-gradient(115deg, transparent 35%, rgba(255, 255, 255, .3) 50%, transparent 65%);
    transform: translateX(-130%);
  }
  .go:hover:not(:disabled) { background: var(--accent-hover); }
  .go:hover:not(:disabled)::after { transform: translateX(130%); transition: transform .6s ease; }
  .go:active:not(:disabled) { transform: scale(.98); }
  .go:disabled { opacity: .45; cursor: default; box-shadow: none; }

  .status {
    min-height: 18px; margin-top: 10px; color: var(--muted); font-size: 12px;
    word-break: break-all; font-variant-numeric: tabular-nums;
  }
  progress { width: 100%; height: 4px; margin-top: 6px; display: none; accent-color: var(--accent); }
  progress.visible { display: block; }
  .cancel {
    display: none; margin-top: 8px; width: 100%; padding: 6px; border-radius: 10px;
    border: 1px solid var(--border); background: transparent; color: var(--danger); font-size: 12px;
    transition: background .15s var(--ease);
  }
  .cancel:hover:not(:disabled) { background: var(--hover); }
  .cancel.visible { display: block; }

  /* 玻璃降级：不支持 backdrop-filter 或用户偏好降低透明度时改用实色 */
  @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
    .fab, .panel { background: var(--solid); }
  }
  @media (prefers-reduced-transparency: reduce) {
    .fab, .panel, :host([data-pos="header"]) .fab {
      background: var(--solid);
      -webkit-backdrop-filter: none; backdrop-filter: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    * { animation: none !important; transition: none !important; }
  }
`;
	var ICON_DOWNLOAD = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>`;
	var ICON_ARROW_DOWN = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>`;
	var ICON_CHEVRON = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>`;
	var ICON_RELOAD = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/></svg>`;
	function mountPanel(cb) {
		if (document.querySelector("[data-inkstone]")) return;
		const host = document.createElement("div");
		host.dataset["inkstone"] = "";
		host.dataset["site"] = cb.site.id;
		if (cb.site.id === "chatgpt") for (const [name, value] of [
			["position", "fixed"],
			["left", "0"],
			["top", "0"],
			["width", "0"],
			["height", "0"],
			["display", "block"],
			["overflow", "visible"],
			["visibility", "visible"],
			["opacity", "1"],
			["pointer-events", "none"],
			["z-index", "2147483647"],
			["isolation", "isolate"],
			["transform", "none"]
		]) host.style.setProperty(name, value, "important");
		const root = host.attachShadow({ mode: "open" });
		let probe = null;
		const parseColor = (raw) => {
			const s = raw.trim();
			if (!s) return null;
			const t = /^(\d{1,3})[ ,]+(\d{1,3})[ ,]+(\d{1,3})$/.exec(s);
			if (t) return [
				Math.min(255, Number(t[1])),
				Math.min(255, Number(t[2])),
				Math.min(255, Number(t[3]))
			];
			if (!CSS.supports("color", s)) return null;
			if (!probe) {
				probe = document.createElement("span");
				probe.style.display = "none";
			}
			if (!probe.isConnected) document.body.append(probe);
			probe.style.color = s;
			const c = getComputedStyle(probe).color;
			const m = /^rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\)/.exec(c);
			if (m) {
				if (m[4] !== void 0 && Number(m[4]) < .9) return null;
				return [
					Number(m[1]),
					Number(m[2]),
					Number(m[3])
				];
			}
			const p = /^color\((?:srgb|display-p3)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/.exec(c);
			if (p) {
				if (p[4] !== void 0 && Number(p[4]) < .9) return null;
				return [
					Math.round(Number(p[1]) * 255),
					Math.round(Number(p[2]) * 255),
					Math.round(Number(p[3]) * 255)
				];
			}
			return null;
		};
		let accentApplied = "";
		const applyAccent = (bg, fgIn, ringIn) => {
			const [r, g, b] = bg;
			const ring = ringIn ?? bg;
			const key = `${r},${g},${b}|${fgIn?.join() ?? ""}|${ring.join()}`;
			if (key === accentApplied) return;
			accentApplied = key;
			const lin = (c) => {
				const s = c / 255;
				return s <= .03928 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4;
			};
			const L = .2126 * lin(r) + .7152 * lin(g) + .0722 * lin(b);
			const fg = fgIn ?? (1.05 / (L + .05) >= 4.5 ? [
				255,
				255,
				255
			] : [
				13,
				13,
				13
			]);
			const toward = L < .5 ? 255 : 0;
			const hov = bg.map((c) => Math.round(c + (toward - c) * .12));
			host.style.setProperty("--accent", `rgb(${r} ${g} ${b})`);
			host.style.setProperty("--accent-hover", `rgb(${hov[0]} ${hov[1]} ${hov[2]})`);
			host.style.setProperty("--accent-fg", `rgb(${fg[0]} ${fg[1]} ${fg[2]})`);
			host.style.setProperty("--ring", `rgb(${ring[0]} ${ring[1]} ${ring[2]})`);
			host.style.setProperty("--cta-glow", `0 5px 18px rgba(${r}, ${g}, ${b}, .3)`);
		};
		let accentScanTick = 0;
		const detectAccent = (force = false) => {
			const rootEl = document.documentElement;
			const hit = cb.siteUi.accent(parseColor);
			if (hit) {
				applyAccent(hit.bg, hit.fg, hit.ring);
				return;
			}
			if (!force && accentScanTick++ % 15 !== 0) return;
			let best = null;
			let bestSat = 24;
			for (const el of [rootEl, document.body]) {
				const map = el.computedStyleMap?.();
				if (!map) continue;
				for (const [name, values] of map) {
					if (!name.startsWith("--") || !name.toLowerCase().includes("accent")) continue;
					const rgb = parseColor(String(Array.isArray(values) ? values[0] ?? "" : values));
					if (!rgb) continue;
					const sat = Math.max(...rgb) - Math.min(...rgb);
					if (sat > bestSat) {
						bestSat = sat;
						best = rgb;
					}
				}
			}
			if (best) applyAccent(best, null, null);
		};
		const syncTheme = (forceAccent = true) => {
			const nextTheme = cb.siteUi.isDark() ? "dark" : "light";
			const changed = host.dataset["theme"] !== nextTheme;
			host.dataset["theme"] = nextTheme;
			detectAccent(forceAccent || changed);
		};
		syncTheme();
		new MutationObserver(() => syncTheme(true)).observe(document.documentElement, {
			attributes: true,
			attributeFilter: cb.siteUi.themeAttributes
		});
		const style = document.createElement("style");
		style.textContent = STYLE;
		root.append(style);
		const fab = document.createElement("button");
		fab.className = "fab";
		fab.title = `Inkstone — 导出 ${cb.site.label} 对话`;
		fab.setAttribute("aria-label", `Inkstone — 导出 ${cb.site.label} 对话`);
		fab.setAttribute("aria-haspopup", "dialog");
		fab.setAttribute("aria-expanded", "false");
		fab.innerHTML = `<span class="ic ic-dl">${ICON_DOWNLOAD}</span><span class="ic ic-arrow">${ICON_ARROW_DOWN}</span>`;
		const panel = document.createElement("div");
		panel.className = "panel";
		panel.setAttribute("role", "dialog");
		panel.setAttribute("aria-label", "导出对话");
		const batchAttr = cb.site.supportsBatch ? "" : " hidden";
		const sourceAttr = cb.site.supportsSources ? "" : " hidden";
		panel.innerHTML = `
    <div class="head">导出 ${cb.site.label} 对话</div>

    <div class="sec">范围</div>
    <div class="seg" data-seg="scope">
      <button data-v="current" class="on" aria-pressed="true">当前对话</button>
      <button data-v="all" aria-pressed="false"${batchAttr}>全部</button>
      <button data-v="selection" aria-pressed="false"${batchAttr}>选择…</button>
    </div>
    <div class="picker">
      <div class="srcrow">
        <select class="src" aria-label="列表来源"${sourceAttr}>
          <option value="all">全部</option>
          <option value="main">主列表</option>
        </select>
        <input type="search" placeholder="搜索标题过滤…" aria-label="搜索标题过滤">
      </div>
      <div class="tools">
        <button data-sel="all">全选</button>
        <button data-sel="invert">反选</button>
        <button data-sel="none">清空</button>
        <button data-sel="reload" title="重新拉取列表" aria-label="重新拉取列表">${ICON_RELOAD}</button>
      </div>
      <div class="list"><div class="sentinel"></div></div>
      <div class="empty">没有匹配的对话</div>
      <div class="count">已选 0 条</div>
    </div>

    <div class="sec">格式</div>
    <div class="seg" data-seg="format">
      <button data-v="markdown" class="on" aria-pressed="true">Markdown</button>
      <button data-v="json" aria-pressed="false">JSON</button>
    </div>

    <div class="sec">输出到</div>
    <div class="seg" data-seg="target">
      <button data-v="zip" class="on" aria-pressed="true">下载 zip</button>
      <button data-v="folder" aria-pressed="false">直写文件夹</button>
    </div>

    <button class="adv-toggle" aria-expanded="false">${ICON_CHEVRON} 高级设置</button>
    <div class="adv">
      <label class="row" data-row="fabPos"><span>按钮位置</span><select data-opt="fabPos">
        <option value="composer">输入框旁</option>
        <option value="header">顶部 Share 左侧</option>
      </select></label>
      <label class="row" data-row="incremental"><span>增量：跳过未变化的对话</span><input type="checkbox" data-opt="incremental" checked></label>
      <label class="row" data-row="assets"><span>下载附件（图片始终下载）</span><input type="checkbox" data-opt="assets" checked></label>
      <label class="row" data-row="thoughts"><span>写入思考过程</span><input type="checkbox" data-opt="thoughts"></label>
      <label class="row" data-row="toolTraces"><span>写入工具过程（代码执行/搜索）</span><input type="checkbox" data-opt="toolTraces"></label>
      <label class="row" data-row="maxFileMB"><span>文件附件上限（MB）</span><input type="number" data-opt="maxFileMB" min="1" max="500" step="1" value="2"></label>
      <label class="row" data-row="linkStyle"><span>附件链接风格</span><select data-opt="linkStyle">
        <option value="wikilink">Wikilink</option>
        <option value="markdown">标准 Markdown</option>
      </select></label>
      <label class="row" data-row="headingMode"><span>消息内标题</span><select data-opt="headingMode">
        <option value="demote">整体降一级</option>
        <option value="strip">剥离为加粗行</option>
      </select></label>
      <label class="row" data-row="notesDir"><span>笔记子文件夹</span><input type="text" data-opt="notesDir" placeholder="留空 = 根目录"></label>
      <label class="row" data-row="attachmentsDir"><span>附件子文件夹（相对笔记）</span><input type="text" data-opt="attachmentsDir" placeholder="留空 = 与笔记同层"></label>
      <button class="reset">重置增量记录（下次全量导出）</button>
      <button class="reset" data-act="forget-folder" hidden>重新选择写入文件夹</button>
    </div>

    <button class="go">导出当前对话</button>
    <div class="status" role="status" aria-live="polite">就绪</div>
    <progress max="1" value="0"></progress>
    <button class="cancel">取消</button>
  `;
		root.append(fab, panel);
		for (const type of [
			"pointerdown",
			"mousedown",
			"mouseup",
			"click",
			"dblclick",
			"focusin",
			"focusout",
			"keydown",
			"keypress",
			"keyup",
			"beforeinput",
			"input",
			"change",
			"paste"
		]) panel.addEventListener(type, (event) => event.stopPropagation());
		let mode = cb.settings.values.fabPos;
		host.dataset["pos"] = mode;
		const headerFabSize = cb.site.id === "claude" ? 28 : 36;
		host.style.setProperty("--header-fab-size", `${headerFabSize}px`);
		const fabSize = () => mode === "header" ? headerFabSize : 44;
		const fabGap = () => mode === "header" ? 8 : 12;
		let curRight = -1;
		let curBottom = -1;
		let curPanelTop = -1;
		let curPanelLeft = -1;
		const findAnchor = () => {
			if (mode === "header") return cb.siteUi.headerAnchor();
			const element = cb.siteUi.composerAnchor();
			return element ? {
				element,
				placement: "beside"
			} : null;
		};
		let anchor = null;
		let headerPlacement = "beside";
		const syncPos = () => {
			if (!anchor?.isConnected) return false;
			const r = anchor.getBoundingClientRect();
			const placement = computeFabPlacement(mode, r, {
				width: window.innerWidth,
				height: window.innerHeight
			}, fabSize(), fabGap(), headerPlacement);
			if (!placement) return false;
			if (placement.panelTop != null && placement.panelTop !== curPanelTop) {
				curPanelTop = placement.panelTop;
				host.style.setProperty("--panel-top", `${placement.panelTop}px`);
			}
			if (placement.panelLeft != null && placement.panelLeft !== curPanelLeft) {
				curPanelLeft = placement.panelLeft;
				host.style.setProperty("--panel-left", `${placement.panelLeft}px`);
			}
			if (placement.right !== curRight) {
				curRight = placement.right;
				host.style.setProperty("--fab-right", `${placement.right}px`);
			}
			if (placement.bottom !== curBottom) {
				curBottom = placement.bottom;
				host.style.setProperty("--fab-bottom", `${placement.bottom}px`);
			}
			return true;
		};
		const closePanel = () => {
			panel.classList.remove("open");
			fab.classList.remove("open");
			fab.setAttribute("aria-expanded", "false");
		};
		const hideFab = () => {
			fab.classList.remove("in");
			closePanel();
		};
		const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => rebindAnchor());
		let anchorMissingSince = null;
		const rebindAnchor = () => {
			const target = findAnchor();
			const c = target?.element ?? null;
			const placement = target?.placement ?? "beside";
			if (c !== anchor || placement !== headerPlacement) {
				if (anchor) closePanel();
				ro?.disconnect();
				anchor = c;
				headerPlacement = placement;
				if (c) ro?.observe(c);
			}
			if (anchor?.isConnected) {
				anchorMissingSince = null;
				return syncPos();
			} else {
				anchorMissingSince ??= Date.now();
				if (Date.now() - anchorMissingSince >= 4e3) hideFab();
			}
			return false;
		};
		let bootDone = false;
		let bootTries = 0;
		let bootKey = "";
		let bootStable = 0;
		const boot = () => {
			const positioned = rebindAnchor();
			const key = `${curRight},${curBottom}`;
			bootStable = positioned && key === bootKey ? bootStable + 1 : positioned ? 1 : 0;
			bootKey = key;
			if (bootStable >= 2) {
				bootDone = true;
				detectAccent(true);
				fab.classList.add("in");
				return;
			}
			if (++bootTries < 120) setTimeout(boot, 250);
			else bootDone = true;
		};
		boot();
		window.addEventListener("resize", rebindAnchor, { passive: true });
		let tick = 0;
		let pageHref = location.href;
		setInterval(() => {
			if (location.href !== pageHref) {
				pageHref = location.href;
				closePanel();
			}
			if (++tick % 4 === 0) {
				const positioned = rebindAnchor();
				if (bootDone && positioned && !fab.classList.contains("in")) {
					detectAccent(true);
					fab.classList.add("in");
				}
				syncTheme(false);
			} else syncPos();
		}, 500);
		const $ = (sel) => panel.querySelector(sel);
		const statusEl = $(".status");
		const progressEl = $("progress");
		const cancelEl = $(".cancel");
		const goEl = $(".go");
		const advToggle = $(".adv-toggle");
		const advEl = $(".adv");
		const pickerEl = $(".picker");
		const pickerList = pickerEl.querySelector(".list");
		const sentinel = pickerList.querySelector(".sentinel");
		const pickerSearch = pickerEl.querySelector("input[type=\"search\"]");
		const pickerSrc = pickerEl.querySelector("select.src");
		const pickerEmpty = pickerEl.querySelector(".empty");
		const pickerCount = pickerEl.querySelector(".count");
		const segButtons = [...panel.querySelectorAll(".seg button")];
		const toolButtons = [...pickerEl.querySelectorAll(".tools button")];
		const forgetFolderEl = panel.querySelector("[data-act=\"forget-folder\"]");
		let scope = "current";
		let format = "markdown";
		let target = cb.settings.supportsFolder ? cb.settings.values.target : "zip";
		let listLoaded = false;
		let listDone = false;
		let listLoading = false;
		let running = false;
		const optOf = (name) => panel.querySelector(`input[data-opt="${name}"]`).checked;
		const maxFileEl = panel.querySelector("input[data-opt=\"maxFileMB\"]");
		maxFileEl.value = String(cb.settings.values.maxFileMB);
		const readMaxFileMB = () => {
			const v = Number(maxFileEl.value);
			return Number.isFinite(v) && v >= 1 ? Math.min(v, 500) : 2;
		};
		maxFileEl.addEventListener("change", () => cb.settings.onSettingsChange({ maxFileMB: readMaxFileMB() }));
		const fabPosEl = panel.querySelector("select[data-opt=\"fabPos\"]");
		fabPosEl.value = mode;
		fabPosEl.addEventListener("change", () => {
			mode = fabPosEl.value === "header" ? "header" : "composer";
			closePanel();
			fab.classList.remove("in");
			ro?.disconnect();
			anchor = null;
			curRight = -1;
			curBottom = -1;
			curPanelTop = -1;
			curPanelLeft = -1;
			host.style.removeProperty("--fab-right");
			host.style.removeProperty("--fab-bottom");
			host.style.removeProperty("--panel-top");
			host.style.removeProperty("--panel-left");
			host.dataset["pos"] = mode;
			cb.settings.onSettingsChange({ fabPos: mode });
			if (rebindAnchor()) fab.classList.add("in");
		});
		const linkStyleEl = panel.querySelector("select[data-opt=\"linkStyle\"]");
		const headingModeEl = panel.querySelector("select[data-opt=\"headingMode\"]");
		linkStyleEl.value = cb.settings.values.linkStyle;
		headingModeEl.value = cb.settings.values.headingMode;
		linkStyleEl.addEventListener("change", () => cb.settings.onSettingsChange({ linkStyle: linkStyleEl.value === "markdown" ? "markdown" : "wikilink" }));
		headingModeEl.addEventListener("change", () => cb.settings.onSettingsChange({ headingMode: headingModeEl.value === "strip" ? "strip" : "demote" }));
		const notesDirEl = panel.querySelector("input[data-opt=\"notesDir\"]");
		const attachmentsDirEl = panel.querySelector("input[data-opt=\"attachmentsDir\"]");
		notesDirEl.value = cb.settings.values.notesDir;
		attachmentsDirEl.value = cb.settings.values.attachmentsDir;
		notesDirEl.addEventListener("change", () => {
			notesDirEl.value = sanitizeSubdir(notesDirEl.value);
			cb.settings.onSettingsChange({ notesDir: notesDirEl.value });
		});
		attachmentsDirEl.addEventListener("change", () => {
			attachmentsDirEl.value = sanitizeSubdir(attachmentsDirEl.value);
			cb.settings.onSettingsChange({ attachmentsDir: attachmentsDirEl.value });
		});
		const folderBtn = panel.querySelector("[data-seg=\"target\"] button[data-v=\"folder\"]");
		if (!cb.settings.supportsFolder) {
			folderBtn.disabled = true;
			folderBtn.title = "需要 Chrome / Edge（File System Access API）";
		}
		if (target === "folder") for (const b of panel.querySelectorAll("[data-seg=\"target\"] button")) {
			const on = b.dataset["v"] === "folder";
			b.classList.toggle("on", on);
			b.setAttribute("aria-pressed", String(on));
		}
		const readOpts = () => ({
			incremental: optOf("incremental"),
			assets: optOf("assets"),
			thoughts: optOf("thoughts"),
			toolTraces: optOf("toolTraces"),
			maxFileMB: readMaxFileMB(),
			linkStyle: linkStyleEl.value === "markdown" ? "markdown" : "wikilink",
			headingMode: headingModeEl.value === "strip" ? "strip" : "demote",
			target,
			notesDir: sanitizeSubdir(notesDirEl.value),
			attachmentsDir: sanitizeSubdir(attachmentsDirEl.value)
		});
		const rows = () => [...pickerList.querySelectorAll(".row")];
		const boxOf = (row) => row.querySelector("input");
		const visibleRows = () => rows().filter((r) => !r.classList.contains("hidden"));
		const selectedIds = () => rows().map(boxOf).filter((b) => b.checked).map((b) => b.dataset["id"]);
		function applySearchFilter() {
			const q = pickerSearch.value.trim().toLowerCase();
			for (const row of rows()) row.classList.toggle("hidden", q !== "" && !row.title.toLowerCase().includes(q));
		}
		function refresh() {
			pickerEl.classList.toggle("open", scope === "selection");
			pickerEmpty.classList.toggle("visible", listLoaded && listDone && visibleRows().length === 0);
			advEl.querySelector("[data-row=\"incremental\"]").classList.toggle("dis", scope !== "all");
			for (const name of [
				"assets",
				"thoughts",
				"toolTraces",
				"maxFileMB",
				"linkStyle",
				"headingMode",
				"notesDir",
				"attachmentsDir"
			]) advEl.querySelector(`[data-row="${name}"]`).classList.toggle("dis", format === "json");
			forgetFolderEl.hidden = target !== "folder";
			const n = selectedIds().length;
			const loaded = rows().length;
			pickerCount.textContent = listDone ? `已选 ${n} / 共 ${loaded} 条` : `已选 ${n} 条 · 已加载 ${loaded} 条（下拉加载更多）`;
			goEl.textContent = scope === "current" ? "导出当前对话" : scope === "all" ? "导出全部对话" : `导出所选（${n} 条）`;
			goEl.disabled = running || scope === "selection" && n === 0;
		}
		function setRunning(r) {
			running = r;
			for (const b of [...segButtons, ...toolButtons]) b.disabled = r;
			cancelEl.classList.toggle("visible", r);
			if (!r) {
				cancelEl.disabled = false;
				progressEl.classList.remove("visible");
				progressEl.value = 0;
				if (listLoaded && !listDone && !listLoading) {
					sentinel.textContent = "下拉加载更多";
					maybeAutoFill();
				}
			}
			refresh();
		}
		const handle = {
			setStatus: (text) => {
				statusEl.textContent = text;
			},
			setProgress: (done, total) => {
				progressEl.classList.add("visible");
				progressEl.max = Math.max(1, total);
				progressEl.value = done;
			},
			finish: () => setRunning(false),
			appendPicker: (items, done) => {
				for (const item of items) {
					const row = document.createElement("label");
					row.className = "row";
					row.title = item.project ? `${item.title}（${item.project}）` : item.title;
					const box = document.createElement("input");
					box.type = "checkbox";
					box.dataset["id"] = item.id;
					const t = document.createElement("span");
					t.className = "t";
					t.textContent = item.title || "(无标题)";
					const d = document.createElement("span");
					d.className = "d";
					d.textContent = item.updated;
					if (item.project) {
						const p = document.createElement("span");
						p.className = "p";
						p.textContent = item.project;
						row.append(box, t, p, d);
					} else row.append(box, t, d);
					sentinel.before(row);
				}
				listLoaded = true;
				listLoading = false;
				listDone = done;
				applySearchFilter();
				sentinel.textContent = done ? "" : "下拉加载更多";
				refresh();
				if (!done) queueMicrotask(maybeAutoFill);
			},
			setPickerProjects: (projects) => {
				const keep = pickerSrc.value;
				while (pickerSrc.options.length > 2) pickerSrc.remove(2);
				for (const project of projects) {
					const option = document.createElement("option");
					option.value = project.id;
					option.textContent = project.name;
					pickerSrc.add(option);
				}
				pickerSrc.value = [...pickerSrc.options].some((option) => option.value === keep) ? keep : "all";
			},
			clearPicker: () => {
				for (const r of rows()) r.remove();
				listLoaded = false;
				listDone = false;
				listLoading = false;
				sentinel.textContent = "";
				refresh();
			},
			pickerLoadFailed: () => {
				listLoading = false;
				sentinel.textContent = "加载失败，点此重试";
			}
		};
		function requestMore() {
			if (listLoading || listDone || running) return;
			if (!listLoaded) {
				loadList();
				return;
			}
			listLoading = true;
			sentinel.textContent = "加载中…";
			cb.onPickMore(handle);
		}
		function maybeAutoFill() {
			const h = pickerList.clientHeight;
			if (h > 0 && pickerList.scrollHeight <= h + 8) requestMore();
		}
		new IntersectionObserver((entries) => {
			if (entries.some((e) => e.isIntersecting)) requestMore();
		}, {
			root: pickerList,
			rootMargin: "80px"
		}).observe(sentinel);
		sentinel.addEventListener("click", requestMore);
		function loadList() {
			handle.clearPicker();
			pickerSearch.value = "";
			listLoading = true;
			sentinel.textContent = "加载中…";
			cb.onPickList(handle, pickerSrc.value);
		}
		pickerSrc.addEventListener("change", loadList);
		for (const btn of segButtons) btn.addEventListener("click", () => {
			const group = btn.parentElement.dataset["seg"];
			for (const b of btn.parentElement.querySelectorAll("button")) {
				b.classList.toggle("on", b === btn);
				b.setAttribute("aria-pressed", String(b === btn));
			}
			if (group === "scope") {
				scope = btn.dataset["v"];
				if (scope === "selection" && !listLoaded) loadList();
			} else if (group === "target") {
				target = btn.dataset["v"];
				cb.settings.onSettingsChange({ target });
			} else format = btn.dataset["v"];
			refresh();
		});
		pickerSearch.addEventListener("input", () => {
			applySearchFilter();
			refresh();
			maybeAutoFill();
		});
		pickerList.addEventListener("change", refresh);
		pickerEl.querySelector("[data-sel=\"all\"]").addEventListener("click", () => {
			for (const r of visibleRows()) boxOf(r).checked = true;
			refresh();
		});
		pickerEl.querySelector("[data-sel=\"invert\"]").addEventListener("click", () => {
			for (const r of visibleRows()) boxOf(r).checked = !boxOf(r).checked;
			refresh();
		});
		pickerEl.querySelector("[data-sel=\"none\"]").addEventListener("click", () => {
			for (const r of rows()) boxOf(r).checked = false;
			refresh();
		});
		pickerEl.querySelector("[data-sel=\"reload\"]").addEventListener("click", loadList);
		advToggle.addEventListener("click", () => {
			const open = advToggle.classList.toggle("open");
			advEl.classList.toggle("open", open);
			advToggle.setAttribute("aria-expanded", String(open));
		});
		fab.addEventListener("click", () => {
			const open = panel.classList.toggle("open");
			fab.classList.toggle("open", open);
			fab.setAttribute("aria-expanded", String(open));
		});
		cancelEl.addEventListener("click", () => {
			cancelEl.disabled = true;
			cb.onCancel();
		});
		$(".reset").addEventListener("click", () => {
			cb.onResetWatermark();
			statusEl.textContent = "增量记录已清除，下次导出为全量";
		});
		forgetFolderEl.addEventListener("click", () => {
			cb.onForgetFolder();
			statusEl.textContent = "已忘记写入文件夹，下次导出重新选择";
		});
		goEl.addEventListener("click", () => {
			const ids = scope === "selection" ? selectedIds() : [];
			if (scope === "selection" && ids.length === 0) return;
			setRunning(true);
			cb.onExport(scope, format, ids, handle, readOpts());
		});
		refresh();
		document.body.append(host);
	}
	var MAX_IMAGE_BYTES = 30 * 1024 * 1024;
	var site;
	var detected = resolveAdapter();
	var activeCancel = null;
	var pickedList = [];
	var pickedIds = new Set();
	var pager = null;
	var pagerGen = 0;
	var wmKey = (kind) => `${site.id}:${kind}`;
	if (detected) {
		site = detected;
		mount();
	}
	function mount() {
		mountPanel({
			site: {
				id: site.id,
				label: site.label,
				supportsBatch: site.supportsBatch,
				supportsSources: site.batch?.listSources != null
			},
			siteUi: site.ui,
			onExport(scope, format, ids, panel, opts) {
				dispatchExport(scope, format, ids, panel, opts);
			},
			onPickList(panel, source) {
				loadPickList(panel, source);
			},
			onPickMore(panel) {
				loadNextPage(panel);
			},
			onCancel() {
				if (activeCancel) activeCancel.cancelled = true;
			},
			onResetWatermark() {
				clearWatermarks([wmKey("markdown"), wmKey("json")]);
			},
			onForgetFolder() {
				forgetVaultDir();
			},
			settings: {
				values: loadSettings(),
				supportsFolder: supportsDirectoryPicker(),
				onSettingsChange: (patch) => saveSettings(patch)
			}
		});
	}
	async function dispatchExport(scope, format, ids, panel, opts) {
		if (scope !== "current" && !site.supportsBatch) {
			panel.setStatus(`${site.label} 暂时只支持导出当前对话`);
			panel.finish();
			return;
		}
		let sink = null;
		if (opts.target === "folder") try {
			const dir = await acquireVaultDir();
			if (!dir) {
				panel.setStatus("未选择写入文件夹，已取消");
				panel.finish();
				return;
			}
			sink = folderSink(dir);
		} catch (e) {
			panel.setStatus(`打不开写入文件夹：${String(e)}`);
			panel.finish();
			return;
		}
		if (scope === "current") await exportSingle(format, panel, opts, sink);
		else if (scope === "selection") await exportSelection(ids, format, panel, opts, sink);
		else await startExport(format, panel, opts, sink);
	}
	async function loadPickList(panel, source) {
		const gen = ++pagerGen;
		pager = null;
		pickedList = [];
		pickedIds.clear();
		try {
			panel.setStatus("获取登录态…");
			const session = await site.prepare();
			if (gen !== pagerGen) return;
			pager = site.batch.createPager(session, void 0, source);
			if (site.batch.listSources) site.batch.listSources(session).then((sources) => {
				if (gen === pagerGen) panel.setPickerProjects(sources);
			}).catch(() => {});
			panel.setStatus("拉取对话列表…");
			await loadNextPage(panel, gen);
		} catch (e) {
			if (gen !== pagerGen) return;
			panel.setStatus(e instanceof CancelledError ? "已取消" : `出错：${String(e)}`);
			panel.pickerLoadFailed();
		}
	}
	async function loadNextPage(panel, gen = pagerGen) {
		if (!pager || gen !== pagerGen) return;
		const current = pager;
		try {
			const { items, done } = await current.next();
			if (gen !== pagerGen) return;
			const fresh = items.filter((i) => !pickedIds.has(i.id));
			for (const i of fresh) pickedIds.add(i.id);
			pickedList.push(...fresh);
			const picked = fresh.map((i) => ({
				id: i.id,
				title: i.title,
				updated: shortDate(i.update_time),
				project: i.project
			}));
			panel.appendPicker(picked, done);
			panel.setStatus(done ? `共 ${pickedList.length} 条，勾选后点「导出所选」` : `已加载 ${pickedList.length} 条，下拉继续加载`);
		} catch (e) {
			if (gen !== pagerGen) return;
			panel.setStatus(e instanceof CancelledError ? "已取消" : `拉取列表出错：${String(e)}`);
			panel.pickerLoadFailed();
		}
	}
	async function exportSelection(ids, format, panel, opts, sink) {
		const cancel = { cancelled: false };
		activeCancel = cancel;
		try {
			const wanted = new Set(ids);
			const items = pickedList.filter((i) => wanted.has(i.id));
			if (items.length === 0) {
				panel.setStatus("所选对话已不在列表缓存里，请重新拉取列表");
				return;
			}
			panel.setStatus("获取登录态…");
			const checkBatchSafety = createBatchSafetyGuard(site.batch.policy, site.throttleStats);
			cancel.beforeRequest = checkBatchSafety;
			const session = await site.prepare(cancel);
			checkBatchSafety();
			await exportItems(format, items, 0, session, cancel, panel, opts, sink, checkBatchSafety);
		} catch (e) {
			panel.setStatus(e instanceof CancelledError ? "已取消" : `出错：${String(e)}`);
		} finally {
			activeCancel = null;
			panel.finish();
		}
	}
	function throttleNote() {
		const s = site.throttleStats();
		if (s.hits429 === 0) return "";
		const parts = [`限流 ${s.hits429} 次`, `间距已放慢到 ${s.spacingMs}ms`];
		if (s.maxRetryAfterSec > 0) parts.push(`服务端最长要求等待 ${s.maxRetryAfterSec}s`);
		return `（${parts.join("，")}）`;
	}
	function shortDate(t) {
		if (t == null) return "";
		const d = typeof t === "number" ? new Date(t * 1e3) : new Date(t);
		return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
	}
	function zipSink() {
		const entries = {};
		return {
			entries,
			put(path, data, opts) {
				entries[path] = opts?.precompressed ? [data, { level: 0 }] : data;
				return Promise.resolve();
			},
			fileCount: () => Object.keys(entries).length,
			async close(panel, zipName) {
				panel.setStatus("打包 zip…");
				downloadBlob(zipName, await makeZip(entries));
				return `已下载 ${zipName}`;
			}
		};
	}
	function folderSink(dir) {
		let n = 0;
		return {
			async put(path, data) {
				await writeVaultFile(dir, path, data);
				n++;
			},
			fileCount: () => n,
			close: () => Promise.resolve(`已写入 ${n} 个文件 → 「${dir.name}」`)
		};
	}
	function createProcessor(kind, session, cancel, panel, opts, sink, checkBatchSafety) {
		const assetCache = new Map();
		const assetAttempts = new Map();
		const maxFileBytes = opts.maxFileMB * 1024 * 1024;
		const notesPrefix = opts.notesDir ? `${opts.notesDir}/` : "";
		const attachPrefix = opts.attachmentsDir ? `${opts.attachmentsDir}/` : "";
		const failedAssetIds = new Set();
		let assetsSkipped = 0;
		let discoveryFailed = 0;
		const resolveIRContext = site.createIRContextResolver?.(session, cancel);
		function resolveAsset(a) {
			const cached = assetCache.get(a.fileId);
			if (cached != null) return Promise.resolve({
				outcome: cached,
				failed: false
			});
			let attempt = assetAttempts.get(a.fileId);
			if (!attempt) {
				attempt = downloadAsset(a);
				assetAttempts.set(a.fileId, attempt);
			}
			return attempt;
		}
		async function downloadAsset(a) {
			let outcome;
			const cap = a.kind === "file" ? maxFileBytes : MAX_IMAGE_BYTES;
			if ((a.sizeBytes ?? 0) > cap) {
				assetsSkipped++;
				outcome = { note: skippedNote(a, a.sizeBytes, cap) };
			} else try {
				checkBatchSafety?.();
				const { bytes, filename, contentType } = await site.fetchAsset(session, a, cancel, cap);
				checkBatchSafety?.();
				const name = assetFileName(a, filename, contentType);
				const linkPath = `${attachPrefix}${a.fileId.slice(-8)}-${name}`;
				await sink.put(`${notesPrefix}${linkPath}`, bytes, { precompressed: true });
				outcome = {
					path: assetReferencePath(opts.linkStyle, notesPrefix, linkPath),
					fileName: name
				};
			} catch (e) {
				if (e instanceof CancelledError) throw e;
				if (e instanceof BatchSafetyError) throw e;
				if (e instanceof SizeLimitError) {
					assetsSkipped++;
					outcome = { note: skippedNote(a, e.actualBytes, cap) };
				} else {
					failedAssetIds.add(a.fileId);
					return {
						outcome: { note: `*(附件下载失败：${a.name ?? a.fileId} — ${String(e)})*` },
						failed: true
					};
				}
			}
			failedAssetIds.delete(a.fileId);
			assetCache.set(a.fileId, outcome);
			return {
				outcome,
				failed: false
			};
		}
		function assetSummary() {
			return (failedAssetIds.size > 0 ? `，附件失败 ${failedAssetIds.size} 个，下次增量导出重试` : "") + (assetsSkipped > 0 ? `，附件超限跳过 ${assetsSkipped} 个` : "") + (discoveryFailed > 0 ? `，${discoveryFailed} 个对话附件发现失败，正文已保留，下次增量导出重试` : "");
		}
		function skippedNote(a, actual, cap) {
			return `*(附件未下载：${a.name ?? a.fileId}，${fmtSize(actual)} 超过 ${fmtSize(cap)} 上限)*`;
		}
		async function processConversation(item) {
			checkBatchSafety?.();
			const raw = await site.fetchRaw(session, item.id, cancel);
			checkBatchSafety?.();
			if (kind === "json") {
				const path = `raw/${item.id}.json`;
				await sink.put(path, strToU8(JSON.stringify(raw, null, 2)));
				return { path };
			}
			const irContext = resolveIRContext ? await resolveIRContext(item.id, raw) : void 0;
			checkBatchSafety?.();
			const ir = site.toIR(raw, item.id, irContext);
			const incompleteReasons = [];
			if (opts.assets && ir.assetDiscoveryFailed) {
				incompleteReasons.push("附件发现失败");
				discoveryFailed++;
			}
			const { markdown, title, assets } = renderConversation(ir, {
				thoughts: opts.thoughts,
				toolTraces: opts.toolTraces,
				headingMode: opts.headingMode
			});
			const replacements = [];
			let assetFailed = false;
			for (const [index, a] of assets.entries()) {
				if (!opts.assets) {
					replacements.push(renderAssetOccurrence(opts.linkStyle, a, { note: `*(附件：${a.name ?? a.fileId} — 本次导出关闭了附件下载)*` }));
					continue;
				}
				if (assets.length > 3 && (index + 1) % 5 === 0) panel.setStatus(`「${(item.title || title).slice(0, 14)}」附件 ${index + 1}/${assets.length}…`);
				const result = await resolveAsset(a);
				assetFailed ||= result.failed;
				replacements.push(renderAssetOccurrence(opts.linkStyle, a, result.outcome));
			}
			const md = fillAssetTokens(markdown, replacements);
			if (assetFailed) incompleteReasons.push("附件下载失败");
			const path = `${notesPrefix}${filenameFor(title, item.id)}`;
			await sink.put(path, strToU8(md));
			return {
				path,
				incompleteReason: incompleteReasons.length > 0 ? `${incompleteReasons.join("、")}：正文已保留，未推进水位线，下次增量导出重试` : void 0
			};
		}
		return {
			processConversation,
			assetSummary,
			beginPass: () => assetAttempts.clear()
		};
	}
	async function exportSingle(format, panel, opts, sink) {
		const cancel = { cancelled: false };
		activeCancel = cancel;
		try {
			const convId = site.currentConversationId();
			if (!convId) {
				panel.setStatus("请先打开要导出的对话");
				return;
			}
			panel.setStatus("获取登录态…");
			const session = await site.prepare(cancel);
			panel.setStatus("抓取当前对话…");
			if (format === "json" && sink == null) {
				const raw = await site.fetchRaw(session, convId, cancel);
				const name = filenameFor(site.toIR(raw, convId).title, convId).replace(/\.md$/, ".json");
				downloadBlob(name, strToU8(JSON.stringify(raw, null, 2)), "application/json");
				panel.setStatus(`完成：${name}`);
				return;
			}
			const zs = sink == null ? zipSink() : null;
			const proc = createProcessor(format, session, cancel, panel, opts, zs ?? sink);
			const { path } = await proc.processConversation({
				id: convId,
				title: "",
				update_time: null
			});
			const baseName = path.split("/").pop();
			if (zs != null) if (Object.keys(zs.entries).some((p) => p !== path)) panel.setStatus(await zs.close(panel, baseName.replace(/\.md$/, ".zip")) + proc.assetSummary() + throttleNote());
			else {
				const entry = zs.entries[path];
				downloadBlob(baseName, entry instanceof Uint8Array ? entry : entry[0], "text/markdown");
				panel.setStatus(`完成：${baseName}${proc.assetSummary()}${throttleNote()}`);
			}
			else panel.setStatus(`完成：${await sink.close(panel, "")}${proc.assetSummary()}${throttleNote()}`);
		} catch (e) {
			panel.setStatus(e instanceof CancelledError ? "已取消" : `出错：${String(e)}`);
		} finally {
			activeCancel = null;
			panel.finish();
		}
	}
	async function startExport(kind, panel, opts, sink) {
		const cancel = { cancelled: false };
		activeCancel = cancel;
		try {
			const checkBatchSafety = createBatchSafetyGuard(site.batch.policy, site.throttleStats);
			cancel.beforeRequest = checkBatchSafety;
			panel.setStatus("获取登录态…");
			const session = await site.prepare(cancel);
			checkBatchSafety();
			panel.setStatus("拉取对话列表…");
			const fullList = await site.batch.listAll(session, (n) => {
				checkBatchSafety();
				panel.setStatus(`拉取对话列表… 已 ${n} 条`);
			}, cancel);
			checkBatchSafety();
			if (fullList.length === 0) {
				panel.setStatus("没有可导出的对话");
				return;
			}
			const list = opts.incremental ? selectChanged(fullList, loadWatermark(wmKey(kind))) : fullList;
			const skipped = fullList.length - list.length;
			if (list.length === 0) {
				panel.setStatus(`没有变化：${fullList.length} 条对话都与上次导出一致`);
				return;
			}
			if (skipped > 0) panel.setStatus(`跳过未变化 ${skipped} 条，导出 ${list.length} 条…`);
			await exportItems(kind, list, skipped, session, cancel, panel, opts, sink, checkBatchSafety);
		} catch (e) {
			panel.setStatus(e instanceof CancelledError ? "已取消" : `出错：${String(e)}`);
		} finally {
			activeCancel = null;
			panel.finish();
		}
	}
	async function exportItems(kind, list, skipped, session, cancel, panel, opts, sinkIn, checkBatchSafetyIn) {
		const sink = sinkIn ?? zipSink();
		const policy = site.batch.policy;
		const checkBatchSafety = checkBatchSafetyIn ?? createBatchSafetyGuard(policy, site.throttleStats);
		cancel.beforeRequest = checkBatchSafety;
		const wmDraft = { ...loadWatermark(wmKey(kind)) };
		const proc = createProcessor(kind, session, cancel, panel, opts, sink, checkBatchSafety);
		let safetyReason = null;
		const incompleteReasons = new Map();
		async function runPass(items, concurrency, label) {
			proc.beginPass();
			const failed = [];
			const untried = [];
			let done = 0;
			let aborted = false;
			await mapConcurrent(items, concurrency, async (item) => {
				if (aborted) {
					untried.push(item);
					done++;
					return;
				}
				try {
					const result = await proc.processConversation(item);
					if (result.incompleteReason) {
						failed.push(item);
						incompleteReasons.set(item.id, result.incompleteReason);
						delete wmDraft[item.id];
						if (failureLimitReached(policy, failed.length, done + 1)) {
							safetyReason = `失败率过高（${failed.length}/${done + 1}），已停止后续请求`;
							aborted = true;
						}
					} else {
						incompleteReasons.delete(item.id);
						wmDraft[item.id] = String(item.update_time ?? "");
					}
				} catch (e) {
					if (e instanceof CancelledError) throw e;
					delete wmDraft[item.id];
					failed.push(item);
					if (e instanceof BatchSafetyError) {
						safetyReason = e.message;
						aborted = true;
					} else {
						try {
							checkBatchSafety();
						} catch (risk) {
							if (risk instanceof BatchSafetyError) {
								safetyReason = risk.message;
								aborted = true;
							} else throw risk;
						}
						const attempted = done + 1;
						if (failureLimitReached(policy, failed.length, attempted)) {
							safetyReason = `失败率过高（${failed.length}/${attempted}），已停止后续请求`;
							aborted = true;
						}
					}
				}
				done++;
				panel.setProgress(done, items.length);
				panel.setStatus(`${label} ${done}/${items.length}${failed.length ? `（失败 ${failed.length}）` : ""}`);
			}, cancel);
			return {
				failed,
				untried,
				aborted
			};
		}
		const pass1 = await runPass(list, policy.concurrency, "抓取对话");
		let failedItems = pass1.failed;
		let untriedItems = pass1.untried;
		let safetyAborted = pass1.aborted;
		if (failedItems.length > 0 && !safetyAborted && policy.retryFailed) {
			let remainingMs = policy.retryDelayMs;
			while (remainingMs > 0) {
				ensureAlive(cancel);
				panel.setStatus(`${failedItems.length} 条失败，${Math.ceil(remainingMs / 1e3)}s 后低速重试…`);
				const waitMs = Math.min(remainingMs, 1e3);
				await sleep(waitMs);
				remainingMs -= waitMs;
			}
			const pass2 = await runPass(failedItems, 1, "重试失败条目");
			failedItems = pass2.failed;
			untriedItems = untriedItems.concat(pass2.untried);
			safetyAborted = pass2.aborted;
		}
		const failures = [...failedItems.map((i) => ({
			id: i.id,
			title: i.title,
			error: incompleteReasons.get(i.id) ?? "导出失败（限流隔离或对话不可用）"
		})), ...untriedItems.map((i) => ({
			id: i.id,
			title: i.title,
			error: `保护性中止，本次未尝试（${safetyReason ?? "失败过多"}；下次增量导出会自动补上）`
		}))];
		if (failures.length > 0) await sink.put("_failures.json", strToU8(JSON.stringify(failures, null, 2)));
		const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-");
		const doneDesc = await sink.close(panel, `${site.id}-export-${kind}-${stamp}.zip`);
		saveWatermark(wmKey(kind), wmDraft);
		panel.setStatus(`${safetyAborted ? `保护性中止（${safetyReason ?? "失败过多"}）。` : "完成："}${list.length - failures.length} 个对话，${doneDesc}` + (skipped > 0 ? `（另跳过未变化 ${skipped} 条）` : "") + (failures.length ? `，${failures.length} 个失败（见 _failures.json）` : "") + proc.assetSummary() + throttleNote());
	}
	function fmtSize(bytes) {
		if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
		if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`;
		return `${bytes}B`;
	}
})();
