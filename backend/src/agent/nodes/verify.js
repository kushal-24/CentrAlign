export async function verify(state, context) {
    if (!context.registry.verifyActions)
        return { failure: "Independent action verification is unavailable." };

    const evidence = await context.registry.verifyActions();
    return {
        verification: evidence,
        failure: evidence.success
            ? null
            : "Independent action verification failed. Inspect evidence before any further submission.",
    };
}
