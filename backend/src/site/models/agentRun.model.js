import mongoose, { Schema } from "mongoose";

const agentRunSchema = new Schema(
    {
        taskId: {
            type: String,
            required: true,
            trim: true,
        },

        status: {
            type: String,
            required: true,
            enum: ["running", "awaiting_approval", "needs_input", "done", "failed"],
        },

        task: {
            type: String,
            required: true,
            trim: true,
        },

        goal: {
            type: String,
            default: "",
        },

        successCriteria: {
            type: [String],
            default: [],
        },

        plan: {
            type: [String],
            default: [],
        },

        memory: {
            type: Schema.Types.Mixed,
            default: () => ({}),
        },

        steps: {
            type: [Schema.Types.Mixed],
            default: [],
        },

        pendingInterrupt: {
            type: Schema.Types.Mixed,
            default: null,
        },

        result: {
            type: Schema.Types.Mixed,
            default: null,
        },
    },
    { collection: "agent_runs", timestamps: true },
);
// Run timestamps are technical diagnostics, not business timestamps.
agentRunSchema.index({ taskId: 1 }, { unique: true });

export const AgentRun = mongoose.model("AgentRun", agentRunSchema);
