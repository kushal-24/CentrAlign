import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tool } from "@langchain/core/tools";
import { isGraphInterrupt } from "@langchain/langgraph";
import { z } from "zod";
import { allowedUrl, navigationFailure } from "./navigation.js";
import { takeSnapshot, resolveRef } from "./snapshot.js";
import { approveClick } from "./riskGate.js";
import { safeTaskId } from "./sessions.js";

const reference = z.number().int().positive();
export const browserSchemas = {
    browser_batch: z.object({
        actions: z.array(z.discriminatedUnion("type", [
            z.object({ type: z.literal("fill"), ref: reference, text: z.string().max(2000) }).strict(),
            z.object({ type: z.literal("select"), ref: reference, option: z.string().max(500) }).strict(),
            z.object({ type: z.literal("check"), ref: reference, checked: z.boolean() }).strict(),
        ])).min(1).max(12),
    }).strict(),
    browser_goto: z.object({ url: z.string().min(1).max(2000) }).strict(),
    browser_snapshot: z.object({
        textOffset: z.number().int().min(0).max(10000).optional(),
        elementOffset: z.number().int().min(0).max(179).optional(),
    }).strict(),
    browser_click: z.object({ ref: reference }).strict(),
    browser_fill: z.object({ ref: reference, text: z.string().max(2000) }).strict(),
    browser_select: z.object({ ref: reference, option: z.string().max(500) }).strict(),
    browser_check: z.object({ ref: reference, checked: z.boolean() }).strict(),
    browser_back: z.object({}).strict(),
    browser_screenshot: z
        .object({ label: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,59}$/) })
        .strict(),
};
const evidenceRoot = fileURLToPath(new URL("../../../evidence/", import.meta.url));

