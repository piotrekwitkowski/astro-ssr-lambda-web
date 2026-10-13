// Lambda Web Functions expect the server on AWS_LAMBDA_HTTP_ENDPOINT. @astrojs/node reads HOST and PORT.
// Node 24 runs this file directly with type stripping (AWS_LAMBDA_NODEJS_ENTRYPOINT=server.ts).
const [host, port] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT ?? '0.0.0.0:4321').split(':');
process.env.HOST = host;
process.env.PORT = port;
await import(new URL('./dist/server/entry.mjs', import.meta.url).href);
