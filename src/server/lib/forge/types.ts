/** Stable identity shared by forge adapters and the PR lifecycle. */
export interface ForgeRepositoryId {
  provider: 'github' | 'gitea';
  instance: string;
  repositoryId: string;
}

export interface ForgePullRequestId {
  repository: ForgeRepositoryId;
  number: number;
}

export interface ForgeCommitId {
  repository: ForgeRepositoryId;
  sha: string;
}

export interface ForgeRepository {
  id: ForgeRepositoryId;
  fullName: string;
  url: string;
}

export interface ForgePullRequest {
  id: ForgePullRequestId;
  title: string;
  state: 'open' | 'closed';
  head: ForgeCommitId;
  headBranch: string;
  headRepository: ForgeRepository;
  labels: string[];
  url: string;
  author: string;
}

export interface ForgeCloneAccess {
  url: string;
  username: string;
  password: string;
}

export interface ForgeProvider {
  readonly kind: ForgeRepositoryId['provider'];
  getRepository(fullName: string): Promise<ForgeRepository>;
  getPullRequest(fullName: string, number: number): Promise<ForgePullRequest>;
  getFileAtCommit(fullName: string, sha: string, path: string): Promise<string | null>;
  getCloneAccess(repository: ForgeRepository): Promise<ForgeCloneAccess>;
  upsertPullRequestComment(pr: ForgePullRequestId, marker: string, body: string, existingId?: number): Promise<number>;
}
