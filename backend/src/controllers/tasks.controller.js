import { z } from "zod";
import asyncHandler from "../utils/asyncHandler.js";
import apiError from "../utils/apiError.js";
import apiResponse from "../utils/apiResponse.js";

const taskSchema = z.object({ task: z.string().trim().min(1).max(3000) }).strict();
const taskIdSchema = z.string().uuid();

export function createTaskControllers(runtime) {
    const createTask = asyncHandler(async (req, res) => {
        const input = taskSchema.safeParse(req.body);
        if (!input.success)
            throw new apiError(400, "Provide one nonempty task string, at most 3000 characters.");

        const result = await runtime().startTask(input.data.task);
        res.status(202).json(new apiResponse(result, 202, "Task accepted."));
    });

    const getTask = asyncHandler(async (req, res) => {
        if (!taskIdSchema.safeParse(req.params.id).success)
            throw new apiError(400, "Invalid task ID.");
        const run = await runtime().readRun(req.params.id);
        if (!run) throw new apiError(404, "Task not found.");

        res.status(200).json(new apiResponse(run, 200, "Task status."));
    });

    const getTaskTrace = asyncHandler(async (req, res) => {
        if (!taskIdSchema.safeParse(req.params.id).success)
            throw new apiError(400, "Invalid task ID.");
        const trace = await runtime().readTrace(req.params.id);
        if (!trace) throw new apiError(404, "Task not found.");

        res.status(200).json(new apiResponse(trace, 200, "Task trace."));
    });

    return { createTask, getTask, getTaskTrace };
}
