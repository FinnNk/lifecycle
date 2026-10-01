import { createHmac } from 'crypto';
import { Readable } from 'stream';
import type { NextApiRequest, NextApiResponse } from 'next';
import handler from '../gitea';

const enqueue = jest.fn();
jest.mock('server/services', () => jest.fn(() => ({ GiteaService: { enqueueDelivery: (...args: unknown[]) => enqueue(...args) } })));
jest.mock('server/jobs', () => jest.fn());
jest.mock('shared/index', () => ({ LIFECYCLE_MODE: 'web' }));
jest.mock('server/lib/logger', () => ({ getLogger: () => ({ info: jest.fn(), error: jest.fn() }) }));
jest.mock('server/lib/forge/gitea', () => ({
  giteaConfigFromEnvironment: () => ({ webhookSecrets: ['test-secret'] }),
}));

const deliveryId = '12345678-1234-1234-1234-123456789abc';
const body = Buffer.from(JSON.stringify({
  action: 'opened', number: 17, repository: { id: 42, full_name: 'example/app' },
}));

function request(signature: string, bytes = body): NextApiRequest {
  return Object.assign(Readable.from([bytes]), {
    method: 'POST',
    headers: {
      'x-gitea-delivery': deliveryId,
      'x-gitea-event': 'pull_request',
      'x-gitea-event-type': 'pull_request',
      'x-gitea-signature': signature,
    },
  }) as unknown as NextApiRequest;
}

function response() {
  const res = { status: jest.fn(), end: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

describe('Gitea webhook HTTP intake', () => {
  beforeEach(() => {
    process.env.GITEA_REPOSITORY = 'example/app';
    process.env.GITEA_ENVIRONMENT_ID = '1';
    enqueue.mockReset().mockResolvedValue(undefined);
  });

  afterAll(() => {
    delete process.env.GITEA_REPOSITORY;
    delete process.env.GITEA_ENVIRONMENT_ID;
  });

  it('rejects a changed raw body before enqueuing', async () => {
    const signature = createHmac('sha256', 'test-secret').update(body).digest('hex');
    const res = response();
    await handler(request(signature, Buffer.concat([body, Buffer.from(' ')])), res as unknown as NextApiResponse);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('queues only delivery metadata for a valid signed PR event', async () => {
    const signature = createHmac('sha256', 'test-secret').update(body).digest('hex');
    const res = response();
    await handler(request(signature), res as unknown as NextApiResponse);
    expect(res.status).toHaveBeenCalledWith(202);
    expect(enqueue).toHaveBeenCalledWith({
      deliveryId, action: 'opened', repositoryFullName: 'example/app', repositoryId: 42, pullRequestNumber: 17,
    });
    expect(JSON.stringify(enqueue.mock.calls)).not.toContain('test-secret');
  });

  it('returns a retryable response when the queue fails', async () => {
    enqueue.mockRejectedValueOnce(new Error('redis unavailable'));
    const signature = createHmac('sha256', 'test-secret').update(body).digest('hex');
    const res = response();
    await handler(request(signature), res as unknown as NextApiResponse);
    expect(res.status).toHaveBeenCalledWith(503);
  });
});
