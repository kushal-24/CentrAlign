const websiteRoutes = [
    /^\/$/,
    /^\/matches(?:\/[a-f\d]{24}(?:\/(?:book|waitlist))?)?\/?$/i,
    /^\/bookings(?:\/[a-f\d]{24}(?:\/cancel)?)?\/?$/i,
    /^\/(?:inbox|profile)\/?$/i,
    /^\/session\/(?:demo|close)\/?$/i,
];

export function allowedUrl(value, siteUrl) {
    const base = new URL(siteUrl);
    const url = new URL(value, base);

    if (
        !["http:", "https:"].includes(url.protocol) ||
        url.origin !== base.origin ||
        url.username ||
        url.password
    ) {
        throw Object.assign(new Error("Navigation is restricted to the configured MatchDay origin."), { code: "NAVIGATION_POLICY" });
    }

    const allowedPath = websiteRoutes.some((route) => route.test(url.pathname));

    if (url.pathname.includes("%") || !allowedPath) {
        throw Object.assign(new Error("This route is outside the MatchDay website boundary."), { code: "NAVIGATION_POLICY" });
    }

    return url.href;
}

export function navigationFailure(error) {
    const message = error?.message ?? "";
    if (/ECONNREFUSED|ERR_CONNECTION_REFUSED/i.test(message))
        return { code: "SITE_UNAVAILABLE", message: "MatchDay refused the connection. Start the configured site server.", terminal: true };
    if (/ENOTFOUND|ERR_NAME_NOT_RESOLVED/i.test(message))
        return { code: "SITE_UNRESOLVED", message: "The configured MatchDay hostname could not be resolved.", terminal: true };
    if (/timeout|timed out|ETIMEDOUT/i.test(message))
        return { code: "NAVIGATION_TIMEOUT", message: "MatchDay navigation timed out.", terminal: true };
    return { code: "NAVIGATION_FAILED", message: "MatchDay navigation transport failed.", terminal: true };
}

export async function installNavigationBoundary(session) {
    const { context, page, siteUrl } = session;

    await context.route("**/*", async (route) => {
        const request = route.request();
        const navigation = request.isNavigationRequest();
        let url;

        try {
            url = new URL(request.url());
            if (navigation) {
                if (request.frame() !== page.mainFrame())
                    throw new Error("Additional pages are blocked.");
                allowedUrl(url.href, siteUrl);
            } else if (url.origin !== new URL(siteUrl).origin) {
                throw new Error("External resources are blocked.");
            }
            if (/^\/(?:admin|tasks|health)(?:\/|$)/i.test(url.pathname) || url.pathname.includes("%"))
                throw new Error("Operator and agent resources are blocked.");
        } catch {
            session.blockedNavigation = true;
            session.navigationFailure = {
                code: "NAVIGATION_POLICY",
                message: "Request blocked by the MatchDay website boundary.",
                terminal: true,
            };
            await route.abort("blockedbyclient");
            return;
        }

        if (!navigation) {
            await route.continue();
            return;
        }

        // Only safe GET navigation may retry. Never replay a form submission.
        const attempts = request.method() === "GET" && !session.approvedClick ? 2 : 1;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            try {
                const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 2000 });
                if ([502, 503, 504].includes(response.status())) {
                    await response.dispose();
                    throw new Error("MatchDay temporarily unavailable.");
                }
                const location = response.headers().location;
                if (location && response.status() >= 300 && response.status() < 400)
                    allowedUrl(new URL(location, url).href, siteUrl);
                await route.fulfill({ response });
                return;
            } catch (error) {
                if (error.code === "NAVIGATION_POLICY") {
                    session.blockedNavigation = true;
                    session.navigationFailure = {
                        code: error.code,
                        message: "Redirect blocked by the MatchDay website boundary.",
                        terminal: true,
                    };
                    await route.abort("blockedbyclient");
                    return;
                }
                const failure = navigationFailure(error);
                const transient = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|timeout|timed out|temporarily unavailable/i.test(error.message);
                if (transient && attempt + 1 < attempts && !session.navigationRetries) {
                    session.navigationRetries = 1;
                    continue;
                }
                session.navigationFailure = { ...failure, retries: session.navigationRetries ?? 0 };
                const code = failure.code === "SITE_UNAVAILABLE" ? "connectionrefused"
                    : failure.code === "SITE_UNRESOLVED" ? "namenotresolved"
                    : failure.code === "NAVIGATION_TIMEOUT" ? "timedout" : "failed";
                await route.abort(code);
                return;
            }
        }
    });

    context.on("page", (extraPage) => {
        if (extraPage !== page) void extraPage.close().catch(() => {});
    });
}
