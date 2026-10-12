import { ToolMessage } from "@langchain/core/messages";

function clip(value, limit) {
    const text = String(value ?? "");
    return text.length > limit ? `${text.slice(0, limit)}… [omitted]` : text;
}

function observedHref(value, pageUrl) {
    const url = new URL(value, pageUrl);
    return url.origin === new URL(pageUrl).origin
        ? `${url.pathname}${url.search}${url.hash}` : url.href;
}

export function compactSnapshot(snapshot, task, window = {}, limits = { elements: 2000, text: 1200 }) {
    if (!snapshot) return "none";
    const terms = new Set((task.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []));
    const relevant = (text) => [...terms].some((term) => text.toLowerCase().includes(term));
    const elements = snapshot.elements ?? [];
    const offset = window.elementOffset ?? 0;
    const candidates = elements.slice(offset).map((element, index) => ({
        element,
        index,
        priority: element.risk || ["input", "select", "textarea", "button"].includes(element.role)
            ? 2 : relevant(element.name ?? "") ? 1 : 0,
    }));
    if (!offset) candidates.sort((left, right) => right.priority - left.priority || left.index - right.index);

    const lines = [];
    let size = 0;
    for (const { element } of candidates) {
        const line = `[${element.ref}] ${element.role} ${JSON.stringify(element.name)}${element.type ? ` ${element.type}` : ""}${element.value ? ` value=${JSON.stringify(element.value)}` : ""}${element.checked === null || element.checked === undefined ? "" : ` checked=${element.checked}`}${element.disabled ? " disabled" : ""}${element.readOnly ? " readonly" : ""}${element.risk ? ` risk=${element.risk}` : ""}${element.href ? ` href=${observedHref(element.href, snapshot.url)}` : ""}${element.options ? ` options=${JSON.stringify(element.options.map(({ value, label, disabled }) => ({ value, label, ...(disabled ? { disabled: true } : {}) })))}` : ""}`;
        if (size + line.length > limits.elements && lines.length) break;
        lines.push(line);
        size += line.length;
    }

    const text = snapshot.text ?? "";
    const textOffset = window.textOffset;
    const blocks = text.match(/[^.!?]+[.!?]*/g) ?? [text];
    const important = blocks.filter((block) => relevant(block) ||
        /refund|policy|sold out|postpon|closed|remaining|total|price|limit|conflict|confirm|cancel|error|invalid/i.test(block));
    const visibleText = textOffset === undefined
        ? clip([...new Set([...important, ...blocks])].join(" "), limits.text)
        : clip(text.slice(textOffset), limits.text);
    const omitted = lines.length < candidates.length || text.length > limits.text || snapshot.truncated;

    return [
        `URL: ${snapshot.url} | ${snapshot.title}`,
        `SITE TIME: ${snapshot.siteTime || "Unavailable"}`,
        `ALERTS: ${(snapshot.alerts ?? []).join(" | ") || "none"}`,
        `TEXT: ${visibleText}`,
        "TARGETS:",
        ...lines,
        ...(omitted ? [`Partial view: ${elements.length} targets, ${text.length} text characters. Use browser_snapshot(textOffset, elementOffset) to inspect omitted details before deciding.`] : []),
    ].join("\n");
}

export function compactObservation(observation, limit = 3500) {
    const { snapshot, records, ...facts } = observation;
    if (snapshot) facts.snapshot = "see current page";
    if (records) {
        let remaining = limit;
        facts.records = records.map((record) => {
            const text = JSON.stringify(record);
            if (text.length <= remaining) {
                remaining -= text.length;
                return record;
            }
            facts.detailsOmitted = true;
            return {
                _id: record._id,
                ...(record.code ? { code: record.code } : {}),
                ...(record.matchId ? { matchId: record.matchId } : {}),
                ...(record.status ? { status: record.status } : {}),
                omittedFields: Object.keys(record).filter((key) => !["_id", "code", "matchId", "status"].includes(key)),
            };
        });
        if (facts.detailsOmitted) facts.observation = "Some record fields omitted. Query relevant IDs with a narrow projection before making claims about those fields.";
    }
    return facts;
}

