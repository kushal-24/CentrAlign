import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tool } from "@langchain/core/tools";
import { isGraphInterrupt } from "@langchain/langgraph";
import { z } from "zod";
import { allowedUrl } from "./navigation.js";
import { takeSnapshot, resolveRef } from "./snapshot.js";
import { approveClick } from "./riskGate.js";
import { safeTaskId } from "./sessions.js";

const reference = z.number().int().positive();
export const browserSchemas = {
    browser_goto: z.object({ url: z.string().min(1).max(2000) }).strict(),
    browser_snapshot: z.object({}).strict(),
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

export function createBrowserTools(manager, taskId) {
    safeTaskId(taskId);

    async function runTool(name, args) {
        const parsed = browserSchemas[name]?.safeParse(args);
        if (!parsed?.success) return { success: false, observation: "Invalid tool arguments." };
        let session;
        let ownsLock = false;
        let actionStarted = false;

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
            session.dialogOutcome = null;
            const { page } = session;
            const input = parsed.data;

            if (name === "browser_goto") {
                await page.goto(allowedUrl(input.url, session.siteUrl), {
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
                const approved = await approveClick(session, input.ref);
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
            return {
                success: !session.blockedNavigation,
                observation: session.blockedNavigation
                    ? "Navigation was blocked by the website boundary."
                    : session.dialogOutcome
                      ? `Action completed; dialog ${session.dialogOutcome}. Inspect the snapshot for the site outcome.`
                      : "Tool completed. Inspect the snapshot for the site outcome.",
                snapshot,
            };
        } catch (error) {
            if (isGraphInterrupt(error)) throw error;
            return {
                success: false,
                observation: actionStarted
                    ? "Click outcome may be uncertain. Inspect a fresh snapshot before any further action; do not repeat the submission."
                    : error.message,
                snapshot: null,
            };
        } finally {
            if (ownsLock) {
                session.approvedClick = false;
                session.busy = false;
            }
        }
    }

    const tools = [
        tool(async (args) => JSON.stringify(await runTool("browser_goto", args)), {
            name: "browser_goto",
            description: "Navigate to a MatchDay website URL and return a fresh page snapshot.",
            schema: browserSchemas.browser_goto,
        }),
        tool(async (args) => JSON.stringify(await runTool("browser_snapshot", args)), {
            name: "browser_snapshot",
            description:
                "Read the rendered page and refresh visible element references. Old references expire.",
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
