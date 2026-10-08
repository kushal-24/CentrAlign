import { createHash, randomUUID } from "node:crypto";
import { interrupt } from "@langchain/langgraph";
import { z } from "zod";
import { allowedUrl } from "./navigation.js";
import { resolveRef } from "./snapshot.js";

export const approvalSchema = z
    .object({ proposalId: z.string().uuid(), approved: z.boolean() })
    .strict();

export async function inspectAction(session, ref) {
    const handle = await resolveRef(session, ref);
    const details = await handle.evaluate((element) => {
        const form = element.form ?? element.closest("form");
        const clean = (text) => (text ?? "").replace(/\s+/g, " ").trim();
        const values = form
            ? Array.from(new FormData(form).entries()).map(([key, value]) => [
                  key,
                  typeof value === "string" ? value : "[file]",
              ])
            : [];
        if (form?.querySelector('input[type="password"],input[type="file"]'))
            throw new Error("Sensitive forms are not supported.");
        return {
            risk: element.getAttribute("data-risk"),
            target: element.outerHTML,
            label: clean(element.getAttribute("aria-label") || element.innerText || element.value),
            url: location.href,
            destination: element.hasAttribute("formaction")
                ? element.formAction
                : form?.action || element.href || location.href,
            method: element.hasAttribute("formmethod") ? element.formMethod : form?.method || "get",
            values,
            visibleDetails: clean(
                (document.querySelector("main") ?? document.body).innerText,
            ).slice(0, 14000),
        };
    });
    allowedUrl(details.destination, session.siteUrl);
    const fingerprint = createHash("sha256")
        .update(JSON.stringify({ taskId: session.taskId, epoch: session.epoch, ref, ...details }))
        .digest("hex");
    return { handle, details, fingerprint };
}

export async function approveClick(session, ref, verifier) {
    if (session.pending && session.pending.ref !== ref) {
        throw new Error("An approval is pending for another target. Resume or reject it first.");
    }
    let action;
    try {
        action = await inspectAction(session, ref);
    } catch (error) {
        session.pending = null;
        throw error;
    }
    if (action.details.risk !== "irreversible" && !session.pending) {
        return false;
    }

    if (!session.pending) {
        session.pending = {
            proposalId: randomUUID(),
            taskId: session.taskId,
            ref,
            fingerprint: action.fingerprint,
            type: "approval",
            action: action.details.label,
            url: action.details.url,
            destination: action.details.destination,
            method: action.details.method,
            fields: action.details.values,
            visibleDetails: action.details.visibleDetails,
        };
        if (verifier) {
            try {
                session.pending.details = await verifier.capture(
                    session.pending.proposalId,
                    action.details,
                );
            } catch (error) {
                session.pending = null;
                throw error;
            }
        }
    }
    const proposal = session.pending;

    // LangGraph restarts this node on resume. No click happens before interrupt.
    const answer = interrupt(proposal);
    const parsed = approvalSchema.safeParse(answer);
    session.pending = null;
    if (
        !parsed.success ||
        parsed.data.proposalId !== proposal.proposalId ||
        proposal.taskId !== session.taskId ||
        proposal.ref !== ref
    ) {
        throw Object.assign(new Error("Invalid or mismatched approval. No action executed."), {
            actionStopped: true,
        });
    }
    if (!parsed.data.approved)
        throw Object.assign(new Error("Action rejected. No action executed."), {
            actionStopped: true,
        });

    const current = await inspectAction(session, ref);
    if (current.fingerprint !== proposal.fingerprint)
        throw Object.assign(
            new Error("Action details changed. A fresh proposal and approval are required."),
            { actionStopped: true },
        );
    try {
        await verifier?.approve(proposal.proposalId);
    } catch (error) {
        error.actionStopped = true;
        throw error;
    }
    return true;
}
