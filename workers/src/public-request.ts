import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";

export function isPublicAddress(address: string) {
  return ipaddr.isValid(address) && ipaddr.parse(address).range() === "unicast";
}

export async function resolvePublicAddress(hostname: string, signal: AbortSignal) {
  const addresses = await Promise.race([
    isIP(hostname) ? Promise.resolve([{ address: hostname, family: isIP(hostname) }]) : lookup(hostname, { all: true }),
    new Promise<never>((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  ]);
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error("Local and private network addresses are not allowed.");
  }
  return addresses[0];
}

// Resolve once and connect to that exact IP: a second DNS lookup could rebind
// a public hostname to a private address. Redirects return to the route handler.
export async function requestPublicUrl(input: string, options: {
  method: string;
  headers: Record<string, string>;
  body: Buffer | null;
  signal: AbortSignal;
}) {
  const url = new URL(input);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) {
    throw new Error("Only public HTTP/HTTPS websites on standard ports are supported.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]);
  const address = await resolvePublicAddress(hostname, signal);
  const headers = { ...options.headers, host: url.host, "accept-encoding": "identity" };
  for (const key of ["connection", "proxy-connection", "proxy-authorization", "transfer-encoding", "content-length"]) {
    delete (headers as Record<string, string>)[key];
  }

  return new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request({
      hostname: address.address,
      family: address.family,
      servername: isIP(hostname) ? undefined : hostname,
      port: url.protocol === "https:" ? 443 : 80,
      path: url.pathname + url.search,
      method: options.method,
      headers,
      agent: false,
      signal,
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 10 * 1024 * 1024) request.destroy(new Error("Website resource exceeded 10 MB."));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        const responseHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(response.headers)) {
          if (value !== undefined && !["transfer-encoding", "connection", "content-length"].includes(key)) {
            responseHeaders[key] = Array.isArray(value) ? value.join("\n") : value;
          }
        }
        resolve({ status: response.statusCode ?? 502, headers: responseHeaders, body: Buffer.concat(chunks) });
      });
    });
    request.on("error", reject);
    request.end(options.body);
  });
}
