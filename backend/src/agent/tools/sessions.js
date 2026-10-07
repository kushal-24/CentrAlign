import { chromium } from "playwright";
import { readConfig } from "../../config.js";
import { User } from "../../site/models/index.js";
import { installNavigationBoundary } from "./navigation.js";

export function safeTaskId(value) {
    if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value)) {
        throw new Error("Task ID must contain only letters, numbers, underscores or hyphens.");
    }
    return value;
}

export function createSessionManager(options = {}) {
    const sessions = new Map();
    const starting = new Set();
    let browserPromise;
    let closing = false;

    function getSession(taskId) {
        safeTaskId(taskId);
        const session = sessions.get(taskId);
        if (!session || session.page.isClosed())
            throw new Error("Unknown or closed browser session.");
        return session;
    }

    async function createSession(taskId) {
        safeTaskId(taskId);
        if (closing || sessions.has(taskId) || starting.has(taskId))
            throw new Error("Session already exists or manager is closing.");
        starting.add(taskId);
        let context;

        try {
            const config = options.config ?? readConfig(process.env, { requireStudent: true });
            const userId =
                options.userId ??
                (
                    await User.findOne({ email: config.STUDENT_EMAIL.toLowerCase().trim() })
                        .select("_id")
                        .lean()
                )?._id?.toString();
            if (!userId || !/^[a-f\d]{24}$/i.test(userId))
                throw new Error("Seeded demo user was not found.");

            if (!browserPromise) {
                browserPromise = chromium.launch({ headless: config.HEADLESS }).catch((error) => {
                    browserPromise = undefined;
                    throw error;
                });
            }
            const browser = await browserPromise;
            context = await browser.newContext({
                serviceWorkers: "block",
                viewport: options.viewport ?? { width: 1440, height: 1000 },
            });
            await context.addCookies([
                {
                    name: "uid",
                    value: userId,
                    url: new URL("/", config.SITE_URL).href,
                    httpOnly: true,
                    sameSite: "Lax",
                },
            ]);
            const page = await context.newPage();
            page.setDefaultTimeout(options.timeout ?? 5000);
            page.setDefaultNavigationTimeout(options.timeout ?? 5000);

            const session = {
                taskId,
                context,
                page,
                siteUrl: config.SITE_URL,
                refs: new Map(),
                nextRef: 1,
                epoch: 0,
                busy: false,
                pending: null,
                approvedClick: false,
                blockedNavigation: false,
                dialogOutcome: null,
            };
            page.on("framenavigated", (frame) => {
                if (frame === page.mainFrame()) session.epoch += 1;
            });
            page.on("dialog", async (dialog) => {
                const accept = session.approvedClick && dialog.type() === "confirm";
                session.dialogOutcome = accept ? "accepted" : "dismissed";
                await (accept ? dialog.accept() : dialog.dismiss()).catch(() => {});
            });
            await installNavigationBoundary(session);
            sessions.set(taskId, session);
            return session;
        } catch (error) {
            await context?.close();
            throw error;
        } finally {
            starting.delete(taskId);
        }
    }

    async function closeSession(taskId) {
        safeTaskId(taskId);
        const session = sessions.get(taskId);
        if (!session) return;
        if (session.busy) throw new Error("Cannot close a session while a tool is running.");
        sessions.delete(taskId);
        session.pending = null;
        await session.context.close();
    }

    async function closeAll() {
        if (starting.size || [...sessions.values()].some((session) => session.busy))
            throw new Error("Cannot shut down while sessions or tools are starting.");
        closing = true;
        for (const taskId of sessions.keys()) await closeSession(taskId);
        if (browserPromise) await (await browserPromise).close();
        browserPromise = undefined;
        closing = false;
    }

    return {
        createSession,
        getSession,
        closeSession,
        closeAll,
        get size() {
            return sessions.size;
        },
    };
}
