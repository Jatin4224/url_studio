import "server-only";
import { createLogger } from "@oneminutelogs/next";

export const log = process.env.LOGS_API_KEY
  ? createLogger({
      apiKey: process.env.LOGS_API_KEY,
      projectName: "URL Studio",
      serviceName: "web",
      environment: process.env.NODE_ENV ?? "development",
    })
  : undefined;

export const workerLog = process.env.LOGS_API_KEY
  ? createLogger({
      apiKey: process.env.LOGS_API_KEY,
      projectName: "URL Studio",
      serviceName: "worker",
      environment: process.env.NODE_ENV ?? "development",
    })
  : undefined;

if (!log)
  console.warn("LOGS_API_KEY is missing; monitoring is disabled.");
