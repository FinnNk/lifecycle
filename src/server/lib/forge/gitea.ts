import { readFileSync } from 'fs';
import http from 'http';
import https from 'https';
import type {
  ForgeCloneAccess,
  ForgeProvider,
  ForgePullRequest,
  ForgePullRequestId,
  ForgeRepository,
  ForgeRepositoryId,
} from './types';

export interface GiteaConfig {
  baseUrl: string;
  token: string;
  username: string;
  webhookSecrets: string[];
  caFile?: string;
  allowHttp?: boolean;
}

export function giteaConfigFromEnvironment(env: NodeJS.ProcessEnv = process.env): GiteaConfig | null {
  if (!env.GITEA_BASE_URL) return null;
  const config: GiteaConfig = {
    baseUrl: env.GITEA_BASE_URL,
    token: env.GITEA_TOKEN || '',
    username: env.GITEA_USERNAME || '',
    webhookSecrets: [env.GITEA_WEBHOOK_SECRET, env.GITEA_WEBHOOK_SECRET_PREVIOUS].filter(Boolean) as string[],
    caFile: env.GITEA_CA_FILE,
    allowHttp: env.GITEA_ALLOW_HTTP === 'true',
  };
  validateGiteaConfig(config);
  return config;
}

export function validateGiteaConfig(config: GiteaConfig): void {
  const url = new URL(config.baseUrl);
  if (url.username || url.password || url.search || url.hash) throw new Error('Gitea base URL must not contain credentials');
  const localHttp =
    config.allowHttp &&
    url.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localHttp) {
    throw new Error('Gitea requires HTTPS; GITEA_ALLOW_HTTP is for local demonstrations only');
  }
  if (!config.token || !config.username || config.webhookSecrets.length === 0) {
    throw new Error('Gitea token, username and webhook secret are required');
  }
  if (config.webhookSecrets.some((secret) => !secret)) throw new Error('Gitea webhook secret is empty');
}

interface GiteaTransport {
  (method: string, path: string, body?: unknown): Promise<unknown>;
}

export class GiteaApiError extends Error {
  constructor(readonly status: number) {
    super(`Gitea API returned HTTP ${status}`);
  }
}

function pathFor(fullName: string): string {
  const parts = fullName.split('/');
  if (parts.length !== 2 || parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Expected an owner/repository name');
  }
  return `/repos/${parts.map(encodeURIComponent).join('/')}`;
}

function safeSha(sha: string): string {
  if (!/^[0-9a-f]{40,64}$/i.test(sha)) throw new Error('Expected a full commit SHA');
  return sha;
}

/** API errors intentionally include status only: request headers and bodies can contain secrets. */
export class GiteaProvider implements ForgeProvider {
  readonly kind = 'gitea' as const;
  private readonly base: URL;
  private readonly transport: GiteaTransport;

