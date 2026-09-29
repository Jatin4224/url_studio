import { log } from "@/lib/logs";
import { handleProcessRequest } from "@oneminutelogs/next";

const forwardOneMinuteLogsRequest = (request: Request) =>
  handleProcessRequest({
    request,
    logger: log,
  });

export const GET = forwardOneMinuteLogsRequest;
export const POST = forwardOneMinuteLogsRequest;
