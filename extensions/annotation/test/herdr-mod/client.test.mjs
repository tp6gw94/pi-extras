import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, fetchEvents, fetchReview, loopbackUrl, postReview } from "../../herdr-mod/client.js";

const connection = { sessionId: "session/one", port: 4747, token: "secret-token" };

function reply(status, body) {
	return {
		ok: status >= 200 && status < 300,
		status,
		text: async () => JSON.stringify(body),
	};
}

test("loopback URLs keep the session path encoded and stay on 127.0.0.1", () => {
	assert.equal(loopbackUrl(connection, "review"), "http://127.0.0.1:4747/session%2Fone/api/review");
	assert.equal(loopbackUrl(connection, "events", { after: 7 }), "http://127.0.0.1:4747/session%2Fone/api/events?after=7");
});

test("review reads authenticate with the source token", async () => {
	let seen;
	const fetchImpl = async (url, init) => {
		seen = { url, init };
		return reply(200, { notes: [] });
	};
	assert.deepEqual(await fetchReview(connection, fetchImpl), { notes: [] });
	assert.equal(seen.url, "http://127.0.0.1:4747/session%2Fone/api/review");
	assert.equal(seen.init.method, "GET");
	assert.equal(seen.init.headers["x-annotate-token"], "secret-token");
	assert.equal(seen.init.body, undefined);
});

test("events send the last version and mutations send JSON", async () => {
	const calls = [];
	const fetchImpl = async (url, init) => {
		calls.push({ url, init });
		return reply(200, { version: 2, reset: false, items: [] });
	};
	await fetchEvents(connection, 1, fetchImpl);
	assert.equal(calls[0].url, "http://127.0.0.1:4747/session%2Fone/api/events?after=1");
	const body = { action: "reply", noteId: "n1", text: "more" };
	await postReview(connection, body, fetchImpl);
	assert.equal(calls[1].url, "http://127.0.0.1:4747/session%2Fone/api/review");
	assert.equal(calls[1].init.method, "POST");
	assert.equal(calls[1].init.headers["content-type"], "application/json");
	assert.deepEqual(JSON.parse(calls[1].init.body), body);
});

test("server refusals surface their message and status", async () => {
	const fetchImpl = async () => reply(409, { error: "a turn is already running in this thread" });
	await assert.rejects(
		postReview(connection, { action: "reply", noteId: "n1", text: "more" }, fetchImpl),
		(error) => {
			assert.ok(error instanceof ApiError);
			assert.equal(error.status, 409);
			assert.equal(error.message, "a turn is already running in this thread");
			return true;
		},
	);
});

test("network failures name the loopback port and never echo the token", async () => {
	const fetchImpl = async () => {
		throw new Error("connect ECONNREFUSED");
	};
	await assert.rejects(fetchReview(connection, fetchImpl), (error) => {
		assert.ok(error instanceof ApiError);
		assert.equal(error.status, 0);
		assert.match(error.message, /4747/);
		assert.equal(error.message.includes("secret-token"), false);
		return true;
	});
});
