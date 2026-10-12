import mongoose from "mongoose";
import { DB_NAME } from "../constants.js";
import { readConfig } from "../config.js";

const connectDB = async () => {
    try {
        const config = readConfig();
        await mongoose.connect(config.MONGODB_URI, {
            dbName: DB_NAME,
            serverSelectionTimeoutMS: 10000,
            connectTimeoutMS: 10000,
        });
        return mongoose.connection;
    } catch (error) {
        const serverErrors = [...(error.reason?.servers?.values?.() ?? [])]
            .map((server) => server.error);
        const codes = [error.code, error.cause?.code,
            ...serverErrors.flatMap((entry) => [entry?.code, entry?.cause?.code])];
        let message = "MongoDB connection failed. Check cluster availability and network access.";
        if (codes.includes(18))
            message = "MongoDB authentication failed. Check the database user credentials and permissions.";
        else if (codes.includes("ECONNRESET"))
            message = "MongoDB connections were reset (ECONNRESET). Check Atlas Network Access for your current public IP, cluster availability, and VPN/firewall restrictions. Both site and agent require MongoDB before opening their ports.";
        else if (codes.some((code) => ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"].includes(code)))
            message = "MongoDB DNS lookup or connection failed. Check DNS, network access, and whether the configured database is reachable.";
        // Do not attach the raw error: it may include database addresses or credentials.
        throw new Error(message);
    }
};

export default connectDB;
