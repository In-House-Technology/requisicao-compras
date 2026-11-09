import { Readable } from "node:stream";

// Exercise the real HTTP handler without binding a socket or using a database.
export function request(server, { path = "/", method = "GET", headers = {}, body = "" } = {}) {
  return new Promise((resolve, reject) => {
    const req = Readable.from(body ? [body] : []);
    Object.assign(req, { url: path, method, headers: { host: "local", ...headers } });
    let status, responseHeaders;
    server.emit("request", req, {
      writeHead(code, values) { status = code; responseHeaders = values; },
      end(text = "") { resolve({ status, headers: responseHeaders, text, json: () => JSON.parse(text) }); },
      destroy: reject,
    });
  });
}
