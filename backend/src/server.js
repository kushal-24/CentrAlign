import mongoose from "mongoose";
import connectDB from "./db/index.js";

export async function startServer(app, port, name) {
    await connectDB();
    const server = await new Promise((resolve, reject) => {
        const listener = app.listen(port, "127.0.0.1");
        listener.once("listening", () => resolve(listener));
        listener.once("error", reject);
    });
    process.stdout.write(`${name} ready at http://127.0.0.1:${port}\n`);
    const shutdown = async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await mongoose.disconnect();
    };
    for (const signal of ["SIGINT", "SIGTERM"]) {
        process.once(signal, () => {
            shutdown().catch(() => {
                process.exitCode = 1;
            });
        });
    }
    return server;
}

export async function runServer(start) {
    try {
        await start();
    } catch {
        process.stderr.write(
            "Server startup failed. Check configuration, MongoDB access, and port availability.\n",
        );
        await mongoose.disconnect();
        process.exitCode = 1;
    }
}
