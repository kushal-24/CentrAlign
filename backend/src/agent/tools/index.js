import { createBrowserTools } from "./browser.js";
import { createDbTool } from "./db.js";
import { createControlTools } from "./control.js";
import { inspectAction } from "./riskGate.js";
import { createActionVerifier } from "../verification.js";

export { createBrowserTools, browserSchemas } from "./browser.js";
export { createSessionManager } from "./sessions.js";

export function createTaskTools(manager, taskId, account, task = "") {
    const cancellationWorkflow = /\bcancel\b/i.test(task);
    const verifier = createActionVerifier(account, { task });
    const browser = createBrowserTools(manager, taskId, { verifier });
    const control = createControlTools({
        ...(cancellationWorkflow ? {
            prepareCancellation: verifier.prepareCancellation,
            onHumanAnswer: verifier.acceptCancellationChoice,
            canAskHuman: () => verifier.getCancellationQuote()?.status !== "ready",
        } : {}),
        requestAction: async (ref) => {
            const action = await inspectAction(manager.getSession(taskId), ref);
            if (action.details.risk !== "irreversible")
                return {
                    success: false,
                    observation: "Approval requires a marked persisted-action control.",
                };
            return browser.runTool("browser_click", { ref });
        },
    });
    const tools = [...browser.tools, createDbTool(account), ...control];
    const byName = new Map(tools.map((entry) => [entry.name, entry]));

    return { tools, byName, cancellationWorkflow, verifyActions: verifier.verifyActions,
        setBookingRequirements: verifier.setBookingRequirements,
        verifyExistingCancellation: verifier.verifyExistingCancellation };
}
