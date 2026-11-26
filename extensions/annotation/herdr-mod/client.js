export class ApiError extends Error {
	constructor(message, status = 0) {
		super(message);
		this.name = "ApiError";
		this.status = status;
	}
}

export function loopbackUrl(connection, route, query) {
	const suffix = query && Object.keys(query).length > 0 ? `?${new URLSearchParams(query)}` : "";
	return `http://127.0.0.1:${connection.port}/${encodeURIComponent(connection.sessionId)}/api/${route}${suffix}`;
}

export async function request(connection, route, options = {}, fetchImpl = fetch) {
	const method = options.method ?? "GET";
	const headers = { "x-annotate-token": connection.token };
	const init = { method, headers };
	if (options.body !== undefined) {
		headers["content-type"] = "application/json";
		init.body = JSON.stringify(options.body);
	}
	let response;
	try {
		response = await fetchImpl(loopbackUrl(connection, route, options.query), init);
	} catch {
		throw new ApiError(`Could not reach the Pi annotation server on loopback port ${connection.port}.`, 0);
	}
	let text;
	try {
		text = await response.text();
	} catch {
		throw new ApiError(`The Pi annotation server on loopback port ${connection.port} closed the response.`, response.status);
	}
	let body;
	try {
		body = text === "" ? null : JSON.parse(text);
	} catch {
		body = null;
	}
	if (!response.ok) {
		const message = body && typeof body.error === "string" && body.error !== ""
			? body.error
			: `The Pi annotation server returned HTTP ${response.status}.`;
		throw new ApiError(message, response.status);
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		throw new ApiError("The Pi annotation server returned an invalid response.", response.status);
	}
	return body;
}

export function fetchSnapshot(connection, fetchImpl = fetch) {
	return request(connection, "snapshot", {}, fetchImpl);
}

export function fetchEvents(connection, after, fetchImpl = fetch) {
	return request(connection, "events", { query: { after: String(after) } }, fetchImpl);
}

export function fetchReview(connection, fetchImpl = fetch) {
	return request(connection, "review", {}, fetchImpl);
}

export function postReview(connection, body, fetchImpl = fetch) {
	return request(connection, "review", { method: "POST", body }, fetchImpl);
}
