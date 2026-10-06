import { readConfig } from "../src/config.js";

try {
    readConfig(process.env, { requireGemini: true, requireStudent: true });
    process.stdout.write("Configuration valid. No secret values printed.\n");
} catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
}
