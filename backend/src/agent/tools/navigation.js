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
        throw new Error("Navigation is restricted to the configured MatchDay origin.");
    }

    const allowedPath = websiteRoutes.some((route) => route.test(url.pathname));

    if (url.pathname.includes("%") || !allowedPath) {
        throw new Error("This route is outside the MatchDay website boundary.");
    }

    return url.href;
}

export async function installNavigationBoundary(session) {
    const { context, page, siteUrl } = session;

    await context.route("**/*", async (route) => {
        const request = route.request();

        try {
            const url = new URL(request.url());

            if (request.isNavigationRequest()) {
                if (request.frame() !== page.mainFrame()) {
                    throw new Error("Additional pages are blocked.");
                }

                allowedUrl(url.href, siteUrl);

                // Inspect redirects before the browser follows them. route.continue()
                // alone does not re-route every redirected request in Playwright.
                const response = await route.fetch({ maxRedirects: 0, maxRetries: 0 });
                const location = response.headers().location;

                if (location && response.status() >= 300 && response.status() < 400) {
                    allowedUrl(new URL(location, url).href, siteUrl);
                }

                await route.fulfill({ response });
                return;
            } else if (url.origin !== new URL(siteUrl).origin) {
                throw new Error("External resources are blocked.");
            }

            if (
                /^\/(?:admin|tasks|health)(?:\/|$)/i.test(url.pathname) ||
                url.pathname.includes("%")
            ) {
                throw new Error("Operator and agent resources are blocked.");
            }

            await route.continue();
        } catch {
            session.blockedNavigation = true;
            await route.abort("blockedbyclient");
        }
    });

    context.on("page", (extraPage) => {
        if (extraPage !== page) void extraPage.close().catch(() => {});
    });
}
