#!/usr/bin/env node

/**
 * Temporary, authenticated loopback gateway for the SGX internal test page.
 * It is intentionally not a general reverse proxy: only the workbench,
 * its static assets, and the versioned algorithm API are exposed.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';

const upstream = new URL(process.env.SGX_PUBLIC_UPSTREAM ?? 'http://127.0.0.1:3100');
const port = Number(process.env.SGX_PUBLIC_GATEWAY_PORT ?? 3200);
const username = process.env.SGX_PUBLIC_GATEWAY_USER ?? 'sgx-team';
const password = process.env.SGX_PUBLIC_GATEWAY_PASSWORD
  ?? (process.env.SGX_PUBLIC_GATEWAY_PASSWORD_FILE
    ? readFileSync(process.env.SGX_PUBLIC_GATEWAY_PASSWORD_FILE, 'utf8').trim()
    : undefined);

if (!password || password.length < 12) {
  console.error('SGX_PUBLIC_GATEWAY_PASSWORD must be set and contain at least 12 characters.');
  process.exit(2);
}

const expectedAuthorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
const allowed = (pathname) => pathname === '/' || pathname === '/algorithm-lab'
  || pathname.startsWith('/_next/') || pathname.startsWith('/vad/')
  || pathname === '/favicon.ico' || pathname.startsWith('/api/algorithm/v0.1/');

function unauthorized(response) {
  response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="SGX internal test"', 'Cache-Control': 'no-store' });
  response.end('需要团队测试账号和临时密码。');
}

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url ?? '/', 'http://public-test.invalid');
  if (request.headers.authorization !== expectedAuthorization) return unauthorized(response);
  if (!allowed(requestUrl.pathname)) {
    response.writeHead(404, { 'Cache-Control': 'no-store' });
    response.end('Not found');
    return;
  }
  if (requestUrl.pathname === '/') {
    response.writeHead(302, { Location: '/algorithm-lab', 'Cache-Control': 'no-store' });
    response.end();
    return;
  }

  const headers = { ...request.headers, host: upstream.host };
  // The upstream test contract is loopback-only. The gateway is the trusted
  // boundary and rewrites browser-origin headers to the loopback origin.
  delete headers.authorization;
  delete headers['sec-fetch-site'];
  delete headers['sec-fetch-mode'];
  delete headers['sec-fetch-dest'];
  if (headers.origin) headers.origin = upstream.origin;
  const proxyRequest = http.request({ hostname: upstream.hostname, port: upstream.port,
    method: request.method, path: `${requestUrl.pathname}${requestUrl.search}`, headers }, proxyResponse => {
    response.writeHead(proxyResponse.statusCode ?? 502, proxyResponse.headers);
    proxyResponse.pipe(response);
  });
  proxyRequest.on('error', () => {
    if (!response.headersSent) response.writeHead(502, { 'Cache-Control': 'no-store' });
    response.end('本机算法服务暂时不可用。');
  });
  request.pipe(proxyRequest);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`SGX authenticated gateway listening on http://127.0.0.1:${port}`);
  console.log(`Allowed upstream: ${upstream.origin}`);
  console.log(`Team username: ${username}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
