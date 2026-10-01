import GiteaService from '../gitea';
import { GiteaApiError } from 'server/lib/forge/gitea';
import type { GiteaDelivery } from 'server/lib/forge/giteaWebhook';

const getRepository = jest.fn();
const getPullRequest = jest.fn();
const add = jest.fn();

jest.mock('server/lib/dependencies', () => ({
  defaultDb: {}, defaultRedis: {}, defaultRedlock: {}, defaultQueueManager: {},
  redisClient: { getConnection: () => ({}) },
}));
jest.mock('shared/config', () => ({ QUEUE_NAMES: { GITEA_WEBHOOK_PROCESSING: 'gitea-webhooks-test' } }));
jest.mock('server/lib/logger', () => ({ getLogger: () => ({ info: jest.fn(), warn: jest.fn() }) }));
jest.mock('server/lib/authorityLock', () => ({
  withAuthorityLock: async ({ action }: { action: () => Promise<unknown> }) => ({ admitted: true, value: await action() }),
}));
jest.mock('server/lib/forge/gitea', () => {
  const actual = jest.requireActual('server/lib/forge/gitea');
  return {
    ...actual,
    giteaConfigFromEnvironment: () => ({ baseUrl: 'https://gitea.example.test', token: 'secret', username: 'bot', webhookSecrets: ['secret'] }),
    GiteaProvider: jest.fn().mockImplementation(() => ({
      getRepository: (...args: unknown[]) => getRepository(...args),
      getPullRequest: (...args: unknown[]) => getPullRequest(...args),
    })),
  };
});

const delivery: GiteaDelivery = {
  deliveryId: '12345678-1234-1234-1234-123456789abc',
  action: 'opened',
  repositoryFullName: 'example/app',
  repositoryId: 42,
  pullRequestNumber: 17,
};
const identity = { provider: 'gitea', instance: 'https://gitea.example.test', repositoryId: '42' };

describe('Gitea current-state intake', () => {
  let service: GiteaService;
  let prPatch: jest.Mock;
  let existingPr: any;

  beforeEach(() => {
    process.env.GITEA_REPOSITORY = 'example/app';
    process.env.GITEA_ENVIRONMENT_ID = '7';
    getRepository.mockReset().mockResolvedValue({ id: identity, fullName: 'example/app', url: 'https://gitea.example.test/example/app' });
    getPullRequest.mockReset().mockResolvedValue({
      id: { repository: identity, number: 17 }, title: 'Change', state: 'open',
      head: { repository: identity, sha: 'a'.repeat(40) }, headBranch: 'feature',
      labels: ['lifecycle-deploy!'], author: 'author',
    });
    prPatch = jest.fn().mockResolvedValue(1);
    existingPr = { id: 19, deployOnUpdate: true, $query: () => ({ patch: prPatch }) };
    const repository = {
      id: 4, fullName: 'example/app', htmlUrl: 'https://gitea.example.test/example/app',
    };
    const repositoryQuery = { findOne: jest.fn(() => ({ whereNull: jest.fn().mockResolvedValue(repository) })) };
    const prQuery = { findOne: jest.fn(() => ({ whereNull: jest.fn().mockImplementation(async () => existingPr) })) };
    const db = { models: { Repository: { query: () => repositoryQuery }, PullRequest: { query: () => prQuery } } };
    const queueManager = { registerQueue: jest.fn(() => ({ add })) };
    service = new GiteaService(db as any, {} as any, {} as any, queueManager as any);
    add.mockReset().mockResolvedValue(undefined);
  });

  afterAll(() => {
    delete process.env.GITEA_REPOSITORY;
    delete process.env.GITEA_ENVIRONMENT_ID;
  });

  it('uses the delivery ID as a stable queue job ID', async () => {
    await service.enqueueDelivery(delivery);
    expect(add).toHaveBeenCalledWith('gitea-pr', delivery, { jobId: `gitea-${delivery.deliveryId}` });
  });

  it('stores current head after a force-push even when processing an old close delivery', async () => {
    getPullRequest.mockResolvedValueOnce({
      id: { repository: identity, number: 17 }, title: 'Change', state: 'open',
      head: { repository: identity, sha: 'b'.repeat(40) }, headBranch: 'feature',
      labels: ['lifecycle-deploy!'], author: 'author',
    });
    await service.processWebhooks({ data: { ...delivery, action: 'closed' } });
    expect(prPatch).toHaveBeenCalledWith(expect.objectContaining({
      status: 'open', latestCommit: 'b'.repeat(40), branchName: 'feature',
    }));
  });

  it('marks a deleted PR closed and lets transient API errors retry', async () => {
    getPullRequest.mockRejectedValueOnce(new GiteaApiError(404));
    await service.processWebhooks({ data: delivery });
    expect(prPatch).toHaveBeenCalledWith({ status: 'closed' });

    getPullRequest.mockRejectedValueOnce(new GiteaApiError(503));
    await expect(service.processWebhooks({ data: delivery })).rejects.toMatchObject({ status: 503 });
  });
});