export function createBrowserTools(manager, taskId, options = {}) {
    safeTaskId(taskId);
    const observedUrls = new Set();
    const entryPages = new Set(["/", "/matches", "/bookings", "/profile", "/inbox"]);

    function rememberUrls(snapshot, session) {
        if (!snapshot) return;
        for (const value of [snapshot.url, ...(snapshot.elements ?? []).map((element) => element.href)]) {
            if (!value) continue;
            try {
                const url = new URL(allowedUrl(value, session.siteUrl));
                url.hash = "";
                observedUrls.add(url.href);
            } catch {
                // Observing a link does not grant permission to cross the website boundary.
            }
        }
    }

    function navigationTarget(value, session) {
        rememberUrls(session.latestSnapshot, session);
        const requested = new URL(value, session.siteUrl);
        const base = new URL(session.siteUrl);
        let target;
        try {
            target = allowedUrl(requested.href, session.siteUrl);
        } catch (error) {
            const guessedDetail = requested.origin === base.origin &&
                !requested.username && !requested.password &&
                !requested.pathname.includes("%") &&
                !/^\/(?:admin|tasks|health)(?:\/|$)/i.test(requested.pathname) &&
                /(?:^|\/)[a-f\d]{24}(?:\/|$)/i.test(requested.pathname);
            if (!guessedDetail) throw error;
            // An ID is not an observed route. Inspect an entry page instead of inventing a path.
        }
        const normalized = new URL(requested);
        normalized.hash = "";
        if (target && (entryPages.has(requested.pathname.replace(/\/$/, "") || "/") ||
            observedUrls.has(normalized.href))) return { url: target };

        const listing = requested.pathname.startsWith("/bookings/") ? "/bookings" : "/matches";
        return {
            url: allowedUrl(listing, session.siteUrl),
            requestedUrl: requested.href,
            observation: "Requested detail URL was not observed. Opened a known listing instead; use its actual href or click reference to reach the target. No detail route was constructed.",
        };
    }

    function browserFailure(error, session, name) {
        if (session?.navigationFailure) return session.navigationFailure;
        if (error.code === "NAVIGATION_POLICY")
            return { code: error.code, message: error.message, terminal: true };
        if (["browser_goto", "browser_back"].includes(name) && /timeout/i.test(error.message))
            return navigationFailure(error);
        if (/net::ERR_|ECONNREFUSED|ENOTFOUND/i.test(error.message))
            return navigationFailure(error);
        return { code: "BROWSER_ACTION_FAILED", message: error.message, terminal: false };
    }

    async function runBatch(args) {
        const parsed = browserSchemas.browser_batch.safeParse(args);
        if (!parsed.success) return { success: false, observation: "Invalid batch arguments." };
        const session = manager.getSession(taskId);
        if (session.busy || session.pending)
            return { success: false, observation: "Browser busy or approval pending." };

        // No clicks or interrupts inside a batch: resume cannot replay earlier form edits.
        session.busy = true;
        const completed = [];
        let observation = "Stable form batch completed.";
        let success = true;
        let failure = null;
        session.navigationFailure = null;
        session.navigationRetries = 0;
        session.blockedNavigation = false;
        try {
            // Genuine navigation = main-frame navigation (epoch), URL change, or a new alert.
            // Same-page React re-renders (text, totals, replaced nodes) are tolerated.
            const pageState = () => session.page.evaluate(() => JSON.stringify({
                url: location.href,
                alerts: Array.from(document.querySelectorAll('[role="alert"]'))
                    .map((element) => element.innerText),
            }));
            // Identity of each target, used to re-acquire it if a re-render replaces the node.
            const identify = (element) => {
                const attr = (name) => element.getAttribute(name) ?? "";
                return { tag: element.tagName, type: attr("type"), name: attr("name"),
                    id: element.id, label: attr("aria-label"), placeholder: attr("placeholder") };
            };
            const identities = new Map();
            for (const action of parsed.data.actions) {
                if (identities.has(action.ref)) continue;
                const entry = session.refs.get(action.ref);
                if (!entry || entry.epoch !== session.epoch)
                    throw new Error("Stale or missing reference. Take a fresh snapshot.");
                identities.set(action.ref, await entry.handle.evaluate(identify).catch(() => null));
            }
            const acquire = async (ref) => {
                try {
                    return await resolveRef(session, ref);
                } catch (error) {
                    const identity = identities.get(ref);
                    if (!identity || !identity.name && !identity.id && !identity.label && !identity.placeholder) throw error;
                    // Re-render replaced the node: find it again only if exactly one control matches.
                    const found = await session.page.evaluateHandle(({ identity, ref }) => {
                        const attr = (element, name) => element.getAttribute(name) ?? "";
                        const matches = Array.from(document.querySelectorAll(identity.tag.toLowerCase()))
                            .filter((element) => attr(element, "type") === identity.type &&
                                attr(element, "name") === identity.name && element.id === identity.id &&
                                attr(element, "aria-label") === identity.label &&
                                attr(element, "placeholder") === identity.placeholder);
                        if (matches.length !== 1) return null;
                        matches[0].setAttribute("data-ref", ref);
                        return matches[0];
                    }, { identity, ref });
                    const element = found.asElement();
                    if (!element) { await found.dispose(); throw error; }
                    const previous = session.refs.get(ref);
                    await previous?.handle.dispose().catch(() => {});
                    session.refs.set(ref, { handle: element, epoch: session.epoch });
                    return resolveRef(session, ref);
                }
            };
            const initialState = await pageState();
            const epoch = session.epoch;
            for (const action of parsed.data.actions) {
                if (session.epoch !== epoch || await pageState() !== initialState)
                    throw new Error("Page changed during batch. Inspect fresh observations.");
                const handle = await acquire(action.ref);
                const safe = await handle.evaluate((element, action) => {
                    if (element.readOnly || element.getAttribute("data-risk") === "irreversible") return false;
                    if (action.type === "fill") return element.tagName === "TEXTAREA" ||
                        element.tagName === "INPUT" && ["text", "email", "tel", "number", "search", "url"].includes(element.type);
                    if (action.type === "check") return element.tagName === "INPUT" && element.type === "checkbox";
                    return element.tagName === "SELECT" && Array.from(element.options).some(
                        (option) => option.value === action.option && !option.disabled && !option.closest("optgroup[disabled]"));
                }, action);
                if (!safe) throw new Error("Batch target is not a supported stable form control.");
                if (action.type === "fill") await handle.fill(action.text);
                else if (action.type === "select") await handle.selectOption(action.option);
                else await handle.setChecked(action.checked);
                completed.push(action.ref);
                const applied = await (await acquire(action.ref)).evaluate((element, action) =>
                    action.type === "check" ? element.checked === action.checked :
                        element.value === (action.type === "fill" ? action.text : action.option), action);
                if (!applied) throw new Error("Form value did not match the requested batch action.");
                if (session.epoch !== epoch || await pageState() !== initialState)
                    throw new Error("Page changed during batch. Remaining actions were stopped.");
            }
        } catch (error) {
            success = false;
            observation = error.message;
            failure = browserFailure(error, session);
        }
        try {
            const snapshot = await takeSnapshot(session).catch(() => null);
            rememberUrls(snapshot, session);
            return {
                success: success && Boolean(snapshot),
                observation: snapshot ? observation : "Batch stopped; fresh browser observation unavailable.",
                completed,
                browserFailure: failure ?? (snapshot ? null : {
                    code: "OBSERVATION_UNAVAILABLE", message: "Fresh browser observation unavailable.", terminal: true,
                }),
                snapshot,
            };
        } finally {
            session.busy = false;
        }
    }

    async function runTool(name, args) {
        if (name === "browser_batch") return runBatch(args);
        const parsed = browserSchemas[name]?.safeParse(args);
        if (!parsed?.success) return { success: false, observation: "Invalid tool arguments." };
        let session;
        let ownsLock = false;
        let actionStarted = false;
        let navigation = null;

        try {
            session = manager.getSession(taskId);
            if (session.busy) throw new Error("Another browser tool is running for this task.");
            if (session.pending && name !== "browser_click")
                throw new Error(
                    "An approval is pending. Resume or reject it before using another tool.",
                );
            session.busy = true;
            ownsLock = true;
            session.blockedNavigation = false;
            session.navigationFailure = null;
            session.navigationRetries = 0;
            session.dialogOutcome = null;
            const { page } = session;
            const input = parsed.data;

            if (name === "browser_goto") {
                navigation = navigationTarget(input.url, session);
                await page.goto(navigation.url, {
                    waitUntil: "domcontentloaded",
                });
            } else if (name === "browser_fill") {
                const handle = await resolveRef(session, input.ref);
                const editable = await handle.evaluate(
                    (element) =>
                        !element.readOnly &&
                        (element.tagName === "TEXTAREA" ||
                            (element.tagName === "INPUT" &&
                                ["text", "email", "tel", "number", "search", "url"].includes(
                                    element.type,
                                ))),
                );
                if (!editable)
                    throw new Error("Reference is not a supported editable text control.");
                await handle.fill(input.text);
            } else if (name === "browser_select") {
                const handle = await resolveRef(session, input.ref);
                const suitable = await handle.evaluate(
                    (element, option) =>
                        element.tagName === "SELECT" &&
                        Array.from(element.options).some(
                            (entry) =>
                                entry.value === option &&
                                !entry.disabled &&
                                !entry.closest("optgroup[disabled]"),
                        ),
                    input.option,
                );
                if (!suitable)
                    throw new Error("Reference or option is not a selectable enabled option.");
                await handle.selectOption(input.option);
            } else if (name === "browser_check") {
                const handle = await resolveRef(session, input.ref);
                if (
                    !(await handle.evaluate(
                        (element) => element.tagName === "INPUT" && element.type === "checkbox",
                    ))
                )
                    throw new Error("Reference is not a checkbox.");
                await handle.setChecked(input.checked);
            } else if (name === "browser_click") {
                const approved = await approveClick(session, input.ref, options.verifier);
                const handle = await resolveRef(session, input.ref);
                const clickable = await handle.evaluate((element) =>
                    element.matches(
                        'a[href],button,input[type="submit"],input[type="button"],[role="button"],[role="link"]',
                    ),
                );
                if (!clickable)
                    throw new Error(
                        "Reference is not a clickable control. Use fill, select or check.",
                    );
                const target = await handle.evaluate(
                    (element) => element.getAttribute("target") || element.formTarget || "",
                );
                if (target && target !== "_self")
                    throw new Error("Popup navigation is not supported. Use the owned task page.");
                session.approvedClick = approved;
                actionStarted = true;
                await handle.click();
            } else if (name === "browser_back") {
                await page.goBack({ waitUntil: "domcontentloaded" });
                if (page.url() !== "about:blank") allowedUrl(page.url(), session.siteUrl);
            } else if (name === "browser_screenshot") {
                const directory = join(evidenceRoot, taskId);
                await mkdir(directory, { recursive: true });
                const path = join(directory, `${input.label}-${randomUUID()}.png`);
                await page.screenshot({ path, fullPage: true });
                return {
                    success: true,
                    observation: "Screenshot saved.",
                    path,
                    snapshot: session.latestSnapshot,
                };
            }

            const snapshot = await takeSnapshot(session);
            rememberUrls(snapshot, session);
            return {
                success: !session.blockedNavigation && !session.navigationFailure,
                browserFailure: session.navigationFailure,
                ...(name === "browser_snapshot" ? { observationWindow: input } : {}),
                ...(navigation?.requestedUrl ? {
                    requestedUrl: navigation.requestedUrl,
                    actualUrl: snapshot.url,
                    usedListingFallback: true,
                } : {}),
                approvedAction: actionStarted && session.approvedClick,
                observation: session.blockedNavigation
                    ? "Navigation was blocked by the website boundary."
                    : navigation?.observation
                      ? navigation.observation
                      : session.dialogOutcome
                      ? `Action completed; dialog ${session.dialogOutcome}. Inspect the snapshot for the site outcome.`
                      : "Tool completed. Inspect the snapshot for the site outcome.",
                snapshot,
            };
        } catch (error) {
            if (isGraphInterrupt(error)) throw error;
            return {
                success: false,
                actionStopped: Boolean(error.actionStopped) || actionStarted,
                browserFailure: browserFailure(error, session, name),
                observation: actionStarted
                    ? "Click outcome may be uncertain. Inspect a fresh snapshot before any further action; do not repeat the submission."
                    : session?.navigationFailure?.message ?? error.message,
                snapshot: session ? await takeSnapshot(session).catch(() => null) : null,
            };
        } finally {
            if (ownsLock) {
                session.approvedClick = false;
                session.busy = false;
            }
        }
    }

    const tools = [
        tool(async (args) => JSON.stringify(await runTool("browser_batch", args)), {
            name: "browser_batch",
            description: "Sequentially fill/select/check stable controls from the current snapshot. No clicks. Stops on failure or page changes and returns fresh observations; never replay the whole partial batch.",
            schema: browserSchemas.browser_batch,
        }),
        tool(async (args) => JSON.stringify(await runTool("browser_goto", args)), {
            name: "browser_goto",
            description: "Navigate using an observed page href/URL or a known entry page. Never build a detail route from an ID; unobserved detail URLs open a listing to inspect actual links.",
            schema: browserSchemas.browser_goto,
        }),
        tool(async (args) => JSON.stringify(await runTool("browser_snapshot", args)), {
            name: "browser_snapshot",
            description:
                "Refresh page refs. Optional textOffset/elementOffset reads omitted sections of the compact view; old refs expire.",
            schema: browserSchemas.browser_snapshot,
        }),
        tool(async (args) => JSON.stringify(await runTool("browser_click", args)), {
            name: "browser_click",
            description:
                "Click a current visible control reference. Persisted actions pause for human approval.",
            schema: browserSchemas.browser_click,
        }),
        tool(async (args) => JSON.stringify(await runTool("browser_fill", args)), {
            name: "browser_fill",
            description:
                "Fill an editable text control using its current reference; returns fresh refs.",
            schema: browserSchemas.browser_fill,
        }),
        tool(async (args) => JSON.stringify(await runTool("browser_select", args)), {
            name: "browser_select",
            description: "Choose an enabled select option by value using a current reference.",
            schema: browserSchemas.browser_select,
        }),
        tool(async (args) => JSON.stringify(await runTool("browser_check", args)), {
            name: "browser_check",
            description: "Set a visible checkbox checked or unchecked using its current reference.",
            schema: browserSchemas.browser_check,
        }),
        tool(async (args) => JSON.stringify(await runTool("browser_back", args)), {
            name: "browser_back",
            description: "Go back in this task browser history and return a fresh snapshot.",
            schema: browserSchemas.browser_back,
        }),
        tool(async (args) => JSON.stringify(await runTool("browser_screenshot", args)), {
            name: "browser_screenshot",
            description: "Save a screenshot as task evidence using a safe descriptive label.",
            schema: browserSchemas.browser_screenshot,
        }),
    ];

    return { tools, runTool };
}
