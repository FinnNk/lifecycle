import GiteaService from '../gitea';
import { GiteaApiError } from 'server/lib/forge/gitea';
import type { GiteaDelivery } from 'server/lib/forge/giteaWebhook';

const getRepository = jest.fn();
const getPullRequest = jest.fn();
const add = jest.fn();
const enqueueBuildDeletion = jest.fn();
const createBuildAndDeploys = jest.fn();
const enqueueResolveAndDeployBuild = jest.fn();

jest.mock('server/lib/dependencies', () => ({
  defaultDb: {}, defaultRedis: {}, defaultRedlock: {}, defaultQueueManager: {},
  redisClient: { getConnection: () => ({}) },
}));
jest.mock('shared/config', () => ({ QUEUE_NAMES: { GITEA_WEBHOOK_PROCESSING: 'gitea-webhooks-test' } }));
jest.mock('server/lib/logger', () => ({ getLogger: () => ({ info: jest.fn(), warn: jest.fn() }) }));
jest.mock('../globalConfig', () => ({
  __esModule: true,
  default: { getInstance: () => ({ getLabels: async () => ({ deploy: ['lifecycle-deploy!'], disabled: ['lifecycle-disabled!'] }) }) },
}));
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
  let buildQuery: any;
  let buildRow: any;

  beforeEach(() => {
    process.env.GITEA_REPOSITORY = 'example/app';
    process.env.GITEA_ENVIRONMENT_ID = '7';
    getRepository.mockReset().mockResolvedValue({ id: identity, fullName: 'example/app', url: 'https://gitea.example.test/example/app' });
    getPullRequest.mockReset().mockResolvedValue({
      id: { repository: identity, number: 17 }, title: 'Change', state: 'open',
      head: { repository: identity, sha: 'a'.repeat(40) }, headBranch: 'feature',
      headRepository: { id: identity, fullName: 'example/app' },
      labels: ['lifecycle-deploy!'], author: 'author',
    });
    prPatch = jest.fn().mockResolvedValue(1);
    existingPr = { id: 19, deployOnUpdate: true, $query: () => ({ patch: prPatch }) };
    const repository = {
      id: 4, fullName: 'example/app', htmlUrl: 'https://gitea.example.test/example/app',
    };
    const repositoryQuery = { findOne: jest.fn(() => ({ whereNull: jest.fn().mockResolvedValue(repository) })) };
    const prQuery = { findOne: jest.fn(() => ({ whereNull: jest.fn().mockImplementation(async () => existingPr) })) };
    buildRow = { id: 61 };
    buildQuery = { findOne: jest.fn(() => ({ whereNull: jest.fn().mockImplementation(async () => buildRow) })) };
    const db = {
      models: {
        Repository: { query: () => repositoryQuery }, PullRequest: { query: () => prQuery },
        Build: { query: () => buildQuery },
      },
      services: { BuildService: { enqueueBuildDeletion, createBuildAndDeploys, enqueueResolveAndDeployBuild } },
    };
    const queueManager = { registerQueue: jest.fn(() => ({ add })) };
    service = new GiteaService(db as any, {} as any, {} as any, queueManager as any);
    add.mockReset().mockResolvedValue(undefined);
    enqueueBuildDeletion.mockReset().mockResolvedValue(undefined);
    createBuildAndDeploys.mockReset().mockResolvedValue(undefined);
    enqueueResolveAndDeployBuild.mockReset().mockResolvedValue(undefined);
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
      headRepository: { id: identity, fullName: 'example/app' },
      labels: ['lifecycle-deploy!'], author: 'author',
    });
    await service.processWebhooks({ data: { ...delivery, action: 'closed' } });
    expect(prPatch).toHaveBeenCalledWith(expect.objectContaining({
      status: 'open', latestCommit: 'b'.repeat(40), branchName: 'feature',
    }));
    expect(enqueueBuildDeletion).not.toHaveBeenCalled();
    expect(enqueueResolveAndDeployBuild).toHaveBeenCalledWith({
      buildId: 61,
      runUUID: `gitea-4-19-${'b'.repeat(40)}`,
    });
  });

  it('coalesces duplicate deliveries for the same head and queues a changed head', async () => {
    await service.processWebhooks({ data: delivery });
    await service.processWebhooks({ data: { ...delivery, deliveryId: '87654321-1234-1234-1234-123456789abc' } });
    expect(enqueueResolveAndDeployBuild).toHaveBeenCalledTimes(2);
    expect(enqueueResolveAndDeployBuild.mock.calls[0][0].runUUID)
      .toBe(enqueueResolveAndDeployBuild.mock.calls[1][0].runUUID);
    expect(createBuildAndDeploys).not.toHaveBeenCalled();
  });

  it('creates the missing build and retries queue submission after PR state is saved', async () => {
    buildRow = null;
    createBuildAndDeploys.mockImplementationOnce(async () => { buildRow = { id: 62 }; });
    enqueueResolveAndDeployBuild.mockRejectedValueOnce(new Error('queue unavailable'));
    await expect(service.processWebhooks({ data: delivery })).rejects.toThrow('queue unavailable');
    await service.processWebhooks({ data: delivery });
    expect(createBuildAndDeploys).toHaveBeenCalledWith(expect.objectContaining({
      repositoryId: 4, pullRequestId: 19, environmentId: 7, repositoryBranchName: 'feature',
    }));
    expect(enqueueResolveAndDeployBuild).toHaveBeenCalledTimes(2);
    expect(enqueueResolveAndDeployBuild.mock.calls[0][0])
      .toEqual(enqueueResolveAndDeployBuild.mock.calls[1][0]);
  });

  it('reclaims a torn-down build on a reopened PR at the same commit', async () => {
    existingPr.deployOnUpdate = false;
    buildRow = { id: 61, status: 'torn_down' };
    await service.processWebhooks({ data: { ...delivery, action: 'reopened' } });
    expect(enqueueResolveAndDeployBuild).toHaveBeenCalledWith({
      buildId: 61,
      runUUID: `gitea-4-19-${'a'.repeat(40)}-${delivery.deliveryId}`,
    });
    expect(enqueueBuildDeletion).not.toHaveBeenCalled();
  });

  it('retains the fork identity and queues teardown when the live PR is closed', async () => {
    const fork = { provider: 'gitea', instance: identity.instance, repositoryId: '73' };
    getPullRequest.mockResolvedValueOnce({
      id: { repository: identity, number: 17 }, title: 'Change', state: 'closed',
      head: { repository: fork, sha: 'c'.repeat(40) }, headBranch: 'feature',
      headRepository: { id: fork, fullName: 'contributor/app' },
      labels: ['lifecycle-deploy!'], author: 'author',
    });
    await service.processWebhooks({ data: { ...delivery, action: 'closed' } });
    expect(prPatch).toHaveBeenCalledWith(expect.objectContaining({
      status: 'closed', deployOnUpdate: false, latestCommit: 'c'.repeat(40),
      headForgeRepositoryId: '73', headRepositoryFullName: 'contributor/app',
    }));
    expect(enqueueBuildDeletion).toHaveBeenCalledWith({ id: 61 }, 'pull_request_closed');
  });

  it('queues teardown when the deploy label is removed from the live PR', async () => {
    getPullRequest.mockResolvedValueOnce({
      id: { repository: identity, number: 17 }, title: 'Change', state: 'open',
      head: { repository: identity, sha: 'a'.repeat(40) }, headBranch: 'feature',
      headRepository: { id: identity, fullName: 'example/app' },
      labels: [], author: 'author',
    });
    await service.processWebhooks({ data: { ...delivery, action: 'labelled' } });
    expect(prPatch).toHaveBeenCalledWith(expect.objectContaining({ deployOnUpdate: false }));
    expect(enqueueBuildDeletion).toHaveBeenCalledWith({ id: 61 }, 'deploy_disabled');
  });

  it('marks a deleted PR closed and lets transient API errors retry', async () => {
    getPullRequest.mockRejectedValueOnce(new GiteaApiError(404));
    await service.processWebhooks({ data: delivery });
    expect(prPatch).toHaveBeenCalledWith({ status: 'closed', deployOnUpdate: false });
    expect(enqueueBuildDeletion).toHaveBeenCalledWith({ id: 61 }, 'pull_request_closed');

    enqueueBuildDeletion.mockClear();
    getPullRequest.mockRejectedValueOnce(new GiteaApiError(503));
    await expect(service.processWebhooks({ data: delivery })).rejects.toMatchObject({ status: 503 });
    expect(enqueueBuildDeletion).not.toHaveBeenCalled();
  });
});
