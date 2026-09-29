import { log } from "@/lib/logs";
import { handleProcessRequest } from "@oneminutelogs/next";

const forwardLogStreamRequest = (request: Request) =>
  handleProcessRequest({
    request,
    logger: log,
  });

export const GET = forwardLogStreamRequest;
export const POST = forwardLogStreamRequest;
