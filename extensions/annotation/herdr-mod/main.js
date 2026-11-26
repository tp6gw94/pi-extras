import { randomUUID } from "crypto";
import { View, div } from "gpui-kit";
import { h_flex, v_flex, Button, Popup, TextareaState, Textarea, TextView, ScrollHandle } from "gpui-base";
import { checking, closeOverlay, focused, openOverlay, props, readTextFile, settings, theme, window } from "herdr";
import {
	applyUpdate,
	branchNotes,
	completedTurns,
	composerDraftKey,
	connectionFrom,
	copyAttemptKey,
	copyRequest,
	deleteRequest,
	deliverableNotes,
	encodeComposerDraft,
	hasRunningTurn,
	isUuid,
	mainDraftKey,
	notePhase,
	offBranchCount,
	panelNotes,
	parseComposerDraft,
	parseReplyAttempt,
	parseReplyDraft,
	parseReview,
	parseSendAttempt,
	parseSnapshot,
	parseStartAttempt,
	parseUpdate,
	replyAttemptKey,
	replyDraftKey,
	replyRequest,
	saveRequest,
	sendAttemptKey,
	sendRequest,
	startAttemptKey,
	startCreateRequest,
	startRequest,
} from "./model.js";
import { fetchEvents, fetchReview, fetchSnapshot, postReview } from "./client.js";
import { ROW_HEIGHT, TranscriptKeyboard } from "./keyboard.js";

const HIDDEN_SLEEP_MS = 1500;
const RETRY_SLEEP_MS = 2500;
const REVIEW_POLL_MS = 4000;
const SEND_NOTE_CHANGED = "A selected note changed. Review the notes before sending again.";
const KEYBOARD_MOTIONS = new Set(["h", "j", "k", "l", "ctrl-d", "ctrl-u"]);
const commentPopupReplies = new Map();

const PHASE_LABELS = {
	pending: "Pending",
	sent: "Sent to Pi",
	appended: "In original input",
	running: "Running",
	completed: "Ready",
	failed: "Failed",
	interrupted: "Interrupted",
	thread: "Thread",
};

const STATUS_LABELS = {
	live: "Live",
	connecting: "Connecting",
	offline: "Reconnecting",
	error: "Offline",
	preview: "Preview",
};

const TURN_LABELS = {
	running: "Running",
	completed: "Completed",
	failed: "Failed",
	interrupted: "Interrupted",
};

function messageOf(error) {
	return error && typeof error.message === "string" && error.message !== "" ? error.message : String(error);
}

