import type PullRequest from 'server/models/PullRequest';
import type { ForgeCloneAccess } from './types';
import { GiteaProvider, giteaConfigFromEnvironment } from './gitea';

export interface PinnedForgeSource {
  fullName: string;
  sha: string;
  cloneAccess: ForgeCloneAccess;
}

/** Resolve the current Gitea PR head without storing credentials on Build or Deploy rows. */
export async function getPinnedGiteaPullRequestSource(
  pr: PullRequest | null | undefined
): Promise<PinnedForgeSource | null> {
  if (pr?.repository?.forgeProvider !== 'gitea') return null;
  if (!pr.headRepositoryFullName || !pr.headForgeRepositoryId || !/^[0-9a-f]{40,64}$/i.test(pr.latestCommit)) {
    throw new Error('Gitea PR source identity or commit is missing');
  }
  const config = giteaConfigFromEnvironment();
  if (!config) throw new Error('Gitea configuration is missing');
  const provider = new GiteaProvider(config);
  const live = await provider.getPullRequest(pr.repository.fullName, pr.pullRequestNumber);
  if (
    live.state !== 'open' ||
    live.id.repository.instance !== pr.repository.forgeInstance ||
    live.id.repository.repositoryId !== pr.repository.forgeRepositoryId ||
    live.head.repository.repositoryId !== pr.headForgeRepositoryId ||
    live.head.sha !== pr.latestCommit
  ) {
    throw new Error('Gitea PR was closed or its head changed before the build');
  }
  const head = await provider.getRepository(pr.headRepositoryFullName);
  if (head.id.instance !== pr.repository.forgeInstance || head.id.repositoryId !== pr.headForgeRepositoryId) {
    throw new Error('Gitea PR source identity changed');
  }
  return {
    fullName: head.fullName,
    sha: pr.latestCommit,
    cloneAccess: await provider.getCloneAccess(head),
  };
}