export function compactHistory(messages, maxPairs = 2) {
    // Keep at most two complete tool-call/result pairs. Full observations remain in the trace.
    const pairs = [];
    for (let index = 0; index < messages.length - 1; index += 1) {
        const message = messages[index];
        const result = messages[index + 1];
        if (message.tool_calls?.length === 1 && result.tool_call_id === message.tool_calls[0].id) {
            pairs.push([message, result]);
            index += 1;
        }
    }
    if (!maxPairs) return [];
    return pairs.slice(-maxPairs).flatMap(([call, result]) => {
        let observation;
        try {
            observation = compactObservation(JSON.parse(result.content), 600);
        } catch {
            observation = { observation: clip(result.content, 600), detailsOmitted: true };
        }
        return [call, new ToolMessage({
            content: JSON.stringify(observation),
            tool_call_id: result.tool_call_id,
            name: result.name,
        })];
    });
}

export function snapshotReadKey(snapshot, window = {}) {
    if (!snapshot) return null;
    // Refs refresh on every read; compare the visible facts rather than ref numbers.
    return JSON.stringify({
        url: snapshot.url, siteTime: snapshot.siteTime, alerts: snapshot.alerts,
        text: snapshot.text, truncated: snapshot.truncated, window,
        elements: (snapshot.elements ?? []).map(({ ref, ...facts }) => facts),
    });
}

export function compactVerification(verification) {
    // Passed checks add nothing; keep failures plus the facts needed to summarize the outcome.
    const [entry] = verification.actions ?? [];
    return clip(JSON.stringify({
        success: verification.success,
        ...(verification.success ? {} : {
            failedChecks: (verification.checks ?? []).filter((check) => !check.passed).map((check) => check.name),
        }),
        action: entry?.action,
        records: entry?.records,
        outbox: entry?.outbox?.map(({ subject, body }) => ({ subject, body })),
    }), 2500);
}

export function compactReadEvidence(evidence = [], count = 6) {
    return JSON.stringify(evidence.slice(-count).map(({ args, observation }) => ({
        query: { collection: args.collection, filter: clip(args.filter, 150) },
        observation: clip(JSON.stringify(observation), 450),
    })));
}

export function selectAgentTools(state, registry, finalTurn = false) {
    if (finalTurn) return registry.tools.filter((entry) => entry.name === "finish");
    if ((state.unchangedReadCount ?? 0) >= 3)
        return registry.tools.filter((entry) => ["finish", "ask_human"].includes(entry.name));
    if (registry.cancellationWorkflow && !state.hasAction) {
        const status = state.cancellationQuote?.status;
        if (!status)
            return registry.tools.filter((entry) => entry.name === "prepare_cancellation");
        if (status !== "ready")
            return registry.tools.filter((entry) =>
                ["prepare_cancellation", "ask_human", "finish", "db_query"].includes(entry.name));
        return registry.tools.filter((entry) => ["prepare_cancellation", "browser_goto",
            "browser_snapshot", "browser_click", "browser_check", "request_approval", "finish"].includes(entry.name));
    }
    const names = new Set(["db_query", "ask_human", "remember", "finish", "browser_goto"]);
    const snapshot = state.latestSnapshot;
    if (snapshot || state.recoveryActive) {
        ["browser_snapshot", "browser_back", "browser_screenshot"].forEach((name) => names.add(name));
        const elements = snapshot?.elements;
        if (!elements || snapshot.truncated || state.recoveryActive) return registry.tools;
        if (elements.some((element) => ["a", "button", "link"].includes(element.role) ||
            ["submit", "button"].includes(element.type))) names.add("browser_click");
        if (elements.some((element) => element.risk === "irreversible")) names.add("request_approval");
        const editable = elements.filter((element) => !element.disabled && !element.readOnly);
        if (editable.some((element) => element.role === "textarea" ||
            element.role === "input" && ["text", "email", "tel", "number", "search", "url"].includes(element.type))) names.add("browser_fill");
        if (editable.some((element) => element.role === "select")) names.add("browser_select");
        if (editable.some((element) => element.type === "checkbox")) names.add("browser_check");
        if (["browser_fill", "browser_select", "browser_check"].some((name) => names.has(name))) names.add("browser_batch");
    }
    if (state.verification?.success) {
        return registry.tools.filter((entry) =>
            ["finish", "ask_human", "db_query", "browser_snapshot", "browser_screenshot"].includes(entry.name));
    }
    return registry.tools.filter((entry) => names.has(entry.name));
}
