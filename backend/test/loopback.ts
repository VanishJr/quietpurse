import http from 'http';
import request from 'supertest';

export type Agent = request.Agent;
export type Response = request.Response;

const open = new Set<http.Server>();

export async function listening(target: http.RequestListener): Promise<http.Server> {
  const server = http.createServer(target);
  open.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  server.listen = () => {
    throw new Error('this server was closed by the test harness and cannot listen again - serve its target again');
  };
  return server;
}

export async function serve(target: http.RequestListener): Promise<Agent> {
  return request.agent(await listening(target));
}

export async function closeServers(): Promise<void> {
  const closing = [...open];
  open.clear();
  await Promise.all(
    closing.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
}
