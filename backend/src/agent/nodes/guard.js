function sortedValue(value) {
    if (Array.isArray(value)) return value.map(sortedValue);
    if (value && typeof value === "object")
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((key) => [key, sortedValue(value[key])]),
        );
    return value;
}

export function repeatKey(tool, args, url) {
    return JSON.stringify([tool, sortedValue(args), url]);
}

export function guard(state, context) {
    const call = state.pendingTool;
    const key = call ? repeatKey(call.name, call.args, state.latestSnapshot?.url) : "invalid-tool";
    const history = [...state.repeatHistory, key].slice(-5);
    let repetitions = 0;
    for (let index = history.length - 1; index >= 0 && history[index] === key; index -= 1)
        repetitions += 1;

    let failure = state.failure;
    if (repetitions >= 5) failure = "Repeated action limit reached.";
    if (state.errorCount >= 3)
        failure = "Repeated tool errors; task stopped without retrying a submission.";
    if (state.stepCount > context.maxSteps && !state.finishSummary)
        failure = "Task step limit reached.";
    if (
        /uncertain|rejected|approval.*changed|proposal.*changed/i.test(
            state.lastObservation?.observation ?? "",
        )
    )
        failure =
            "Action stopped after rejection, changed approval or uncertain submission. Inspect state before starting a new task.";

    if (state.finishSummary && !failure) {
        if (state.taskKind !== "read")
            failure = "Action completion requires independent Phase 8 verification.";
        else if (!state.evidenceCount)
            failure = "Completion requires observed website or database evidence.";
    }

    return {
        repeatHistory: history,
        failure,
        warning:
            repetitions >= 3
                ? "Repeated identical action; change strategy using fresh observations."
                : state.warning,
    };
}
