import { ToolMessage } from "@langchain/core/messages";
import { isGraphInterrupt } from "@langchain/langgraph";
import { compactObservation } from "../context.js";
import { repeatKey } from "./guard.js";
import { validateQuery, queryErrorObservation } from "../tools/db.js";

export function toolObservation(result) {
    if (typeof result === "string") return JSON.parse(result);
    if (result && typeof result === "object") return result;
    throw new Error("Invalid tool observation.");
}

function callKey(call) {
    let args = call.args;
    // JSON text formatting and object key order do not make a DB filter a new query.
    if (call.name === "db_query" && typeof args.filter === "string") {
        try {
            args = { ...args, filter: JSON.parse(args.filter) };
        } catch {
            // Invalid JSON is compared as text; the DB validator supplies the correction.
        }
    }
    return repeatKey(call.name, args, null);
}

function repeatsFailedCall(state, call) {
    if (state.lastObservation?.success !== false) return false;
    const messages = state.messages ?? [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const result = messages[index];
        if (!result.tool_call_id) continue;
        let previous;
        try {
            previous = toolObservation(result.content);
        } catch {
            return false;
        }
        if (previous.success !== false) return false;
        const previousCall = messages.slice(0, index).reverse()
            .flatMap((message) => message.tool_calls ?? [])
            .find((entry) => entry.id === result.tool_call_id);
        return Boolean(previousCall && callKey(previousCall) === callKey(call));
    }
    return false;
}

