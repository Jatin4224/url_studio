import net from "node:net";
import http from "node:http";
import { requestPublicUrl, resolvePublicAddress } from "./public-request.js";

export async function startPublicProxy() {
  const sockets = new Set<net.Socket>();
  const controller = new AbortController();

  const server = http.createServer(async (request, response) => {
    try {
      if (!["GET", "HEAD"].includes(request.method ?? ""))
        throw new Error("Unsupported method.");
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        if (typeof value === "string") headers[key] = value;
      }

      const result = await requestPublicUrl(request.url ?? "", {
        method: request.method!,
        headers,
        body: null,
        signal: controller.signal,
      });
      response.writeHead(result.status, result.headers);
      response.end(result.body);
    } catch (error) {
      response.writeHead(403, { "Content-Type": "text/plain" });
      response.end("Website request blocked or unavailable.");
    }
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  });
  server.on("connect", async (request, client, head) => {
    try {
      const url = new URL(`https://${request.url}`);
      if (url.port || url.username || url.password || url.pathname !== "/")
        throw new Error("Invalid tunnel.");
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(10_000),
      ]);
      const address = await resolvePublicAddress(hostname, signal);
      if (client.destroyed || controller.signal.aborted) return;
      const upstream = net.connect({
        host: address.address,
        port: 443,
        family: address.family,
      });
      sockets.add(upstream);
      upstream.setTimeout(10_000, () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      upstream.on("close", () => {
        sockets.delete(upstream);
        client.destroy();
      });
      client.on("close", () => upstream.destroy());
      upstream.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream).pipe(client);
      });
    } catch {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      controller.abort();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
