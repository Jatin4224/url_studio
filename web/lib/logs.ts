import "server-only";
import { createLogger } from "@oneminutelogs/next";

export const log = process.env.ONE_MINUTE_LOGS_API_KEY
  ? createLogger({
      apiKey: process.env.ONE_MINUTE_LOGS_API_KEY,
      projectName: "OneMinute Studio",
      serviceName: "web",
      environment: process.env.NODE_ENV ?? "development",
    })
  : undefined;

export const workerLog = process.env.ONE_MINUTE_LOGS_API_KEY
  ? createLogger({
      apiKey: process.env.ONE_MINUTE_LOGS_API_KEY,
      projectName: "OneMinute Studio",
      serviceName: "worker",
      environment: process.env.NODE_ENV ?? "development",
    })
  : undefined;

if (!log)
  console.warn("ONE_MINUTE_LOGS_API_KEY is missing; monitoring is disabled.");
