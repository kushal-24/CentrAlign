import { createBrowserTools } from "./browser.js";
import { createDbTool } from "./db.js";
import { createControlTools } from "./control.js";

export { createBrowserTools, browserSchemas } from "./browser.js";
export { createSessionManager } from "./sessions.js";

export function createTaskTools(manager, taskId, account) {
    const browser = createBrowserTools(manager, taskId);
    const tools = [...browser.tools, createDbTool(account), ...createControlTools()];
    const byName = new Map(tools.map((entry) => [entry.name, entry]));

    return { tools, byName };
}
