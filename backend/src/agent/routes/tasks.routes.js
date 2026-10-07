import { Router } from "express";
import { createTaskControllers } from "../../controllers/tasks.controller.js";

export function createTaskRouter(runtime) {
    const router = Router();
    const { createTask, getTask, getTaskTrace } = createTaskControllers(runtime);

    router.post("/", createTask);
    router.get("/:id", getTask);
    router.get("/:id/trace", getTaskTrace);
    return router;
}
