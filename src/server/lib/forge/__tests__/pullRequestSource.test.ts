import { getPinnedGiteaPullRequestSource } from '../pullRequestSource';
import { GiteaProvider, giteaConfigFromEnvironment } from '../gitea';

jest.mock('../gitea', () => ({
  GiteaProvider: jest.fn(),
  giteaConfigFromEnvironment: jest.fn(),
}));

const sha = 'a'.repeat(40);
const headRepository = {
  id: { provider: 'gitea', instance: 'https://gitea.example.test', repositoryId: '43' },
  fullName: 'contributor/app',
};
const baseRepositoryId = { provider: 'gitea', instance: 'https://gitea.example.test', repositoryId: '42' };
const pr = {
  repository: {
    forgeProvider: 'gitea',
    forgeInstance: 'https://gitea.example.test',
    forgeRepositoryId: '42',
    fullName: 'example/app',
  },
  pullRequestNumber: 17,
  latestCommit: sha,
  headForgeRepositoryId: '43',
  headRepositoryFullName: 'contributor/app',
} as any;

const getPullRequest = jest.fn();
const getRepository = jest.fn();
const getCloneAccess = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  (giteaConfigFromEnvironment as jest.Mock).mockReturnValue({ baseUrl: 'https://gitea.example.test' });
  (GiteaProvider as jest.Mock).mockImplementation(() => ({ getPullRequest, getRepository, getCloneAccess }));
  getPullRequest.mockResolvedValue({
    state: 'open',
    id: { repository: baseRepositoryId },
    head: { repository: headRepository.id, sha },
  });
  getRepository.mockResolvedValue(headRepository);
  getCloneAccess.mockResolvedValue({
    url: 'https://gitea.example.test/contributor/app.git',
    username: 'bot',
    password: 'token',
  });
});

describe('Gitea pinned PR source', () => {
  it('returns no Gitea source for a GitHub PR', async () => {
    await expect(
      getPinnedGiteaPullRequestSource({ repository: { forgeProvider: 'github' } } as any)
    ).resolves.toBeNull();
    expect(GiteaProvider).not.toHaveBeenCalled();
  });

  it('uses the live PR and source fork before issuing clone credentials', async () => {
    await expect(getPinnedGiteaPullRequestSource(pr)).resolves.toMatchObject({ fullName: 'contributor/app', sha });
    expect(getPullRequest).toHaveBeenCalledWith('example/app', 17);
    expect(getRepository).toHaveBeenCalledWith('contributor/app');
    expect(getCloneAccess).toHaveBeenCalledWith(headRepository);
  });

  it.each(['closed', 'force-pushed'])('refuses a %s PR before cloning', async (change) => {
    getPullRequest.mockResolvedValue({
      state: change === 'closed' ? 'closed' : 'open',
      id: { repository: baseRepositoryId },
      head: { repository: headRepository.id, sha: change === 'closed' ? sha : 'b'.repeat(40) },
    });
    await expect(getPinnedGiteaPullRequestSource(pr)).rejects.toThrow('closed or its head changed');
    expect(getCloneAccess).not.toHaveBeenCalled();
  });

  it('propagates API failure so the caller can retry', async () => {
    getPullRequest.mockRejectedValue(new Error('Gitea API returned HTTP 503'));
    await expect(getPinnedGiteaPullRequestSource(pr)).rejects.toThrow('503');
  });
});