function inlineClip(text, max) {
	const line = String(text ?? "").replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function phaseColor(t, phase) {
	if (phase === "pending") return t.muted;
	if (phase === "appended" || phase === "completed") return t.done;
	if (phase === "running") return t.working;
	if (phase === "failed" || phase === "interrupted") return t.blocked;
	return t.dim;
}

function statusColor(t, status) {
	if (status === "live") return t.done;
	if (status === "connecting" || status === "offline") return t.working;
	if (status === "error") return t.blocked;
	return t.dim;
}

function itemKindLabel(item) {
	if (!item) return "Transcript";
	if (item.kind === "user") return "You";
	if (item.kind === "assistant") return "Assistant";
	return "Tool";
}

function chord() {
	return window()?.platform === "macos" ? "Cmd" : "Ctrl";
}

function submitHint() {
	return `${chord()}+Enter`;
}

function actionButton(t, id, label, options = {}) {
	const primary = options.primary === true;
	const quiet = options.quiet === true;
	const destructive = options.destructive === true;
	const disabled = options.disabled === true;
	let foreground = t.foreground;
	let background = t.raised;
	let border = t.input;
	if (primary) {
		foreground = t.solid_foreground;
		background = t.solid;
		border = t.solid;
	} else if (destructive) {
		foreground = t.blocked;
		border = t.blocked;
	} else if (quiet) {
		foreground = t.muted;
		background = t.chrome;
		border = t.chrome;
	}
	let button = Button.new(id)
		.h(28)
		.px(10)
		.rounded(7)
		.border_1()
		.border_color(border)
		.bg(background)
		.text_color(foreground)
		.text_size(11.5)
		.font_medium()
		.hover((style) => style.bg(quiet ? t.hover : background).opacity(disabled ? 1 : 0.9))
		.active((style) => style.opacity(disabled ? 1 : 0.75))
		.focus((style) => style.border_color(t.accent))
		.disabled(disabled)
		.when(disabled, (style) => style.opacity(0.5));
	if (options.onClick && !disabled) button = button.on_click(options.onClick);
	return button.child(label);
}

function statusDot(t, color) {
	return div().size(6).rounded(3).flex_none().bg(color);
}

function quoteBlock(t, anchor, item, full) {
	const text = full ? anchor.quote : inlineClip(anchor.quote, 280);
	let block = v_flex()
		.p(8)
		.gap(3)
		.rounded(6)
		.bg(t.background)
		.border_l_1()
		.border_color(t.accent)
		.child(div().text_size(9.5).text_color(t.dim).child(`Selected text · ${itemKindLabel(item)}`))
		.child(div().text_size(11.5).text_color(t.muted).italic().child(text));
	if (full) block = block.max_h(110).overflow_y_scrollbar();
	return block;
}

export default class PiAnnotate extends View {
	init(_props, cx) {
		this.preview = checking();
		const current = this.preview ? {} : props() ?? {};
		this.commentPopup = current.commentPopup ?? null;
		if (this.commentPopup) {
			this.popupOverlay = current.overlay;
			this.popupAccepted = false;
			return;
		}
		this.closed = false;
		this.generation = 0;
		this.reviewSeq = 0;
		this.sessionId = "";
		this.connectionFile = "";
		this.connection = null;
		this.status = this.preview ? "preview" : "connecting";
		this.connectionError = "";
		this.reviewError = "";
		this.items = [];
		this.expandedTools = new Set();
		this.keyboard = null;
		this.keyboardG = false;
		this.keyboardFocus = cx.focus_handle();
		this.saveFocus = cx.focus_handle();
		this.keyboardScroll = ScrollHandle.new();
		this.keyboardWidth = null;
		this.version = 0;
		this.notes = [];
		this.selection = null;
		this.selectionPopup = null;
		this.transcriptBounds = null;
		this.composerPlacement = null;
		this.selectedNoteId = null;
		this.confirmDeleteId = null;
		this.composer = null;
		this.composerState = null;
		this.composerFocused = false;
		this.composerBlank = true;
		this.composerError = "";
		this.mainState = null;
		this.mainFocused = false;
		this.mainNotice = "";
		this.mainError = "";
		this.startAttempt = null;
		this.ownedSend = undefined;
		this.ownedStart = undefined;
		this.observedSendRequestId = undefined;
		this.sendReceiptUnknown = false;
		this.sendMayStillArrive = false;
		this.sendResolution = null;
		this.inputBaselines = new WeakMap();
		this.enterEdits = new WeakMap();
		this.recovered = false;
		this.replyStates = new Map();
		this.replyFocused = new Map();
		this.replyBlank = new Map();
		this.failures = new Map();
		this.pending = new Set();
		this.pollTask = null;
		this.reviewTask = null;
		this.reviewInFlight = false;
		this.restored = false;
		this.reviewReady = false;
		this.sessionId = typeof current.sessionId === "string" ? current.sessionId : "";
		this.connectionFile = typeof current.connectionFile === "string" ? current.connectionFile : "";
		this.ensureMainState();
		if (!this.preview) this.connect(cx);
	}

	close() {
		if (this.commentPopup) {
			const reply = commentPopupReplies.get(this.commentPopup);
			commentPopupReplies.delete(this.commentPopup);
			reply?.(this.popupAccepted);
			return;
		}
		this.closed = true;
		this.dismissSelectionPopup();
		this.generation += 1;
		this.reviewSeq += 1;
		this.pollTask?.cancel();
		this.reviewTask?.cancel();
		this.composerState?.release();
		this.mainState?.release();
		this.keyboardFocus.release();
		this.saveFocus.release();
		this.keyboardScroll.release();
		for (const state of this.replyStates.values()) state.release();
		this.replyStates.clear();
		return localStorage.flush();
	}

	invalidateReview() {
		this.reviewSeq += 1;
		this.reviewInFlight = false;
	}

	connect(cx) {
		this.dismissSelectionPopup();
		this.composerPlacement = null;
		this.generation += 1;
		const generation = this.generation;
		this.reviewTask?.cancel();
		this.reviewTask = null;
		this.pollTask = null;
		this.invalidateReview();
		this.connection = null;
		this.reviewReady = false;
		this.status = "connecting";
		this.connectionError = "";
		cx.notify();
		cx.spawn(async (cx) => {
			try {
				let raw;
				try {
					raw = await readTextFile(this.connectionFile);
				} catch {
					throw new Error("The annotation connection file could not be read. Run /annotate-herdr again.");
				}
				const connection = connectionFrom(raw, this.sessionId);
				const snapshot = parseSnapshot(await fetchSnapshot(connection), this.sessionId);
				if (this.closed || generation !== this.generation) return;
				this.connection = connection;
				this.items = snapshot.items;
				this.version = snapshot.version;
				this.status = "live";
				this.reviewError = "";
				this.pruneExpandedTools();
				this.pruneSelection();
				if (!this.restored) {
					this.restored = true;
					this.restoreComposerDraft();
					this.restoreMainDraft();
				}
				this.syncSendAttempt();
				this.reflowKeyboard(cx);
				this.startPolling(cx, generation);
				this.startReviewPolling(cx, generation);
				this.refreshReview(cx, true);
				cx.notify();
			} catch (error) {
				if (this.closed || generation !== this.generation) return;
				this.status = "error";
				this.connectionError = messageOf(error);
				cx.notify();
			}
		});
	}

	startPolling(cx, generation) {
		this.pollTask = cx.spawn(async (cx) => {
			while (!this.closed && this.generation === generation) {
				if (window()?.visible === false) {
					await cx.sleep(HIDDEN_SLEEP_MS);
					continue;
				}
				try {
					const update = parseUpdate(await fetchEvents(this.connection, this.version));
					if (this.closed || this.generation !== generation) return;
					if (update.version !== this.version || update.reset || update.items.length > 0) {
						const next = applyUpdate({ version: this.version, items: this.items }, update);
						this.version = next.version;
						this.items = next.items;
						this.status = "live";
						this.connectionError = "";
						this.pruneExpandedTools();
						this.reflowKeyboard();
						this.pruneSelection();
						cx.notify();
						this.refreshReview(cx, true);
					} else if (this.status !== "live" || this.connectionError !== "") {
						this.status = "live";
						this.connectionError = "";
						cx.notify();
					}
				} catch (error) {
					if (this.closed || this.generation !== generation) return;
					if (error.status === 403 || error.status === 410) {
						this.connect(cx);
						return;
					}
					this.status = "offline";
					this.connectionError = messageOf(error);
					cx.notify();
					await cx.sleep(RETRY_SLEEP_MS);
				}
			}
		});
	}

	startReviewPolling(cx, generation) {
		this.reviewTask?.cancel();
		this.reviewTask = cx.timer.every(REVIEW_POLL_MS, (cx) => {
			if (this.closed || this.generation !== generation || !this.connection) return;
			if (this.reviewInFlight || window()?.visible === false) return;
			this.refreshReview(cx, false);
		});
	}

	refreshReview(cx, notify) {
		if (!this.connection || this.reviewInFlight || this.pending.size > 0) return;
		this.reviewInFlight = true;
		this.reviewSeq += 1;
		const seq = this.reviewSeq;
		const generation = this.generation;
		const connection = this.connection;
		cx.spawn(async (cx) => {
			try {
				const review = parseReview(await fetchReview(connection));
				if (this.closed || seq !== this.reviewSeq || generation !== this.generation) return;
				const before = JSON.stringify(this.notes);
				const firstReview = !this.reviewReady;
				const hadError = this.reviewError;
				this.applyReview(review);
				const changed = before !== JSON.stringify(this.notes);
				const sendChanged = this.syncSendAttempt();
				if (notify || hadError !== "" || changed || sendChanged || firstReview) cx.notify();
			} catch (error) {
				if (this.closed || seq !== this.reviewSeq || generation !== this.generation) return;
				const message = messageOf(error);
				if (notify || message !== this.reviewError) {
					this.reviewError = message;
					cx.notify();
				}
			} finally {
				if (seq === this.reviewSeq) this.reviewInFlight = false;
			}
		});
	}

	applyReview(review) {
		this.reviewReady = true;
		this.reviewError = "";
		this.notes = review.notes;
		const threads = new Set(review.notes.filter((note) => note.status === "thread").map((note) => note.id));
		for (const [id, state] of [...this.replyStates]) {
			if (threads.has(id)) continue;
			state.release();
			this.replyStates.delete(id);
			this.replyFocused.delete(id);
			this.replyBlank.delete(id);
			this.failures.delete(`reply:${id}`);
		}
		for (const note of review.notes) {
			if (note.status === "thread") this.ensureReplyState(note);
		}
		this.pruneSelection();
		if (this.confirmDeleteId && !review.notes.some((note) => note.id === this.confirmDeleteId && note.status === "pending")) {
			this.confirmDeleteId = null;
		}
	}

	ensureComposerState() {
		if (this.composerState) return;
		const state = TextareaState.new({ placeholder: "Write a comment on the selected text", rows: 4 });
		state.on("change", (_event, cx) => {
			if (!this.composer || !this.noteInputChange(state, cx)) return;
			const text = state.value();
			if (text === this.composer.text) return;
			this.composer.text = text;
			this.persistComposer();
			const blank = text.trim() === "";
			if (blank !== this.composerBlank) {
				this.composerBlank = blank;
				cx.notify();
			}
		});
		state.on("focus", (_event, cx) => {
			this.composerFocused = true;
			cx.notify();
		});
		state.on("blur", (_event, cx) => {
			this.composerFocused = false;
			cx.notify();
		});
		state.on("submit", ({ secondary, shift }, cx) => {
			if (!secondary && shift) return this.keepInput(state);
			if (this.restoreBeforeEnter(state)) {
				this.composer.text = state.value();
				this.composerBlank = this.composer.text.trim() === "";
				this.persistComposer();
			}
			if (!secondary) this.saveComposer(cx);
			else this.saveThen(cx, shift ? "start" : "send");
		});
		this.inputBaselines.set(state, state.value());
		this.composerState = state;
	}

	ensureReplyState(note) {
		if (this.replyStates.has(note.id)) return;
		const key = replyDraftKey(this.sessionId, note.id);
		const initial = parseReplyDraft(localStorage.getItem(key));
		const state = TextareaState.new({ placeholder: "Reply to the background Pi thread", value: initial, rows: 3 });
		this.replyBlank.set(note.id, initial.trim() === "");
		let written = initial;
		state.on("change", (_event, cx) => {
			if (!this.noteInputChange(state, cx)) return;
			const value = state.value();
			if (value === "") {
				if (localStorage.getItem(key) === written) localStorage.removeItem(key);
			} else localStorage.setItem(key, value);
			written = value;
			const blank = value.trim() === "";
			if (blank !== this.replyBlank.get(note.id)) {
				this.replyBlank.set(note.id, blank);
				cx.notify();
			}
		});
		state.on("focus", (_event, cx) => {
			this.replyFocused.set(note.id, true);
			cx.notify();
		});
		state.on("blur", (_event, cx) => {
			this.replyFocused.set(note.id, false);
			cx.notify();
		});
		state.on("submit", ({ secondary, shift }, cx) => {
			if (!secondary && shift) return this.keepInput(state);
			if (this.restoreBeforeEnter(state)) {
				written = state.value();
				if (written === "") localStorage.removeItem(key);
				else localStorage.setItem(key, written);
				this.replyBlank.set(note.id, written.trim() === "");
			}
			if (secondary && shift) this.runReply(note.id, cx);
			else if (secondary) this.sendMain(cx);
			else cx.notify();
		});
		this.inputBaselines.set(state, initial);
		this.replyStates.set(note.id, state);
	}

	restoreComposerDraft() {
		this.ensureComposerState();
		const draft = parseComposerDraft(localStorage.getItem(composerDraftKey(this.sessionId)));
		if (!draft) return;
		this.composer = draft;
		if (!draft.noteId && !draft.createId) {
			draft.createId = randomUUID();
			this.persistComposer();
		}
		this.setInputValue(this.composerState, draft.text);
		this.composerBlank = draft.text.trim() === "";
		this.composerError = "";
		this.composerFocused = false;
		this.recovered = true;
		this.selection = draft.anchor;
		this.selectedNoteId = draft.noteId;
	}

	persistComposer() {
		if (!this.composer) return;
		localStorage.setItem(composerDraftKey(this.sessionId), encodeComposerDraft(this.composer));
	}

	ensureMainState() {
		if (this.mainState) return;
		const key = mainDraftKey(this.sessionId);
		const initial = localStorage.getItem(key) ?? "";
		this.mainDraftVersion = localStorage.getItem(`${key}:revision`);
		const state = TextareaState.new({ placeholder: "Write to main Pi, or add context to the pending comments", value: initial, rows: 3 });
		state.on("change", (_event, cx) => {
			if (!this.noteInputChange(state, cx)) return;
			this.persistMainText(state.value());
			cx.notify();
		});
		state.on("focus", (_event, cx) => {
			this.mainFocused = true;
			cx.notify();
		});
		state.on("blur", (_event, cx) => {
			this.mainFocused = false;
			cx.notify();
		});
		state.on("submit", ({ secondary, shift }, cx) => {
			if (!secondary && shift) return this.keepInput(state);
			if (this.restoreBeforeEnter(state)) this.persistMainText(state.value());
			if (secondary && shift) this.startUnanchored(cx);
			else if (secondary) this.sendMain(cx);
			else cx.notify();
		});
		this.inputBaselines.set(state, initial);
		this.mainState = state;
	}

	restoreMainDraft() {
		this.ensureMainState();
		const startRaw = localStorage.getItem(startAttemptKey(this.sessionId));
		this.startAttempt = parseStartAttempt(startRaw);
		if (startRaw !== null && !this.startAttempt) localStorage.removeItem(startAttemptKey(this.sessionId));
	}

	currentSendAttempt() {
		return parseSendAttempt(localStorage.getItem(sendAttemptKey(this.sessionId)));
	}

	syncSendAttempt() {
		const requestId = this.currentSendAttempt()?.requestId;
		if (requestId === this.observedSendRequestId) return false;
		this.observedSendRequestId = requestId;
		this.sendReceiptUnknown = false;
		this.sendMayStillArrive = false;
		this.sendResolution = null;
		return true;
	}

	isEnterInsertion(before, after, range) {
		if (range.start !== range.end || range.start === 0 || after[range.start - 1] !== "\n") return false;
		const caret = range.start;
		if (after.slice(0, caret - 1) !== before.slice(0, caret - 1)) return false;
		const tail = after.slice(caret);
		const end = before.length - tail.length;
		return end >= caret - 1 && before.slice(end) === tail;
	}

	noteInputChange(state, cx) {
		const value = state.value();
		const before = this.inputBaselines.get(state);
		if (before === value) return false;
		this.inputBaselines.set(state, value);
		this.enterEdits.delete(state);
		const range = state.selected_range();
		if (this.isEnterInsertion(before, value, range)) {
			const edit = { before, value, caret: range.start };
			this.enterEdits.set(state, edit);
			cx.spawn(async (cx) => {
				await cx.sleep(0);
				if (this.enterEdits.get(state) === edit) this.enterEdits.delete(state);
			});
		}
		return true;
	}

	keepInput(state) {
		this.inputBaselines.set(state, state.value());
		this.enterEdits.delete(state);
	}

	setInputValue(state, text) {
		this.inputBaselines.set(state, text);
		this.enterEdits.delete(state);
		state.set_value(text);
	}

	restoreBeforeEnter(state) {
		const edit = this.enterEdits.get(state);
		this.keepInput(state);
		if (!edit || state.value() !== edit.value) return false;
		const { start, end } = state.selected_range();
		if (start !== edit.caret || end !== start) return false;
		this.setInputValue(state, edit.before);
		state.set_selected_range({ start: start - 1, end: edit.before.length - (edit.value.length - start) });
		return true;
	}


	mainText() {
		return this.mainState.value();
	}

	sendableNotes() {
		return deliverableNotes(this.notes, this.items);
	}

	persistMainText(text) {
		const key = mainDraftKey(this.sessionId);
		this.mainDraftVersion = randomUUID();
		localStorage.setItem(`${key}:revision`, this.mainDraftVersion);
		if (text === "") localStorage.removeItem(key);
		else localStorage.setItem(key, text);
	}

	clearMainAfter(text, version) {
		if (this.mainState.value() !== text || this.mainDraftVersion !== version) return;
		const key = mainDraftKey(this.sessionId);
		const storedVersion = localStorage.getItem(`${key}:revision`);
		const storedText = localStorage.getItem(key) ?? "";
		if (storedVersion !== version || storedText !== text) {
			this.mainDraftVersion = storedVersion;
			this.setInputValue(this.mainState, storedText);
			return;
		}
		this.setInputValue(this.mainState, "");
		this.persistMainText("");
	}

	finishSend(body, sent) {
		const current = this.currentSendAttempt();
		const matches = current?.requestId === body.requestId;
		if (matches) localStorage.removeItem(sendAttemptKey(this.sessionId));
		this.syncSendAttempt();
		this.mainError = "";
		if (!sent) this.mainNotice = "The previous request was not sent. Your draft and pending comments are still here.";
		else if (body.action === "send" && this.ownedSend?.id === body.requestId && (!current || matches)) {
			this.clearMainAfter(body.text, this.ownedSend.version);
			this.mainNotice = body.noteIds.length > 0 ? `Sent ${body.noteIds.length} comment${body.noteIds.length === 1 ? "" : "s"}${body.text.trim() ? " and your message" : ""} to main Pi.` : "Sent your message to main Pi.";
		} else this.mainNotice = "The previous send was confirmed. Your draft stays here.";
		if (this.ownedSend?.id === body.requestId) this.ownedSend = undefined;
	}

	submitSend(cx, attempt, body) {
		this.syncSendAttempt();
		this.mainError = "";
		this.mainNotice = "";
		this.sendReceiptUnknown = false;
		this.sendMayStillArrive = false;
		this.sendResolution = null;
		this.submitReview(cx, "send", body, (_noteId, _review, response) => {
			if (response.sentRequestId === attempt.requestId) this.finishSend(attempt, true);
			else if (response.resolvedRequestId === attempt.requestId && body.action === "resolve-send" && body.outcome === "not-sent") {
				this.finishSend(attempt, false);
			} else this.mainError = "Pi did not acknowledge this send. Your draft stays here.";
		}, (message, error) => {
			if (error.status === 409 && isUuid(error.pendingSendRequestId) && this.currentSendAttempt()?.requestId === attempt.requestId) {
				localStorage.setItem(sendAttemptKey(this.sessionId), JSON.stringify({ action: "check-send", requestId: error.pendingSendRequestId }));
				this.syncSendAttempt();
				this.mainError = "Check the previous send before sending a new message.";
				return;
			}
			if (body.action === "check-send" && error.status === 409 && message === "This request was not sent. Start a new send.") {
				this.finishSend(attempt, false);
				return;
			}
			if (body.action === "send" && error.status === 409 && message === SEND_NOTE_CHANGED) {
				this.finishSend(attempt, false);
			}
			this.sendMayStillArrive = error.status === 409 && message === "Receipt unknown. Main Pi may still deliver this message. Check again or confirm it was sent if you see it.";
			this.sendReceiptUnknown = this.sendMayStillArrive || (error.status === 409 && message === "Receipt unknown. Check the source conversation before sending again.");
			this.mainError = message;
		});
	}

	sendMain(cx, batch) {
		if (!this.connection || this.pending.size > 0 || !this.reviewReady) return;
		if (this.currentSendAttempt()) {
			this.mainError = "Check the previous send before sending a new message.";
			cx.notify();
			return;
		}
		const current = new Map(this.sendableNotes().map((note) => [note.id, note.version]));
		if (batch && [...batch.versions].some(([id, version]) => current.get(id) !== version)) {
			this.mainError = SEND_NOTE_CHANGED;
			cx.notify();
			return;
		}
		const body = sendRequest(batch?.versions ?? current, batch?.text ?? this.mainText(), randomUUID());
		if (!body) {
			this.mainError = "Write a message or add a pending comment first.";
			cx.notify();
			return;
		}
		this.ownedSend = { id: body.requestId, version: batch ? batch.draftVersion : this.mainDraftVersion };
		localStorage.setItem(sendAttemptKey(this.sessionId), JSON.stringify(body));
		this.submitSend(cx, body, body);
	}

	checkSend(cx) {
		const attempt = this.currentSendAttempt();
		if (!attempt || this.pending.size > 0 || !this.reviewReady) return;
		this.submitSend(cx, attempt, { action: "check-send", requestId: attempt.requestId });
	}

	resolveSend(cx, outcome) {
		const attempt = this.currentSendAttempt();
		if (!attempt || attempt.requestId !== this.observedSendRequestId || !this.sendReceiptUnknown || (outcome === "not-sent" && this.sendMayStillArrive) || this.pending.size > 0 || !this.reviewReady) return;
		if (this.sendResolution !== outcome) {
			this.sendResolution = outcome;
			cx.notify();
			return;
		}
		this.submitSend(cx, attempt, { action: "resolve-send", requestId: attempt.requestId, outcome });
	}


	startUnanchored(cx) {
		if (!this.connection || this.pending.size > 0 || !this.reviewReady) return;
		const key = startAttemptKey(this.sessionId);
		const attempt = parseStartAttempt(localStorage.getItem(key));
		this.startAttempt = attempt;
		const body = attempt ?? startCreateRequest(randomUUID(), this.mainText());
		if (!body) {
			this.mainError = "Write a message before starting a background thread.";
			cx.notify();
			return;
		}
		this.startAttempt = body;
		const stored = JSON.stringify({ createId: body.createId, text: body.text });
		if (!attempt) {
			this.ownedStart = { id: body.createId, version: this.mainDraftVersion };
			localStorage.setItem(key, stored);
		}
		this.mainError = "";
		this.mainNotice = "";
		this.failures.delete("start-new");
		this.submitReview(cx, "start-new", body, (noteId) => {
			this.selectedNoteId = noteId;
			const current = localStorage.getItem(key);
			if (current === stored) localStorage.removeItem(key);
			this.startAttempt = parseStartAttempt(localStorage.getItem(key));
			if (this.ownedStart?.id === body.createId) {
				if (current === null || current === stored) this.clearMainAfter(body.text, this.ownedStart.version);
				this.ownedStart = undefined;
			}
			this.mainNotice = "Started an independent background thread.";
		}, (message, error) => {
			if (error.status === 409 && message === "No model selected.") {
				if (localStorage.getItem(key) === stored) localStorage.removeItem(key);
				this.startAttempt = parseStartAttempt(localStorage.getItem(key));
			}
			this.failures.set("start-new", message);
		});
	}

	copyThread(note, cx) {
		if (!this.reviewReady || note.status !== "thread" || this.pending.size > 0) return;
		const key = copyAttemptKey(this.sessionId, note.id);
		const stored = localStorage.getItem(key);
		const createId = isUuid(stored) ? stored : randomUUID();
		localStorage.setItem(key, createId);
		this.submitAction(cx, `copy:${note.id}`, `copy:${note.id}`, copyRequest(note.id, createId), (noteId) => {
			if (localStorage.getItem(key) === createId) localStorage.removeItem(key);
			this.selectedNoteId = noteId;
		});
	}


	saveThen(cx, mode) {
		if (mode === "send" && this.currentSendAttempt()) {
			this.composerError = "Check the previous send before using Save & send.";
			cx.notify();
			return;
		}
		const batch = mode === "send" ? {
			text: this.mainText(),
			draftVersion: this.mainDraftVersion,
			versions: new Map(this.sendableNotes().map((note) => [note.id, note.version])),
			quote: this.composer?.anchor?.quote,
		} : null;
		this.saveComposer(cx, (noteId, review, unchanged) => {
			if (!unchanged) return;
			const note = review.notes.find((candidate) => candidate.id === noteId);
			if (!batch) {
				if (note?.status === "pending") this.startThread(note, cx);
				return;
			}
			if (note?.status !== "pending" || note.anchor?.quote !== batch.quote) {
				this.mainError = SEND_NOTE_CHANGED;
				cx.notify();
				return;
			}
			batch.versions.set(note.id, note.version);
			this.sendMain(cx, batch);
		});
	}

	beginComposer(noteId, anchor, text) {
		this.dismissSelectionPopup();
		this.ensureComposerState();
		this.composer = { noteId, anchor, text, ...(noteId ? { expectedText: text } : { createId: randomUUID() }) };
		this.setInputValue(this.composerState, text);
		this.composerBlank = text.trim() === "";
		this.composerFocused = false;
		this.composerError = "";
		this.recovered = false;
		this.persistComposer();
	}

	closeComposer(restoreFocus) {
		if (restoreFocus && this.keyboard) this.keyboardFocus.focus();
		const key = composerDraftKey(this.sessionId);
		if (localStorage.getItem(key) === encodeComposerDraft(this.composer)) localStorage.removeItem(key);
		this.composer = null;
		this.composerPlacement = null;
		this.setInputValue(this.composerState, "");
		this.composerBlank = true;
		this.composerFocused = false;
		this.composerError = "";
		this.recovered = false;
		this.selection = null;
	}

	pruneSelection() {
		if (this.selection && !this.anchorInScope(this.selection)) {
			this.selection = null;
			this.dismissSelectionPopup();
		}
		if (this.selectedNoteId && !branchNotes(this.notes, this.items).some((note) => note.id === this.selectedNoteId)) this.selectedNoteId = null;
	}

	pruneExpandedTools() {
		const tools = new Set(this.items.filter((item) => item.kind === "tool").map((item) => item.id));
		for (const id of this.expandedTools) if (!tools.has(id)) this.expandedTools.delete(id);
	}

	anchorInScope(anchor, text = this.items.find((item) => item.id === anchor?.itemId)?.text) {
		if (anchor === null) return true;
		return text !== undefined && anchor.end <= text.length
			&& (anchor.sourceText === undefined || text.slice(anchor.start, anchor.end) === anchor.sourceText);
	}

	composerTargetError() {
		const noteId = this.composer?.noteId;
		if (!noteId) return "";
		if (this.composer.expectedText === undefined) return "This draft has no original comment text. Copy your draft before canceling and reopening the edit.";
		if (!this.reviewReady) return "Waiting for comments to load before this edit can be saved.";
		if (this.notes.some((note) => note.id === noteId && note.status === "pending")) return "";
		return "This comment is no longer pending. Copy your draft before canceling.";
	}

	captureSelection(item, selection, cx) {
		if (!selection?.range || this.composer) return;
		const { start, end } = selection.range;
		const inRange = Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= item.text.length;
		if (!inRange) return;
		const sourceText = item.text.slice(start, end);
		const previous = this.selection;
		if (!selection.position && !this.selectionPopup && previous?.itemId === item.id && previous.start === start && previous.end === end && previous.quote === selection.text && previous.sourceText === sourceText) return;
		this.dismissSelectionPopup();
		this.selection = { itemId: item.id, start, end, quote: selection.text, sourceText };
		if (selection.position) this.showSelectionPopup(selection.position, cx);
		cx.notify();
	}

	showSelectionPopup(position, cx) {
		const anchor = this.selection;
		const tab = focused()?.tab;
		const token = randomUUID();
		const overlay = openOverlay({ mod: "pi-annotate", kind: "popup", at: position, frame: "none", width: 120, height: 36, props: { commentPopup: token } });
		const response = new Promise((resolve) => commentPopupReplies.set(token, resolve));
		this.selectionPopup = { token, overlay };
		cx.spawn(async (cx) => {
			const accepted = await response;
			if (this.selectionPopup?.token !== token) return;
			this.selectionPopup = null;
			if (accepted && this.selection === anchor && tab === focused()?.tab && this.anchorInScope(anchor)) this.openComposer(cx, position);
		});
	}

	dismissSelectionPopup() {
		if (!this.selectionPopup) return;
		const { token, overlay } = this.selectionPopup;
		this.selectionPopup = null;
		const reply = commentPopupReplies.get(token);
		commentPopupReplies.delete(token);
		reply?.(false);
		if (reply) closeOverlay(overlay);
	}

	clearSelection(cx) {
		this.dismissSelectionPopup();
		if (this.keyboard) this.keyboard.visual = null;
		this.selection = null;
		cx.notify();
	}

	ensureKeyboard(cx) {
		if (this.keyboard) return;
		if (cx && !this.composer && !this.focusedTextState()) this.keyboardFocus.focus();
		const keyboard = new TranscriptKeyboard(this.items, this.expandedTools, this.selection);
		if (!keyboard.cursor) return;
		if (this.keyboardWidth !== null) keyboard.resize(this.keyboardWidth, this.items, this.expandedTools);
		this.keyboard = keyboard;
	}

	focusedTextState() {
		if (this.composerFocused || this.mainFocused) return true;
		for (const focused of this.replyFocused.values()) if (focused) return true;
		return false;
	}

	focusTranscript(cx) {
		this.keyboardG = false;
		this.ensureKeyboard();
		this.keyboardFocus.focus();
		if (this.keyboard) this.revealKeyboardCursor();
		cx.notify();
	}

	reflowKeyboard(cx) {
		if (!this.keyboard) {
			this.ensureKeyboard(cx);
			return;
		}
		if (this.keyboard.reflow(this.items, this.expandedTools)) return;
		if (!this.composer && this.keyboard.visual) this.selection = null;
		this.keyboardG = false;
		this.keyboard = null;
		this.ensureKeyboard();
	}


	resizeKeyboard(size, cx) {
		this.keyboardWidth = size.width / settings().zoom;
		if (!this.keyboard) return;
		const resized = this.keyboard.resize(this.keyboardWidth, this.items, this.expandedTools);
		if (resized) this.revealKeyboardCursor();
		else this.reflowKeyboard();
		cx.notify();
	}

	revealKeyboardCursor() {
		const { item } = this.keyboard.rows[this.keyboard.cursor.row];
		const index = this.items.findIndex((candidate) => candidate.id === item.id);
		if (index >= 0) this.keyboardScroll.scroll_to_item(index);
	}

	updateSelection() {
		this.dismissSelectionPopup();
		this.selection = this.keyboard.selection();
		this.revealKeyboardCursor();
	}

	onTranscriptKey(event, cx) {
		if (!this.keyboard || this.composer || !this.keyboardFocus.is_focused()) return;
		const key = event.keystroke;
		if (key === "cmd-enter" || key === "ctrl-enter") {
			if (!event.is_held) this.sendMain(cx);
			cx.stop_propagation();
			cx.notify();
			return;
		}
		if (key !== "g") this.keyboardG = false;
		if (key === "g") {
			if (event.is_held) this.keyboardG = false;
			else if (this.keyboardG) {
				this.keyboardG = false;
				this.keyboard.jumpFirst();
				this.updateSelection();
			} else this.keyboardG = true;
		} else if (key === "shift-g") {
			this.keyboard.jumpLast();
			this.updateSelection();
		} else if (KEYBOARD_MOTIONS.has(key)) {
			this.keyboard.move(key, this.keyboardScroll.viewport_size().height / ROW_HEIGHT);
			this.updateSelection();
		} else if (key === "v") {
			if (!event.is_held) {
				this.dismissSelectionPopup();
				this.keyboard.toggleVisual();
				this.selection = this.keyboard.selection();
			}
		} else if (key === "escape") {
			if (!event.is_held && (this.selection || this.keyboard.visual)) this.clearSelection(cx);
		} else if (key === "c" && this.keyboard.visual) {
			if (this.selection) this.openComposer(cx);
		} else return;
		cx.stop_propagation();
		cx.notify();
	}

	openComposer(cx, position) {
		if (!this.selection || this.composer) return;
		this.keyboardG = false;
		if (this.keyboard) this.keyboard.visual = null;
		this.beginComposer(null, { ...this.selection }, "");
		if (position) {
			const bounds = this.transcriptBounds;
			const zoom = settings().zoom ?? 1;
			this.composerPlacement = bounds ? {
				x: Math.max(0, Math.min(bounds.width, position.x - bounds.x)) / zoom,
				y: Math.max(0, Math.min(bounds.height, position.y - bounds.y)) / zoom,
				width: Math.min(360, bounds.width / zoom),
				needsFocus: true,
			} : { x: 12, y: 12, width: 360, needsFocus: true };
		} else this.composerState.focus();
		cx.notify();
	}

	dismissLocalComposer(cx) {
		if (!this.composerPlacement) return;
		this.composerPlacement = null;
		this.composerState.blur();
		cx.notify();
	}

	editNote(note, cx) {
		if (!this.reviewReady || note.status !== "pending" || this.composer) return;
		this.beginComposer(note.id, note.anchor, note.text);
		this.selection = note.anchor;
		this.selectedNoteId = note.id;
		this.confirmDeleteId = null;
		this.composerState.focus();
		cx.notify();
	}

	cancelComposer(cx) {
		if (!this.composer) return;
		this.closeComposer(true);
		cx.notify();
	}

	selectNote(noteId, cx) {
		this.selectedNoteId = this.selectedNoteId === noteId ? null : noteId;
		const note = this.notes.find((candidate) => candidate.id === this.selectedNoteId);
		const item = note?.anchor && this.items.find((candidate) => candidate.id === note.anchor.itemId);
		if (item?.kind === "tool" && !this.expandedTools.has(item.id)) {
			this.expandedTools.add(item.id);
			this.reflowKeyboard();
		}
		this.confirmDeleteId = null;
		cx.notify();
	}

	saveComposer(cx, after) {
		if (!this.composer || !this.connection || this.pending.size > 0 || this.composerTargetError()) return;
		const composer = this.composer;
		const text = this.composerState.value();
		const body = text.trim() ? saveRequest(composer.anchor, composer.createText ?? text, composer) : null;
		if (!body) {
			this.composerError = "Write a comment first.";
			cx.notify();
			return;
		}
		if (!this.anchorInScope(composer.anchor)) {
			this.composerError = "This selection is no longer on the current branch. Copy the text or clear the draft.";
			cx.notify();
			return;
		}
		this.composerError = "";
		const key = composerDraftKey(this.sessionId);
		if (!composer.noteId && composer.createText === undefined) {
			const ownsDraft = localStorage.getItem(key) === encodeComposerDraft(composer);
			composer.createText = body.text;
			if (ownsDraft) this.persistComposer();
		}
		const tab = focused()?.tab;
		const fromSave = this.saveFocus.is_focused();
		const fromComposer = this.composerFocused;
		this.submitReview(cx, "save", body, (noteId, review) => {
			if (this.composer !== composer) return;
			const currentText = this.composerState.value();
			const changedSinceCreate = body.createId && review.notes.find((note) => note.id === noteId)?.text !== body.text;
			if (currentText === body.text && !changedSinceCreate) {
				this.selectedNoteId = noteId;
				const retainsFocus = fromSave ? this.saveFocus.is_focused() : fromComposer && this.composerFocused;
				this.closeComposer(tab === focused()?.tab && retainsFocus);
				after?.(noteId, review, true);
				return;
			}
			const ownsDraft = localStorage.getItem(key) === encodeComposerDraft(composer);
			composer.noteId = noteId;
			composer.expectedText = body.text;
			composer.text = currentText;
			delete composer.createText;
			delete composer.createId;
			if (changedSinceCreate) this.composerError = "The saved comment has changed. Your draft is still here.";
			if (ownsDraft) this.persistComposer();
			after?.(noteId, review, false);
		}, (message) => {
			if (this.composer === composer) this.composerError = message;
		});
	}

	submitReview(cx, pendingKey, body, onSuccess, onFailure) {
		if (this.pending.size > 0 || !this.connection) return;
		const connection = this.connection;
		const generation = this.generation;
		this.pending.add(pendingKey);
		this.invalidateReview();
		cx.notify();
		cx.spawn(async (cx) => {
			try {
				if (body.action === "reply" || body.action === "send" || body.action === "copy" || (body.action === "start" && body.createId)) {
					await localStorage.flush();
					if (this.closed || generation !== this.generation) return;
					if (body.action === "send" && this.currentSendAttempt()?.requestId !== body.requestId) return;
				}
				const response = await postReview(connection, body);
				if (this.closed) return;
				const current = generation === this.generation;
				if (!current && body.action !== "save" && body.action !== "reply") return;
				const review = parseReview(response);
				if ((body.action === "save" || body.action === "copy") && (typeof response.noteId !== "string" || response.noteId === "")) {
					throw new Error(`The Pi ${body.action} response has no note ID.`);
				}
				if (body.action === "start" && body.createId && response.noteId !== body.createId) {
					throw new Error("Pi did not acknowledge the previous background start.");
				}
				if (current) this.applyReview(review);
				this.pending.delete(pendingKey);
				onSuccess(response.noteId, review, response);
			} catch (error) {
				if (!this.closed && (generation === this.generation || body.action === "reply")) onFailure(messageOf(error), error);
			} finally {
				if (!this.closed) {
					this.pending.delete(pendingKey);
					if (this.pending.size === 0 && window()?.visible !== false) this.refreshReview(cx, false);
					cx.notify();
				}
			}
		});
	}

	submitAction(cx, pendingKey, failureKey, body, onSuccess) {
		this.failures.delete(failureKey);
		this.submitReview(cx, pendingKey, body, onSuccess, (message) => this.failures.set(failureKey, message));
	}

	startThread(note, cx) {
		if (!this.reviewReady || note.status !== "pending" || this.pending.size > 0) return;
		const body = startRequest(note.id);
		this.selectedNoteId = note.id;
		this.submitAction(cx, `thread:${note.id}`, `start:${note.id}`, body, () => {
			this.selectedNoteId = note.id;
		});
	}

	runReply(noteId, cx) {
		const note = this.notes.find((candidate) => candidate.id === noteId);
		const state = this.replyStates.get(noteId);
		if (!this.reviewReady || !note || note.status !== "thread" || !state || this.pending.size > 0) return;
		const key = replyDraftKey(this.sessionId, noteId);
		const attemptKey = replyAttemptKey(this.sessionId, noteId);
		const failureKey = `reply:${noteId}`;
		const stored = localStorage.getItem(attemptKey);
		const retry = stored === null ? null : parseReplyAttempt(stored, noteId);
		if (stored !== null && !retry) {
			localStorage.removeItem(attemptKey);
			this.failures.set(failureKey, "The previous reply could not be recovered. Check the thread before sending again.");
			cx.notify();
			return;
		}
		if (!retry && hasRunningTurn(note)) return;
		const text = state.value();
		const body = retry ?? replyRequest(noteId, text, randomUUID());
		if (!body) {
			this.failures.set(failureKey, "Write a reply first.");
			cx.notify();
			return;
		}
		const unchanged = text === body.text;
		const encoded = stored ?? JSON.stringify(body);
		if (!retry) localStorage.setItem(attemptKey, encoded);
		const clearAttempt = () => {
			if (localStorage.getItem(attemptKey) !== encoded) return false;
			localStorage.removeItem(attemptKey);
			return true;
		};
		this.selectedNoteId = noteId;
		this.failures.delete(failureKey);
		this.submitReview(cx, `thread:${noteId}`, body, () => {
			if (!clearAttempt() || !unchanged || this.replyStates.get(noteId) !== state || state.value() !== text) return;
			if (localStorage.getItem(key) === text) localStorage.removeItem(key);
			this.setInputValue(state, "");
			this.replyBlank.set(noteId, true);
		}, (message, error) => {
			if (error.status === 409) clearAttempt();
			this.failures.set(failureKey, message);
		});
	}

	deleteNote(note, cx) {
		if (!this.reviewReady || note.status !== "pending" || this.pending.size > 0) return;
		if (this.confirmDeleteId !== note.id) {
			this.confirmDeleteId = note.id;
			cx.notify();
			return;
		}
		const body = deleteRequest(note.id);
		this.submitAction(cx, `delete:${note.id}`, `delete:${note.id}`, body, () => {
			if (this.selectedNoteId === note.id) this.selectedNoteId = null;
			this.confirmDeleteId = null;
		});
	}

	renderTranscriptHeader(t) {
		const color = statusColor(t, this.status);
		return h_flex()
			.h(48)
			.flex_none()
			.px(18)
			.gap(10)
			.items_center()
			.border_b_1()
			.border_color(t.border)
			.bg(t.chrome)
			.child(div().text_size(14).font_semibold().child("Pi annotations"))
			.child(h_flex().h(22).px(8).items_center().rounded(6).border_1().border_color(t.border).bg(t.raised)
				.child(div().text_size(10.5).text_color(t.muted).child("Current branch")))
			.child(div().flex_1())
			.child(actionButton(t, "pi-keyboard-toggle", "Focus transcript", {
				quiet: true,
				disabled: Boolean(this.composer) || !this.items.some((item) => item.text.trim() && (item.kind !== "tool" || this.expandedTools.has(item.id))),
				onClick: (_event, cx) => this.focusTranscript(cx),
			}).tab_stop(true))
			.when(Boolean(this.sessionId), (row) => row.child(div().text_size(10).text_color(t.dim).child(this.sessionId.slice(0, 8))))
			.child(div().text_size(10.5).text_color(t.dim).child(`${this.items.length} message${this.items.length === 1 ? "" : "s"}`))
			.child(h_flex().gap(5).items_center()
				.child(statusDot(t, color))
				.child(div().text_size(10.5).text_color(color).child(STATUS_LABELS[this.status] ?? this.status)));
	}

	renderConnectionBanner(t, cx) {
		return h_flex()
			.px(18)
			.py(8)
			.gap(8)
			.items_center()
			.flex_none()
			.bg(t.raised)
			.border_b_1()
			.border_color(t.border)
			.child(div().flex_1().text_size(11.5).text_color(t.muted).child(this.connectionError))
			.child(actionButton(t, "pi-reconnect", "Reconnect", {
				onClick: (_event, cx) => this.connect(cx),
			}));
	}

	renderItem(t, cx, item, notes) {
		const expanded = item.kind !== "tool" || this.expandedTools.has(item.id);
		let text = null;
		if (expanded) {
			text = TextView.markdown(`pi-markdown-${item.id}`, item.text)
				.text_size(13.2)
				.text_color(t.foreground)
				.raw_html(false)
				.scrollable(false)
				.selectable(true)
				.on_selection_change((selection, cx) => this.captureSelection(item, selection, cx));
			const selected = notes.find((note) => note.id === this.selectedNoteId);
			for (const note of notes) {
				if (note.id === this.selectedNoteId) continue;
				if (!this.anchorInScope(note.anchor, item.text)) continue;
				text = text.highlight_range(note.anchor.start, note.anchor.end, t.selected);
			}
			if (selected && this.anchorInScope(selected.anchor, item.text)) text = text.highlight_range(selected.anchor.start, selected.anchor.end, t.selection);
			if (this.selection?.itemId === item.id && this.anchorInScope(this.selection, item.text)) {
				text = text.highlight_range(this.selection.start, this.selection.end, t.selection);
			}
			const cursor = this.keyboard?.cursor;
			const cursorRow = cursor && this.keyboard.rows[cursor.row];
			if (cursorRow?.item.id === item.id && cursorRow.item.text === item.text) {
				const start = cursorRow.offsets[cursor.col];
				const end = cursorRow.offsets[cursor.col + 1];
				if (end !== undefined) text = text.highlight_range(start, end, t.solid);
			}
		}
		let tone = t.muted;
		if (item.kind === "user") tone = t.accent;
		if (item.kind === "assistant") tone = t.foreground;
		const tag = itemKindLabel(item);
		return v_flex()
			.id(`pi-item-${item.id}`)
			.w_full()
			.max_w(900)
			.mx_auto()
			.px(18)
			.py(16)
			.gap(8)
			.border_b_1()
			.border_color(t.border)
			.child(h_flex().gap(8).items_center()
				.child(h_flex().h(20).px(6).items_center().rounded(4).bg(t.raised)
					.child(div().text_size(9.5).font_medium().text_color(tone).child(tag)))
				.when(item.kind === "tool", (row) => row.child(div().flex_1().text_size(10.5).text_color(t.dim).truncate().child(item.label)))
				.when(item.kind !== "tool", (row) => row.child(div().flex_1()))
				.when(item.kind === "tool", (row) => row.child(actionButton(t, `pi-tool-toggle-${item.id}`, expanded ? "Hide output" : "Show output", {
					quiet: true,
					onClick: (_event, cx) => {
						if (this.expandedTools.has(item.id)) {
							this.expandedTools.delete(item.id);
							if (this.selection?.itemId === item.id && !this.composer) this.clearSelection(cx);
						} else this.expandedTools.add(item.id);
						this.reflowKeyboard();
						cx.notify();
					},
				}).accessibility_label(`${expanded ? "Hide" : "Show"} ${item.label} output`)))
				.when(notes.length > 0, (row) => row.child(div().text_size(10).text_color(t.muted).child(`${notes.length} note${notes.length === 1 ? "" : "s"}`))))
			.when(expanded, (column) => column.child(text));
	}

	renderTranscript(t, cx, notes) {
		const byItem = new Map();
		for (const note of notes) {
			if (note.anchor === null) continue;
			const list = byItem.get(note.anchor.itemId) ?? [];
			list.push(note);
			byItem.set(note.anchor.itemId, list);
		}
		const empty = v_flex()
			.w_full()
			.max_w(520)
			.mx_auto()
			.mt(60)
			.p(22)
			.gap(6)
			.rounded(10)
			.bg(t.surface)
			.border_1()
			.border_color(t.border)
			.child(div().text_size(13).font_medium().child("No completed messages on this branch yet."))
			.child(div().text_size(11.5).text_color(t.muted).child("The transcript updates as user, assistant, and tool messages finish."));
		return v_flex()
			.id("pi-transcript")
			.track_focus(this.keyboardFocus)
			.tab_stop(true)
			.on_key_down((event, cx) => this.onTranscriptKey(event, cx))
			.on_mouse_down("left", (_event, cx) => {
				if (this.composer) return;
				this.keyboardFocus.focus();
				cx.notify();
			})
			.relative()
			.flex_1()
			.min_w(0)
			.h_full()
			.bg(t.background)
			.on_window_mouse_up("left", (event) => { this.transcriptBounds = event.bounds ?? null; })
			.child(this.renderTranscriptHeader(t))
			.child(h_flex().px(18).py(5).gap(10).items_center().flex_none().bg(t.chrome).border_b_1().border_color(t.border)
				.child(div().text_size(10).font_medium().text_color(this.keyboard?.visual ? t.accent : t.muted).child(this.keyboard?.visual ? "VISUAL" : "NORMAL"))
				.child(div().text_size(10).text_color(t.dim).child("hjkl move · gg/G jump · Ctrl+D/U half page · v select · c comment · Esc cancel selection"))
				.child(div().flex_1())
				.child(div().text_size(10).text_color(t.dim).child(`${chord()} Enter sends pending + message`)))
			.when(Boolean(this.connectionError), (column) => column.child(this.renderConnectionBanner(t, cx)))
			.child(v_flex()
				.id("pi-transcript-scroll")
				.flex_1()
				.min_h(0)
				.overflow_y_scrollbar()
				.track_scroll(this.keyboardScroll)
				.on_size_change((size, cx) => {
					this.dismissSelectionPopup();
					this.dismissLocalComposer(cx);
					this.resizeKeyboard(size, cx);
				})
				.when(this.selectionPopup || this.composerPlacement, (column) => column.on_scroll_wheel((_event, cx) => {
					this.dismissSelectionPopup();
					this.dismissLocalComposer(cx);
				}))
				.py(8)
				.when(this.items.length === 0, (column) => column.child(empty))
				.children(this.items.map((item) => this.renderItem(t, cx, item, byItem.get(item.id) ?? []))))
			.when(this.composerPlacement, (column) => column.child(this.renderLocalComposer(t, cx, this.composerPlacement)));
	}

	renderLocalComposer(t, cx, placement) {
		return Popup.new("pi-local-composer", div().size(1))
			.absolute()
			.left(placement.x)
			.top(placement.y)
			.anchor("top_left")
			.content(v_flex()
				.id("pi-local-composer-card")
				.w(placement.width)
				.rounded(10)
				.overflow_hidden()
				.border_1()
				.border_color(t.border)
				.shadow_lg()
				.on_size_change(() => {
					if (this.composerPlacement !== placement || !placement.needsFocus) return;
					placement.needsFocus = false;
					this.composerState.focus();
				})
				.on_mouse_down_out((_event, cx) => this.dismissLocalComposer(cx))
				.on_key_down((event, cx) => {
					if (event.key !== "escape") return;
					cx.stop_propagation();
					this.dismissLocalComposer(cx);
				})
				.child(this.renderComposer(t, cx)));
	}

	renderBatch(t, cx) {
		const deliverable = this.sendableNotes();
		const staleCount = branchNotes(this.notes, this.items).filter((note) => note.status === "pending").length - deliverable.length;
		const text = this.mainState.value();
		const canAct = this.reviewReady && this.pending.size === 0;
		const attempt = this.currentSendAttempt();
		const canSend = canAct && (attempt || deliverable.length > 0 || text.trim() !== "");
		const sendLabel = this.pending.has("send") ? "Working…" : attempt ? "Check previous send" : `Send to main Pi${deliverable.length ? ` (${deliverable.length})` : ""}`;
		const canStart = canAct && (this.startAttempt || text.trim() !== "");
		return v_flex()
			.gap(7)
			.child(h_flex().items_center().gap(8)
				.child(div().text_size(11.5).font_medium().child("Main Pi"))
				.child(div().text_size(10).text_color(t.dim).child(`${deliverable.length} pending`)))
			.child(div()
				.rounded(7)
				.border_1()
				.border_color(this.mainFocused ? t.accent : t.input)
				.bg(t.background)
				.p(8)
				.child(Textarea.new(this.mainState)
					.w_full()
					.h(76)
					.text_size(12)
					.text_color(t.foreground)))
			.child(h_flex().gap(6).items_center()
				.child(actionButton(t, "pi-send-main", sendLabel, {
					primary: true,
					disabled: !canSend,
					onClick: (_event, cx) => attempt ? this.checkSend(cx) : this.sendMain(cx),
				}))
				.child(actionButton(t, "pi-start-new", this.pending.has("start-new") ? "Working…" : this.startAttempt ? "Check pending start" : "Start independent thread", {
					quiet: true,
					disabled: !canStart,
					onClick: (_event, cx) => this.startUnanchored(cx),
				})))
			.child(div().text_size(10).text_color(t.dim).child(`Enter saves · Shift+Enter adds a line · ${submitHint()} sends to main Pi · ${chord()}+Shift+Enter starts a background thread`))
			.when(attempt && attempt.requestId === this.observedSendRequestId && this.sendReceiptUnknown, (column) => column
				.child(div().text_size(10.5).text_color(t.blocked).child("Check main Pi for the exact previous message before recording what happened."))
				.child(h_flex().gap(6).items_center()
					.child(actionButton(t, "pi-resolve-sent", this.sendResolution === "sent" ? "Confirm it was sent" : "It was sent", {
						disabled: !canAct,
						onClick: (_event, cx) => this.resolveSend(cx, "sent"),
					}))
					.when(!this.sendMayStillArrive, (row) => row.child(actionButton(t, "pi-resolve-not-sent", this.sendResolution === "not-sent" ? "Confirm it was not sent" : "It was not sent", {
						disabled: !canAct,
						onClick: (_event, cx) => this.resolveSend(cx, "not-sent"),
					})))
					.when(this.sendResolution, (row) => row.child(actionButton(t, "pi-cancel-resolution", "Cancel", {
						quiet: true,
						onClick: (_event, cx) => {
							this.sendResolution = null;
							cx.notify();
						},
					})))))
			.when(staleCount > 0, (column) => column.child(div().text_size(10.5).text_color(t.blocked).child(`${staleCount} pending comment${staleCount === 1 ? " was" : "s were"} left out because the original text changed.`)))
			.when(Boolean(this.mainNotice), (column) => column.child(div().text_size(10.5).text_color(t.done).child(this.mainNotice)))
			.when(Boolean(this.mainError), (column) => column.child(div().text_size(10.5).text_color(t.blocked).child(this.mainError)))
			.when(Boolean(this.failures.get("start-new")), (column) => column.child(div().text_size(10.5).text_color(t.blocked).child(this.failures.get("start-new"))));
	}

	renderSelection(t, cx) {
		const scope = this.anchorInScope(this.selection);
		const item = this.items.find((candidate) => candidate.id === this.selection.itemId);
		return v_flex()
			.p(12)
			.gap(8)
			.bg(t.surface)
			.border_b_1()
			.border_color(t.border)
			.child(h_flex().items_center().gap(8)
				.child(div().text_size(11.5).font_medium().child("Selection"))
				.child(div().text_size(10).text_color(t.dim).child(itemKindLabel(item))))
			.child(quoteBlock(t, this.selection, item, false))
			.when(!scope, (column) => column.child(div().text_size(10.5).text_color(t.blocked).child("This selection is no longer on the current branch.")))
			.child(h_flex().items_center().gap(6)
				.child(actionButton(t, "pi-add-comment", "Add comment", {
					primary: true,
					disabled: !scope,
					onClick: (_event, cx) => this.openComposer(cx),
				}))
				.child(div().flex_1())
				.child(actionButton(t, "pi-clear-selection", "Clear", {
					quiet: true,
					onClick: (_event, cx) => this.clearSelection(cx),
				})));
	}

	renderSelectionHint(t) {
		return v_flex()
			.p(12)
			.border_b_1()
			.border_color(t.border)
			.child(div().text_size(11.5).text_color(t.muted).child("Select text in the transcript, then choose Add comment."));
	}

	renderComposer(t, cx) {
		const anchor = this.composer.anchor;
		const item = anchor && this.items.find((candidate) => candidate.id === anchor.itemId);
		const value = this.composerState.value();
		const scope = this.anchorInScope(this.composer.anchor);
		const busy = this.pending.has("save");
		const targetError = this.composerTargetError();
		const error = targetError || this.composerError;
		const disabled = value.trim() === "" || !scope || this.pending.size > 0 || Boolean(targetError);
		const sendPending = Boolean(this.currentSendAttempt());
		return v_flex()
			.p(12)
			.gap(8)
			.bg(t.surface)
			.border_b_1()
			.border_color(t.border)
			.child(h_flex().items_center().gap(8)
				.child(div().text_size(11.5).font_medium().child(this.composer.noteId ? "Edit comment" : "Add comment"))
				.when(this.recovered, (row) => row.child(h_flex().h(18).px(6).items_center().rounded(4).bg(t.raised)
					.child(div().text_size(9.5).text_color(t.muted).child("Recovered draft")))))
			.child(anchor ? quoteBlock(t, anchor, item, true) : div().text_size(10.5).text_color(t.dim).child("Independent conversation copy"))
			.child(div().text_size(10.5).text_color(t.dim).child("Comment"))
			.child(div()
				.rounded(7)
				.border_1()
				.border_color(this.composerFocused ? t.accent : t.input)
				.bg(t.background)
				.p(8)
				.child(Textarea.new(this.composerState)
					.w_full()
					.h(96)
					.text_size(12.5)
					.text_color(t.foreground)))
			.when(!scope, (column) => column.child(div().text_size(10.5).text_color(t.blocked).child("The selection left the current branch. Copy the draft or clear it.")))
			.when(Boolean(error), (column) => column.child(div().text_size(10.5).text_color(t.blocked).child(error)))
			.when(sendPending && !error, (column) => column.child(div().text_size(10.5).text_color(t.blocked).child("Check the previous send before using Save & send.")))
			.child(h_flex().items_center().gap(6)
				.child(actionButton(t, "pi-cancel-comment", "Cancel", {
					quiet: true,
					onClick: (_event, cx) => this.cancelComposer(cx),
				}))
				.child(div().flex_1())
				.child(actionButton(t, "pi-send-comment", "Save & send", {
					quiet: true,
					disabled: disabled || sendPending,
					onClick: (_event, cx) => this.saveThen(cx, "send"),
				}))
				.child(actionButton(t, "pi-start-comment", "Save & start", {
					quiet: true,
					disabled,
					onClick: (_event, cx) => this.saveThen(cx, "start"),
				}))
				.child(actionButton(t, "pi-save-comment", busy ? "Saving…" : "Save comment", {
					primary: true,
					disabled,
					onClick: (_event, cx) => this.saveComposer(cx),
				}).track_focus(this.saveFocus)))
			.child(div().text_size(10).text_color(t.dim).child(`Enter saves only. ${submitHint()} saves then sends. ${chord()}+Shift+Enter saves then starts a background thread. Shift+Enter adds a line.`));
	}

	renderNoteHeader(t, note, phase, expanded) {
		const color = phaseColor(t, phase);
		const turnCount = note.status === "thread" ? note.turns.length : 0;
		const header = v_flex().w_full().gap(4)
			.child(h_flex().items_center().gap(6)
				.child(statusDot(t, color))
				.child(div().text_size(10.5).font_medium().text_color(color).child(PHASE_LABELS[phase] ?? phase))
				.child(div().text_size(10).text_color(t.dim).child("You"))
				.when(turnCount > 0, (row) => row.child(div().text_size(10).text_color(t.dim).child(`${turnCount} turn${turnCount === 1 ? "" : "s"}`)))
				.child(div().flex_1())
				.when(this.pending.has(`thread:${note.id}`), (row) => row.child(div().text_size(10).text_color(t.working).frames(["Working   ", "Working.  ", "Working.. ", "Working..."], 500))))
			.when(!expanded, (column) => column
				.when(note.anchor !== null, (body) => body.child(div().text_size(11.5).text_color(t.muted).truncate().child(inlineClip(note.anchor.quote, 150))))
				.when(note.anchor === null, (body) => body.child(div().text_size(10).text_color(t.dim).child("Independent of the current branch")))
				.child(div().text_size(12).text_color(t.foreground).truncate().child(inlineClip(note.text, 150))));
		return Button.new(`pi-note-${note.id}`)
			.w_full()
			.p(9)
			.rounded(7)
			.border_1()
			.border_color(this.selectedNoteId === note.id ? t.accent : t.border)
			.bg(this.selectedNoteId === note.id ? t.surface : t.raised)
			.hover((style) => style.bg(t.hover))
			.focus((style) => style.border_color(t.accent))
			.on_click((_event, cx) => this.selectNote(note.id, cx))
			.child(header);
	}

	renderPendingActions(t, cx, note) {
		const confirming = this.confirmDeleteId === note.id;
		const failure = this.failures.get(`start:${note.id}`);
		const deleteFailure = this.failures.get(`delete:${note.id}`);
		const busy = this.pending.has(`thread:${note.id}`);
		const disabled = !this.reviewReady || this.pending.size > 0;
		if (confirming) {
			return v_flex().gap(6)
				.child(div().text_size(11).text_color(t.blocked).child("Delete this pending comment?"))
				.child(h_flex().gap(6).items_center()
					.child(actionButton(t, `pi-keep-${note.id}`, "Keep", {
						quiet: true,
						onClick: (_event, cx) => {
							this.confirmDeleteId = null;
							cx.notify();
						},
					}))
					.child(div().flex_1())
					.child(actionButton(t, `pi-confirm-delete-${note.id}`, "Delete comment", {
						destructive: true,
						disabled,
						onClick: (_event, cx) => this.deleteNote(note, cx),
					})))
				.when(Boolean(deleteFailure), (column) => column.child(div().text_size(10.5).text_color(t.blocked).child(deleteFailure)));
		}
		return v_flex().gap(6)
			.child(h_flex().gap(6).items_center()
				.child(actionButton(t, `pi-start-${note.id}`, busy ? "Starting background Pi…" : "Send to background Pi", {
					primary: true,
					disabled,
					onClick: (_event, cx) => this.startThread(note, cx),
				}))
				.child(div().flex_1())
				.child(actionButton(t, `pi-edit-${note.id}`, "Edit comment", {
					quiet: true,
					disabled: !this.reviewReady || this.composer !== null,
					onClick: (_event, cx) => this.editNote(note, cx),
				}))
				.child(actionButton(t, `pi-delete-${note.id}`, "Delete", {
					quiet: true,
					destructive: true,
					disabled,
					onClick: (_event, cx) => this.deleteNote(note, cx),
				})))
			.child(div().text_size(10).text_color(t.dim).child("Runs a read-only Pi in the background with this branch."))
			.when(Boolean(failure), (column) => column.child(div().text_size(10.5).text_color(t.blocked).child(failure)));
	}

	renderTurn(t, turn) {
		let color = t.blocked;
		if (turn.status === "running") color = t.working;
		if (turn.status === "completed") color = t.done;
		const label = TURN_LABELS[turn.status] ?? turn.status;
		let view = v_flex()
			.gap(5)
			.p(8)
			.rounded(6)
			.bg(t.background)
			.border_1()
			.border_color(t.border)
			.child(h_flex().items_center().gap(6)
				.child(statusDot(t, color))
				.child(div().text_size(9.5).font_medium().text_color(color).child(label))
				.child(div().text_size(9.5).text_color(t.dim).child("You")))
			.child(div().text_size(11).text_color(t.muted).whitespace_normal().child(turn.text));
		if (turn.status === "completed") {
			view = view.child(h_flex().items_center().gap(6).pt(2)
				.child(statusDot(t, t.done))
				.child(div().text_size(9.5).font_medium().text_color(t.muted).child("Background Pi")))
				.child(TextView.markdown(`pi-turn-${turn.id}`, turn.reply)
					.text_size(12)
					.text_color(t.foreground)
					.raw_html(false)
					.selectable(true));
		}
		if (turn.status === "running") {
			view = view.child(h_flex().items_center().gap(6)
				.child(div().w(16).text_size(11).text_color(t.working).frames(["·  ", "·· ", "···"], 500))
				.child(div().text_size(10.5).text_color(t.working).child("Background Pi is working.")));
		}
		if (turn.status === "failed" || turn.status === "interrupted") {
			view = view.child(div().text_size(10.5).text_color(t.blocked).child(turn.error))
				.child(div().text_size(10).text_color(t.dim).child("Reply to continue manually on the same background session."));
		}
		return view;
	}

	renderReply(t, cx, note) {
		const running = hasRunningTurn(note);
		const state = this.replyStates.get(note.id);
		if (!state) return div();
		const failure = this.failures.get(`reply:${note.id}`);
		const busy = this.pending.has(`thread:${note.id}`);
		const retry = localStorage.getItem(replyAttemptKey(this.sessionId, note.id)) !== null;
		const disabled = !this.reviewReady || (!retry && (running || state.value().trim() === "")) || this.pending.size > 0;
		let hint = `${chord()}+Shift+Enter runs this reply. ${submitHint()} sends to main Pi.`;
		let label = "Reply and run";
		if (retry) {
			hint = "Retry checks the previous reply. New edits stay here.";
			label = "Retry previous reply";
		} else if (running) hint = "You can draft a reply while Pi runs.";
		if (busy) label = "Starting reply…";
		return v_flex().gap(6).pt(2).border_t_1().border_color(t.border)
			.child(div().text_size(10.5).text_color(t.dim).child("Reply"))
			.child(div()
				.rounded(7)
				.border_1()
				.border_color(this.replyFocused.get(note.id) ? t.accent : t.input)
				.bg(t.background)
				.p(8)
				.child(Textarea.new(state)
					.w_full()
					.h(78)
					.text_size(12)
					.text_color(t.foreground)))
			.when(Boolean(failure), (column) => column.child(div().text_size(10.5).text_color(t.blocked).child(failure)))
			.child(h_flex().items_center().gap(6)
				.child(div().flex_1().text_size(10).text_color(t.dim).child(hint))
				.child(actionButton(t, `pi-reply-${note.id}`, label, {
					primary: true,
					disabled,
					onClick: (_event, cx) => this.runReply(note.id, cx),
				})));
	}

	renderNoteBody(t, cx, note) {
		const item = note.anchor && this.items.find((candidate) => candidate.id === note.anchor.itemId);
		return v_flex()
			.px(10)
			.pb(10)
			.gap(8)
			.when(note.anchor !== null, (column) => column.child(quoteBlock(t, note.anchor, item, true)))
			.when(note.anchor === null, (column) => column.child(div().text_size(10.5).text_color(t.dim).child("Independent conversation copy")))
			.child(v_flex().gap(2)
				.child(div().text_size(10).text_color(t.dim).child("You"))
				.child(div().text_size(12).text_color(t.foreground).child(note.text)))
			.when(note.status === "pending", (column) => column.child(this.renderPendingActions(t, cx, note)))
			.when(note.status === "sent", (column) => column.child(div().text_size(10.5).text_color(t.done).child("Sent to main Pi.")))
			.when(note.status === "appended", (column) => column.child(div().text_size(10.5).text_color(t.done).child("Appended to the original Pi input. Review and send it there.")))
			.when(note.status === "thread", (column) => column.children(note.turns.map((turn) => this.renderTurn(t, turn))).child(this.renderCopy(t, cx, note)).child(this.renderReply(t, cx, note)));
	}

	renderCopy(t, cx, note) {
		const completed = completedTurns(note);
		const failure = this.failures.get(`copy:${note.id}`);
		return v_flex().gap(5).pt(3)
			.child(h_flex().items_center().gap(6)
				.child(actionButton(t, `pi-copy-${note.id}`, "Add to main Pi drafts", {
					quiet: true,
					disabled: !this.reviewReady || completed === 0 || this.pending.size > 0,
					onClick: (_event, cx) => this.copyThread(note, cx),
				}))
				.child(div().flex_1())
				.child(div().text_size(10).text_color(t.dim).child("Includes completed exchanges and the original comment. The original thread stays unchanged.")))
			.when(Boolean(failure), (column) => column.child(div().text_size(10.5).text_color(t.blocked).child(failure)));
	}

	renderNote(t, cx, note) {
		const expanded = this.selectedNoteId === note.id;
		return v_flex()
			.id(`pi-note-card-${note.id}`)
			.rounded(7)
			.border_1()
			.border_color(expanded ? t.accent : t.border)
			.bg(expanded ? t.surface : t.chrome)
			.child(this.renderNoteHeader(t, note, notePhase(note), expanded))
			.when(expanded, (column) => column.child(this.renderNoteBody(t, cx, note)));
	}

	renderNotes(t, cx, notes, panel) {
		const off = offBranchCount(this.notes, this.items);
		const background = panel === "background";
		const empty = v_flex()
			.p(12)
			.gap(5)
			.rounded(8)
			.bg(t.surface)
			.border_1()
			.border_color(t.border)
			.child(div().text_size(11.5).font_medium().child(background ? "No background threads yet." : "No comments yet."))
			.child(div().text_size(10.5).text_color(t.muted).child(background ? "Start one from a pending comment or from the main message box." : "Select a message, then choose Add comment."));
		return v_flex()
			.id(background ? "pi-background-scroll" : "pi-main-scroll")
			.flex_1()
			.min_h(0)
			.overflow_y_scrollbar()
			.child(v_flex()
				.w_full()
				.p(10)
				.gap(8)
				.child(h_flex().items_center().gap(6)
					.child(div().text_size(11).font_semibold().child(background ? "Background threads" : "Comments"))
					.child(div().text_size(10).text_color(t.dim).child(`${notes.length} on this branch`)))
				.when(notes.length === 0, (column) => column.child(empty))
				.children(notes.map((note) => this.renderNote(t, cx, note)))
				.when(off > 0 && !background, (column) => column.child(div().pt(2).text_size(10).text_color(t.dim).child(`${off} saved note${off === 1 ? "" : "s"} on other branches stay stored and are hidden here.`))));
	}

	renderSidebar(t, cx, notes) {
		return v_flex()
			.w(380)
			.min_w(320)
			.max_w(460)
			.h_full()
			.flex_none()
			.bg(t.chrome)
			.border_l_1()
			.border_color(t.border)
			.child(v_flex()
				.p(12)
				.gap(8)
				.border_b_1()
				.border_color(t.border)
				.child(h_flex().items_center().gap(8)
					.child(div().text_size(13).font_semibold().child("Pi conversations"))
					.child(div().text_size(10).text_color(t.muted).child(`${notes.length} visible`))
					.child(div().flex_1())
					.when(Boolean(this.sessionId), (row) => row.child(div().text_size(10).text_color(t.dim).child(this.sessionId.slice(0, 8)))))
				.child(this.renderBatch(t, cx))
				.when(Boolean(this.reviewError), (column) => column.child(v_flex().gap(4)
					.child(div().text_size(10.5).text_color(t.blocked).child(this.reviewError))
					.child(actionButton(t, "pi-retry-review", "Retry comments", {
						quiet: true,
						onClick: (_event, cx) => this.refreshReview(cx, true),
					})))))
			.when(this.composer && !this.composerPlacement, (column) => column.child(this.renderComposer(t, cx)))
			.when(!this.composer && this.selection, (column) => column.child(this.renderSelection(t, cx)))
			.when(!this.composer && !this.selection, (column) => column.child(this.renderSelectionHint(t)))
			.child(this.renderNotes(t, cx, panelNotes(this.notes, this.items, "main"), "main"))
			.child(this.renderNotes(t, cx, panelNotes(this.notes, this.items, "background"), "background"));
	}

	renderConnection(t, cx) {
		const color = statusColor(t, this.status);
		const connecting = this.status === "connecting";
		return v_flex()
			.size_full()
			.bg(t.canvas)
			.items_center()
			.justify_center()
			.p(30)
			.child(v_flex()
				.w(470)
				.gap(12)
				.p(22)
				.rounded(10)
				.bg(t.surface)
				.border_1()
				.border_color(t.border)
				.child(div().text_size(16).font_semibold().child("Pi annotations"))
				.child(h_flex().items_center().gap(6)
					.child(statusDot(t, color))
					.when(connecting, (row) => row.child(div().text_size(11.5).text_color(color).frames(["Connecting   ", "Connecting.  ", "Connecting.. ", "Connecting..."], 500)))
					.when(!connecting, (row) => row.child(div().text_size(11.5).text_color(color).child("This tab is not connected to its Pi session."))))
				.when(Boolean(this.connectionError), (column) => column.child(div().text_size(11.5).text_color(t.blocked).child(this.connectionError)))
				.when(this.status === "error", (column) => column.child(actionButton(t, "pi-reconnect", "Reconnect", {
					primary: true,
					onClick: (_event, cx) => this.connect(cx),
				})))
				.child(div().text_size(10.5).text_color(t.dim).child("Reopen this tab from Pi with /annotate-herdr.")));
	}

	render(cx) {
		const t = theme();
		if (this.commentPopup) {
			return div().size_full().p(4).bg(t.popover).rounded(8)
				.child(actionButton(t, "pi-add-selection-comment", "Add comment", {
					primary: true,
					onClick: () => {
						this.popupAccepted = true;
						closeOverlay(this.popupOverlay);
					},
				}).w_full());
		}
		if (!this.preview && !this.connection) return this.renderConnection(t, cx);
		const notes = branchNotes(this.notes, this.items);
		return h_flex()
			.id("pi-annotate-root")
			.size_full()
			.min_h(0)
			.overflow_hidden()
			.bg(t.background)
			.text_color(t.foreground)
			.child(this.renderTranscript(t, cx, notes))
			.child(this.renderSidebar(t, cx, notes));
	}
}
