import { GiteaApiError, GiteaProvider, giteaConfigFromEnvironment } from '../gitea';

const sha = 'a'.repeat(40);
const config = {
  baseUrl: 'https://gitea.example.test/git',
  token: 'private-token',
  username: 'lifecycle-bot',
  webhookSecrets: ['test-secret'],
};
const repository = { id: 42, full_name: 'example/app', html_url: 'https://gitea.example.test/git/example/app' };
const headRepository = { id: 43, full_name: 'contributor/app', html_url: 'https://gitea.example.test/git/contributor/app' };

describe('Gitea provider', () => {
  it('requires HTTPS and complete credentials', () => {
    expect(giteaConfigFromEnvironment({})).toBeNull();
    expect(() => new GiteaProvider({ ...config, baseUrl: 'http://gitea.example.test' })).toThrow('HTTPS');
    expect(() => new GiteaProvider({ ...config, baseUrl: 'http://gitea.example.test', allowHttp: true })).toThrow('HTTPS');
    expect(() => new GiteaProvider({ ...config, baseUrl: 'http://localhost:3000', allowHttp: true })).not.toThrow();
    expect(() => new GiteaProvider({ ...config, token: '' })).toThrow('token');
  });

  it('normalises repository and exact PR head identities', async () => {
    const transport = jest.fn(async (_method: string, path: string) => {
      if (path === '/repos/example/app') return repository;
      if (path === '/repos/example/app/pulls/17') return {
        title: 'Change', state: 'open', html_url: `${repository.html_url}/pulls/17`,
        head: { sha, ref: 'feature', repo: headRepository }, base: { repo: repository },
        labels: [{ name: 'lifecycle-deploy!' }], user: { login: 'author' },
      };
      throw new Error('Unexpected request');
    });
    const provider = new GiteaProvider(config, transport);
    const pr = await provider.getPullRequest('example/app', 17);
    expect(pr.id.repository).toEqual({ provider: 'gitea', instance: 'https://gitea.example.test/git', repositoryId: '42' });
    expect(pr.head).toEqual({ repository: { provider: 'gitea', instance: 'https://gitea.example.test/git', repositoryId: '43' }, sha });
    expect(pr.labels).toEqual(['lifecycle-deploy!']);
    expect(await provider.getCloneAccess(pr.headRepository)).toEqual({
      url: 'https://gitea.example.test/git/contributor/app.git',
      username: 'lifecycle-bot', password: 'private-token',
    });
  });

  it('retrieves configuration at a full SHA and propagates API failures for retry', async () => {
    const transport = jest.fn(async (_method: string, path: string) => {
      if (path.includes('missing')) throw new GiteaApiError(404);
      if (path.includes('failed')) throw new GiteaApiError(503);
      return { type: 'file', encoding: 'base64', content: Buffer.from('version: 1.0.0').toString('base64') };
    });
    const provider = new GiteaProvider(config, transport);
    await expect(provider.getFileAtCommit('example/app', sha, 'lifecycle.yaml')).resolves.toBe('version: 1.0.0');
    expect(transport).toHaveBeenCalledWith('GET', `/repos/example/app/contents/lifecycle.yaml?ref=${sha}`);
    await expect(provider.getFileAtCommit('example/app', sha, 'missing')).resolves.toBeNull();
    await expect(provider.getFileAtCommit('example/app', sha, 'failed')).rejects.toMatchObject({ status: 503 });
  });

  it('updates an existing marked comment after losing the saved ID', async () => {
    const calls: string[] = [];
    const transport = jest.fn(async (method: string, path: string, body?: unknown) => {
      calls.push(`${method} ${path}`);
      if (path === '/repositories/42') return repository;
      if (path.includes('/17/comments')) return [{ id: 91, body: '<!-- lifecycle-status -->\nold' }];
      if (path.endsWith('/comments/91')) {
        expect(body).toEqual({ body: '<!-- lifecycle-status -->\nnew status' });
        return { id: 91 };
      }
      throw new Error('Unexpected request');
    });
    const provider = new GiteaProvider(config, transport);
    const id = { repository: { provider: 'gitea' as const, instance: 'https://gitea.example.test/git', repositoryId: '42' }, number: 17 };
    await expect(provider.upsertPullRequestComment(id, '<!-- lifecycle-status -->', 'new status')).resolves.toBe(91);
    expect(calls).toEqual([
      'GET /repositories/42',
      'GET /repos/example/app/issues/17/comments?page=1&limit=50',
      'PATCH /repos/example/app/issues/comments/91',
    ]);
  });
});
