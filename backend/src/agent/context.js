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

export function compactSnapshot(snapshot, task, window = {}) {
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
        if (size + line.length > 2000 && lines.length) break;
        lines.push(line);
        size += line.length;
    }

    const text = snapshot.text ?? "";
    const textOffset = window.textOffset;
    const blocks = text.match(/[^.!?]+[.!?]*/g) ?? [text];
    const important = blocks.filter((block) => relevant(block) ||
        /refund|policy|sold out|postpon|closed|remaining|total|price|limit|conflict|confirm|cancel|error|invalid/i.test(block));
    const visibleText = textOffset === undefined
        ? clip([...new Set([...important, ...blocks])].join(" "), 1200)
        : clip(text.slice(textOffset), 1200);
    const omitted = lines.length < candidates.length || text.length > 1200 || snapshot.truncated;

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

export function compactHistory(messages) {
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
    return pairs.slice(-2).flatMap(([call, result], index, recent) => {
        if (index === recent.length - 1) return [call, result];
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

export function selectAgentTools(state, registry, finalTurn = false) {
    if (finalTurn) return registry.tools.filter((entry) => entry.name === "finish");
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
