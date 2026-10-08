export async function complete(state, context) {
    await context.closeSession?.(state.taskId);

    const success = !state.failure && Boolean(state.finishSummary);
    return {
        status: success ? "done" : "failed",
        pendingInterrupt: null,
        result: {
            success,
            summary: success ? state.finishSummary : (state.failure ?? "Task could not complete."),
            evidenceCount: state.evidenceCount,
            ...(state.verification ? { evidence: state.verification } : {}),
        },
    };
}
