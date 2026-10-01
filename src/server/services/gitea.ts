import { UniqueViolationError } from 'objection';
import { GiteaApiError, GiteaProvider, giteaConfigFromEnvironment } from 'server/lib/forge/gitea';
import type { GiteaDelivery } from 'server/lib/forge/giteaWebhook';
import { getLogger } from 'server/lib/logger';
import { redisClient } from 'server/lib/dependencies';
import { QUEUE_NAMES } from 'shared/config';
import { withAuthorityLock } from 'server/lib/authorityLock';
import BaseService from './_service';

const DEDUPLICATION_SECONDS = 7 * 24 * 60 * 60;

/** Gitea intake always reads the live PR; deliveries are signals, not state snapshots. */
export default class GiteaService extends BaseService {
  webhookQueue = this.queueManager.registerQueue(QUEUE_NAMES.GITEA_WEBHOOK_PROCESSING, {
    connection: redisClient.getConnection(),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: { age: DEDUPLICATION_SECONDS, count: 100_000 },
      removeOnFail: true,
    },
  });

  async enqueueDelivery(delivery: GiteaDelivery): Promise<void> {
    await this.webhookQueue.add('gitea-pr', delivery, { jobId: `gitea-${delivery.deliveryId}` });
  }

  processWebhooks = async (job: { data: GiteaDelivery }): Promise<void> => {
    const delivery = job.data;
    const configuredRepository = process.env.GITEA_REPOSITORY;
    if (!configuredRepository || configuredRepository !== delivery.repositoryFullName) return;

    const environmentId = Number(process.env.GITEA_ENVIRONMENT_ID);
    if (!Number.isSafeInteger(environmentId) || environmentId < 1) {
      throw new Error('GITEA_ENVIRONMENT_ID must identify an existing environment');
    }

    const config = giteaConfigFromEnvironment();
    if (!config) throw new Error('Gitea configuration is missing');
    const provider = new GiteaProvider(config);
    const resource = `gitea-pr.${delivery.repositoryId}.${delivery.pullRequestNumber}`;
    const deadline = Date.now() + 120_000;
    const result = await withAuthorityLock({
      redlock: this.redlock,
      resource,
      ttlMs: 60_000,
      isCurrent: async () => Date.now() < deadline,
      action: async () => {
        const forgeRepository = await provider.getRepository(configuredRepository);
        if (forgeRepository.id.repositoryId !== String(delivery.repositoryId)) {
          getLogger({ deliveryId: delivery.deliveryId }).warn('Gitea: repository identity changed; delivery ignored');
          return;
        }

        const repository = await this.findOrCreateRepository(forgeRepository, environmentId);
        const existing = await this.db.models.PullRequest.query()
          .findOne({ repositoryId: repository.id, pullRequestNumber: delivery.pullRequestNumber })
          .whereNull('deletedAt');

        try {
          const pr = await provider.getPullRequest(configuredRepository, delivery.pullRequestNumber);
          if (pr.id.repository.repositoryId !== forgeRepository.id.repositoryId) {
            throw new Error('Gitea PR belongs to a different repository');
          }
          const attributes = {
            repositoryId: repository.id,
            pullRequestNumber: delivery.pullRequestNumber,
            title: pr.title,
            status: pr.state,
            latestCommit: pr.head.sha,
            branchName: pr.headBranch,
            fullName: forgeRepository.fullName,
            githubLogin: pr.author,
            labels: pr.labels,
            deployOnUpdate: existing?.deployOnUpdate ?? false,
          };
          if (existing) await existing.$query().patch(attributes);
          else {
            try {
              await this.db.models.PullRequest.query().insert(attributes);
            } catch (error) {
              if (!(error instanceof UniqueViolationError)) throw error;
              await this.db.models.PullRequest.query()
                .patch(attributes)
                .where({ repositoryId: repository.id, pullRequestNumber: delivery.pullRequestNumber })
                .whereNull('deletedAt');
            }
          }
          getLogger({ deliveryId: delivery.deliveryId, repositoryId: repository.id, pullRequestNumber: delivery.pullRequestNumber })
            .info('Gitea: current pull request state stored');
        } catch (error) {
          if (!(error instanceof GiteaApiError && error.status === 404 && existing)) throw error;
          await existing.$query().patch({ status: 'closed' });
          getLogger({ deliveryId: delivery.deliveryId, repositoryId: repository.id, pullRequestNumber: delivery.pullRequestNumber })
            .info('Gitea: missing pull request marked closed');
        }
      },
    });
    if (!result.admitted) throw new Error('Gitea PR reconciliation lock timed out');
  };

  private async findOrCreateRepository(
    forgeRepository: Awaited<ReturnType<GiteaProvider['getRepository']>>,
    environmentId: number
  ) {
    const identity = {
      forgeProvider: 'gitea' as const,
      forgeInstance: forgeRepository.id.instance,
      forgeRepositoryId: forgeRepository.id.repositoryId,
    };
    let repository = await this.db.models.Repository.query().findOne(identity).whereNull('deletedAt');
    if (!repository) {
      const environment = await this.db.models.Environment.query().findById(environmentId);
      if (!environment) throw new Error('GITEA_ENVIRONMENT_ID does not exist');
      try {
        repository = await this.db.models.Repository.query().insertAndFetch({
          ...identity,
          fullName: forgeRepository.fullName,
          htmlUrl: forgeRepository.url,
          defaultEnvId: environmentId,
        });
      } catch (error) {
        if (!(error instanceof UniqueViolationError)) throw error;
        repository = await this.db.models.Repository.query().findOne(identity).whereNull('deletedAt');
        if (!repository) throw error;
      }
    }
    if (repository.fullName !== forgeRepository.fullName || repository.htmlUrl !== forgeRepository.url) {
      await repository.$query().patch({ fullName: forgeRepository.fullName, htmlUrl: forgeRepository.url });
    }
    return repository;
  }
}
