export async function complete(state, context) {
    await context.closeSession?.(state.taskId);

    const action = state.verification?.actions?.[0];
    let summary = state.finishSummary;
    if (action?.success) {
        const record = action.records[0];
        const details = action.action;
        if (details.kind === "book")
            summary = `Booked ${record.quantity} ticket(s) for ${details.title}. Total INR ${record.totalPrice}. Booking ${record.code}.`;
        else if (details.kind === "cancel")
            summary = `Cancelled booking ${record.code}. Refund INR ${record.refundAmount}.`;
        else if (details.kind === "waitlist")
            summary = `Joined the waitlist for ${details.title}: ${record.quantity} ticket(s), position ${record.position}.`;
        else if (details.kind === "profile")
            summary = "Profile updated and verified against the approved fields.";
    }

    const success = !state.failure && Boolean(state.finishSummary);
    return {
        status: success ? "done" : "failed",
        pendingInterrupt: null,
        result: {
            success,
            summary: success ? summary : (state.failure ?? "Task could not complete."),
            evidenceCount: state.evidenceCount,
            ...(state.recoveryFailure ? {
                failure: {
                    ...state.recoveryFailure,
                    llmRecoveryCalls: state.llmRecoveryCalls,
                    browserUrl: state.latestSnapshot?.url ?? null,
                },
            } : {}),
            ...(state.verification ? { evidence: state.verification } : {}),
        },
    };
}
