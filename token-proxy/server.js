import http from "node:http";
import https from "node:https";
import net from "node:net";

// One entry per paid service. To add a new one:
//   1. put the real token in token-proxy's env as REAL_<NAME>_API_KEY
//   2. add an entry here with the route prefix, upstream host, and how
//      the token should be attached (header name + optional "Bearer " prefix)
//   3. point the agent at http://token-proxy:8080/<route> instead of the
//      real API, using a placeholder token
const PROVIDERS = {
  anthropic: {
    host: "api.anthropic.com",
    envVar: "REAL_ANTHROPIC_API_KEY",
    header: "x-api-key",
    prefix: "",
  },
  xai: {
    host: "api.x.ai",
    envVar: "REAL_XAI_API_KEY",
    header: "authorization",
    prefix: "Bearer ",
  },
  // acme: {
  //   host: "api.acme.com",
  //   envVar: "REAL_ACME_API_KEY",
  //   header: "authorization",
  //   prefix: "Bearer ",
  // },
};

function realKeys() {
  return Object.values(PROVIDERS)
    .map((p) => process.env[p.envVar])
    .filter(Boolean);
}

// Belt-and-suspenders: never forward a request that somehow contains a real
// key value, even if it arrived from inside our own network.
function containsRealKey(buf) {
  const text = buf.toString("utf8");
  return realKeys().some((k) => text.includes(k));
}

function proxyToProvider(providerName, req, res, body) {
  const provider = PROVIDERS[providerName];
  const realKey = process.env[provider.envVar];
  if (!realKey) {
    res.writeHead(502).end(`no key configured for ${providerName}`);
    return;
  }
  if (containsRealKey(body)) {
    res.writeHead(400).end("blocked: request body contains a real credential");
    return;
  }

  const path = req.url.replace(`/${providerName}`, "") || "/";
  const headers = { ...req.headers };
  delete headers["content-length"];
  delete headers["proxy-authorization"];
  delete headers["authorization"];
  delete headers["x-api-key"];
  headers.host = provider.host;
  headers[provider.header] = `${provider.prefix}${realKey}`;

  if (process.env.PROXY_DEBUG) {
    const redactedHeaders = { ...headers, [provider.header]: "<redacted>" };
    console.log(`--> ${req.method} https://${provider.host}${path}`);
    console.log(JSON.stringify(redactedHeaders, null, 2));
    if (body.length) console.log(body.toString("utf8").slice(0, 2000));
  }

  const upstreamReq = https.request(
    { host: provider.host, path, method: req.method, headers },
    (upstreamRes) => {
      if (process.env.PROXY_DEBUG) {
        console.log(`<-- ${upstreamRes.statusCode} ${req.method} ${path}`);
      }
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      upstreamRes.pipe(res);
    }
  );
  upstreamReq.on("error", (err) => res.writeHead(502).end(String(err)));
  upstreamReq.end(body);
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const providerName = Object.keys(PROVIDERS).find((name) =>
      req.url.startsWith(`/${name}`)
    );
    if (providerName) {
      return proxyToProvider(providerName, req, res, body);
    }

    // Generic plain-HTTP forward-proxy path for regular web reads.
    // No credentials are ever available to inject here, so nothing to leak.
    if (containsRealKey(body)) {
      res.writeHead(400).end("blocked: request body contains a real credential");
      return;
    }
    const target = new URL(req.url);
    const upstreamReq = http.request(
      {
        host: target.hostname,
        port: target.port || 80,
        path: target.pathname + target.search,
        method: req.method,
        headers: req.headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        upstreamRes.pipe(res);
      }
    );
    upstreamReq.on("error", (err) => res.writeHead(502).end(String(err)));
    upstreamReq.end(body);
  });
});

// HTTPS browsing (CONNECT tunnel) — opaque passthrough, we can't (and don't
// need to) inject credentials into general web traffic.
server.on("connect", (req, clientSocket, head) => {
  const [host, port] = req.url.split(":");
  const serverSocket = net.connect(port || 443, host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    serverSocket.write(head);
    serverSocket.pipe(clientSocket);
    clientSocket.pipe(serverSocket);
  });
  serverSocket.on("error", () => clientSocket.end());
  clientSocket.on("error", () => serverSocket.end());
});

server.listen(8080, () => console.log("token-proxy listening on :8080"));