  constructor(private readonly config: GiteaConfig, transport?: GiteaTransport) {
    validateGiteaConfig(config);
    this.base = new URL(config.baseUrl.replace(/\/+$/, '') + '/');
    this.transport = transport || this.request.bind(this);
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const url = new URL(`api/v1${path.replace(/^\//, '/')}`, this.base);
    const payload = body == null ? undefined : Buffer.from(JSON.stringify(body));
    const agent = url.protocol === 'https:' ? https : http;
    const ca = this.config.caFile ? readFileSync(this.config.caFile) : undefined;
    return new Promise((resolve, reject) => {
      const req = agent.request(
        url,
        {
          method,
          ca,
          timeout: 15_000,
          headers: {
            Authorization: `token ${this.config.token}`,
            Accept: 'application/json',
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          res.on('end', () => {
            const status = res.statusCode || 0;
            if (status < 200 || status >= 300) return reject(new GiteaApiError(status));
            const response = Buffer.concat(chunks).toString('utf8');
            try {
              resolve(response ? JSON.parse(response) : null);
            } catch {
              reject(new Error('Invalid Gitea API JSON response'));
            }
          });
        }
      );
      req.on('timeout', () => req.destroy(new Error('Gitea API request timed out')));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  private repositoryId(id: number): ForgeRepositoryId {
    if (!Number.isSafeInteger(id)) throw new Error('Invalid Gitea repository ID');
    return { provider: 'gitea', instance: this.base.origin + this.base.pathname.replace(/\/$/, ''), repositoryId: String(id) };
  }

  private normaliseRepository(data: any): ForgeRepository {
    if (!data?.full_name || !data?.html_url) throw new Error('Incomplete Gitea repository response');
    return { id: this.repositoryId(data.id), fullName: data.full_name, url: data.html_url };
  }

  async getRepository(fullName: string): Promise<ForgeRepository> {
    return this.normaliseRepository(await this.transport('GET', pathFor(fullName)));
  }

  async getPullRequest(fullName: string, number: number): Promise<ForgePullRequest> {
    if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid pull request number');
    const data: any = await this.transport('GET', `${pathFor(fullName)}/pulls/${number}`);
    if (!data?.head?.sha || !data?.head?.ref || !data?.head?.repo || !data?.base?.repo || !data?.html_url ||
        !['open', 'closed'].includes(data.state)) {
      throw new Error('Incomplete Gitea pull request response');
    }
    const repository = this.normaliseRepository(data.base.repo);
    const headRepository = this.normaliseRepository(data.head.repo);
    return {
      id: { repository: repository.id, number },
      title: data.title || '',
      state: data.state === 'open' ? 'open' : 'closed',
      head: { repository: headRepository.id, sha: safeSha(data.head.sha) },
      headBranch: data.head.ref,
      headRepository,
      labels: Array.isArray(data.labels) ? data.labels.map((label: any) => label.name).filter(Boolean) : [],
      url: data.html_url,
      author: data.user?.login || '',
    };
  }

  async getFileAtCommit(fullName: string, sha: string, filePath: string): Promise<string | null> {
    safeSha(sha);
    if (!filePath || filePath.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error('Invalid repository file path');
    }
    const path = `${pathFor(fullName)}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`;
    try {
      const file: any = await this.transport('GET', path);
      if (file?.type !== 'file' || file?.encoding !== 'base64' || typeof file?.content !== 'string') {
        throw new Error('Unexpected Gitea file response');
      }
      return Buffer.from(file.content, 'base64').toString('utf8');
    } catch (error) {
      if (error instanceof GiteaApiError && error.status === 404) return null;
      throw error;
    }
  }

  async getCloneAccess(repository: ForgeRepository): Promise<ForgeCloneAccess> {
    if (repository.id.provider !== 'gitea' || repository.id.instance !== this.repositoryId(Number(repository.id.repositoryId)).instance) {
      throw new Error('Repository belongs to another forge');
    }
    pathFor(repository.fullName);
    return {
      url: new URL(`${repository.fullName}.git`, this.base).toString(),
      username: this.config.username,
      password: this.config.token,
      ...(this.config.caFile ? { caPem: readFileSync(this.config.caFile, 'utf8') } : {}),
    };
  }

  async upsertPullRequestComment(pr: ForgePullRequestId, marker: string, body: string, existingId?: number): Promise<number> {
    if (pr.repository.provider !== 'gitea' || pr.repository.instance !== this.repositoryId(Number(pr.repository.repositoryId)).instance) {
      throw new Error('Pull request belongs to another forge');
    }
    if (!/^<!--[a-zA-Z0-9 _:-]+-->$/.test(marker)) throw new Error('Invalid comment marker');
    const repo = await this.getRepositoryById(pr.repository);
    const issuePath = `${pathFor(repo.fullName)}/issues`;
    const message = `${marker}\n${body}`;
    let id = existingId;
    if (!id) {
      for (let page = 1; page <= 20; page++) {
        const comments: any = await this.transport('GET', `${issuePath}/${pr.number}/comments?page=${page}&limit=50`);
        if (!Array.isArray(comments)) throw new Error('Unexpected Gitea comments response');
        id = comments.find((comment: any) => typeof comment.body === 'string' && comment.body.startsWith(marker))?.id;
        if (id || comments.length < 50) break;
        if (page === 20) throw new Error('Gitea comment search exceeded 1,000 comments');
      }
    }
    try {
      const result: any = await this.transport(
        id ? 'PATCH' : 'POST',
        id ? `${issuePath}/comments/${id}` : `${issuePath}/${pr.number}/comments`,
        { body: message }
      );
      if (!Number.isSafeInteger(result?.id)) throw new Error('Invalid Gitea comment response');
      return result.id;
    } catch (error) {
      if (id && error instanceof GiteaApiError && error.status === 404) {
        const result: any = await this.transport('POST', `${issuePath}/${pr.number}/comments`, { body: message });
        if (!Number.isSafeInteger(result?.id)) throw new Error('Invalid Gitea comment response');
        return result.id;
      }
      throw error;
    }
  }

  private async getRepositoryById(id: ForgeRepositoryId): Promise<ForgeRepository> {
    // Gitea's issue-comment routes require owner/name; lookup by stable numeric ID
    // avoids persisting a mutable full name in the PR identity.
    return this.normaliseRepository(await this.transport('GET', `/repositories/${encodeURIComponent(id.repositoryId)}`));
  }
}
