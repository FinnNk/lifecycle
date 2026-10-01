import type { Knex } from 'knex';

/** Keep the source fork distinct from the base repository for exact-SHA reads. */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('pull_requests', (table) => {
    table.string('headForgeRepositoryId', 128).nullable();
    table.string('headRepositoryFullName', 2048).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('pull_requests', (table) => {
    table.dropColumns('headForgeRepositoryId', 'headRepositoryFullName');
  });
}