export async function runTool(state, context) {
    const call = state.pendingTool;
    const selected = context.registry.byName.get(call.name);
    let observation;

    try {
        context.registry.setBookingRequirements?.(state);
        if (call.name === "ask_human" && call.args.revision) {
            const changes = call.args.revision.changes;
            if (state.hasAction || !Array.isArray(changes) ||
                new Set(changes.map((change) => change.previous)).size !== changes.length ||
                changes.some((change) => !state.successCriteria.includes(change.previous)))
                throw new Error("Invalid or late requirement revision.");
        }
        if (repeatsFailedCall(state, call)) {
            const message = "Unchanged failed tool call blocked; the tool was not executed.";
            const hint = "Correct the rejected arguments using the previous error feedback or choose a different supported approach. Do not repeat this call unchanged.";
            observation = {
                success: false,
                errorCode: "REPEATED_FAILED_CALL",
                message,
                hint,
                previousError: state.lastObservation.previousError ?? {
                    errorCode: state.lastObservation.errorCode,
                    message: state.lastObservation.message ?? state.lastObservation.observation,
                    hint: state.lastObservation.hint,
                },
                observation: `${message} ${hint}`,
            };
        } else {
            observation = toolObservation(await selected.invoke(call.args));
        }
    } catch (error) {
        // LangGraph must receive the interrupt so it can save and resume this node.
        if (isGraphInterrupt(error)) throw error;
        observation = {
            success: false,
            observation:
                "Tool failed. Check arguments and fresh observations; no automatic submission retry.",
        };
        // Tool schema validation can reject arguments before the DB handler is entered.
        if (call.name === "db_query") {
            try {
                validateQuery(call.args);
            } catch (validationError) {
                observation = queryErrorObservation(validationError);
            }
        }
    }

    const update = {
        lastObservation: observation,
    };
    if (observation.cancellationQuote)
        update.cancellationQuote = observation.cancellationQuote;
    if (observation.snapshot) {
        update.latestSnapshot = observation.snapshot;
        update.observationWindow = observation.observationWindow ?? {};
    }
    if (call.name === "db_query" && observation.success) {
        const key = callKey(call);
        const facts = compactObservation(observation, 1000);
        const evidence = state.readEvidence ?? [];
        const previous = evidence.find((entry) => entry.key === key);
        const unchanged = previous && repeatKey("facts", previous.observation, null) ===
            repeatKey("facts", facts, null);
        update.unchangedReadCount = unchanged ? (state.unchangedReadCount ?? 0) + 1 : 0;
        update.readEvidence = [...evidence.filter((entry) => entry.key !== key),
            { key, args: call.args, observation: facts }].slice(-6);
        if (update.unchangedReadCount >= 2)
            update.warning = "Repeated reads returned no new evidence. Use retained facts to finish, or ask the user about a specific unresolved requirement. After three unchanged reads, only finish and ask_human are available.";
        else if (state.warning?.startsWith("Repeated reads returned no new evidence."))
            update.warning = null;
    }
    if (observation.approvedAction) {
        update.readEvidence = [];
        update.unchangedReadCount = 0;
    } else if (observation.humanAnswer) {
        update.unchangedReadCount = 0;
        if (state.warning?.startsWith("Repeated reads returned no new evidence."))
            update.warning = null;
    }
    update.actionHistory = [...(state.actionHistory ?? []), {
        tool: call.name,
        success: observation.success,
        ...(call.args.ref ? { ref: call.args.ref } : {}),
        ...(call.args.url ? { url: call.args.url } : {}),
        ...(observation.records ? { ids: observation.records.map((record) => record._id) } : {}),
        ...(observation.completed ? { completed: observation.completed } : {}),
        ...(observation.approvedAction ? { approvedAction: true } : {}),
        ...(!observation.success ? { error: String(observation.observation).slice(0, 300) } : {}),
    }];
    if (observation.approvedAction) update.hasAction = true;
    if (observation.humanAnswer)
        update.clarifications = [
            ...(state.clarifications ?? []),
            { question: observation.humanQuestion, answer: observation.humanAnswer,
                ...(observation.proposedRevision ? {
                    revision: observation.proposedRevision,
                    accepted: observation.revisionAccepted === true,
                } : {}) },
        ].slice(-8);
    if (call.name === "ask_human" && observation.success && observation.revisionAccepted) {
        const changes = observation.proposedRevision.changes;
        update.successCriteria = state.successCriteria.map((criterion) =>
            changes.find((change) => change.previous === criterion)?.replacement ?? criterion);
    }
    if (
        observation.success &&
        ["db_query", "browser_goto", "browser_snapshot", "browser_back"].includes(call.name)
    )
        update.evidenceCount = state.evidenceCount + 1;

    if (call.name === "remember" && observation.success) {
        const { key, value } = observation.memory;
        if (Object.keys(state.memory).length >= 20 && !Object.hasOwn(state.memory, key)) {
            observation = { success: false, observation: "Task memory limit reached." };
            update.lastObservation = observation;
        } else {
            update.memory = { ...state.memory, [key]: value };
        }
    }
    if (call.name === "finish" && observation.success) {
        let verification = state.verification;
        // A newly executed action uses its independent verification, even if the
        // model mistakenly labels the final result as already satisfied.
        if (observation.alreadySatisfied && !state.hasAction) {
            if (!context.registry.verifyExistingCancellation) {
                update.failure = "Existing cancellation verification is unavailable.";
            } else {
                verification = await context.registry.verifyExistingCancellation(
                    state.task, observation.alreadySatisfied.bookingCode,
                );
                update.verification = verification;
                if (!verification.success)
                    update.failure = "Existing cancellation does not establish the requested outcome.";
            }
        }
        if (state.hasAction || observation.alreadySatisfied) {
            const criteria = observation.criteria ?? [];
            const supported = verification?.success && state.successCriteria.length > 0 &&
                criteria.length === state.successCriteria.length &&
                criteria.every((entry, index) => entry.met &&
                    entry.criterion === state.successCriteria[index]);
            if (!supported)
                update.failure ??= "Verified action does not establish every requested success criterion.";
        }
        update.finishSummary = observation.alreadySatisfied && !state.hasAction && verification?.success
            ? verification.summary : observation.finish;
    }

    update.errorCount = observation.success ? 0 : state.errorCount + 1;

    // Send compact records; preserve full observations in lastObservation and the persisted trace.
    const message = new ToolMessage({
        content: JSON.stringify(compactObservation(observation)),
        tool_call_id: call.id,
        name: call.name,
    });
    update.messages = [...state.messages, message].slice(-12);

    return update;
}
