import type { Knex } from 'knex';

/** GitHub's existing IDs remain available while Gitea rows use a separate identity. */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('repositories', (table) => {
    table.string('forgeProvider', 32).notNullable().defaultTo('github');
    table.string('forgeInstance', 2048).nullable();
    table.string('forgeRepositoryId', 128).nullable();
  });
  await knex.raw(`UPDATE repositories SET "forgeInstance" = 'https://github.com',
    "forgeRepositoryId" = "githubRepositoryId"::text WHERE "forgeProvider" = 'github'`);
  await knex.schema.alterTable('repositories', (table) => {
    table.integer('githubRepositoryId').nullable().alter();
    table.integer('githubInstallationId').nullable().alter();
  });
  await knex.raw(`CREATE UNIQUE INDEX repositories_gitea_identity_unique
    ON repositories ("forgeProvider", "forgeInstance", "forgeRepositoryId")
    WHERE "forgeProvider" = 'gitea' AND "deletedAt" IS NULL`);

  await knex.schema.alterTable('pull_requests', (table) => {
    table.bigInteger('githubPullRequestId').nullable().alter();
  });
  await knex.raw(`CREATE UNIQUE INDEX pull_requests_forge_number_unique
    ON pull_requests ("repositoryId", "pullRequestNumber")
    WHERE "githubPullRequestId" IS NULL AND "deletedAt" IS NULL`);
}

export async function down(knex: Knex): Promise<void> {
  const gitea = await knex('repositories').where('forgeProvider', 'gitea').first('id');
  if (gitea) throw new Error('Remove Gitea repository and PR rows before reverting forge identity');
  await knex.raw('DROP INDEX pull_requests_forge_number_unique');
  await knex.raw('DROP INDEX repositories_gitea_identity_unique');
  await knex.schema.alterTable('pull_requests', (table) => table.bigInteger('githubPullRequestId').notNullable().alter());
  await knex.schema.alterTable('repositories', (table) => {
    table.integer('githubRepositoryId').notNullable().alter();
    table.integer('githubInstallationId').notNullable().alter();
    table.dropColumns('forgeProvider', 'forgeInstance', 'forgeRepositoryId');
  });
}
