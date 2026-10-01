import type { NextApiRequest, NextApiResponse } from 'next';
import { giteaConfigFromEnvironment } from 'server/lib/forge/gitea';
import { parseGiteaDelivery, verifyGiteaSignature } from 'server/lib/forge/giteaWebhook';
import { getLogger } from 'server/lib/logger';
import createAndBindServices from 'server/services';
import BootstrapJobs from 'server/jobs';
import { LIFECYCLE_MODE } from 'shared/index';

export const config = { api: { bodyParser: false } };
const MAX_BODY_BYTES = 1024 * 1024;
const services = createAndBindServices();

async function readRawBody(req: NextApiRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_BODY_BYTES) throw new Error('Gitea webhook body exceeds limit');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

export default async function giteaWebhook(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') return void res.status(405).end();
  if (!['web', 'all'].includes(LIFECYCLE_MODE)) return void res.status(503).end();
  let forgeConfig;
  try {
    forgeConfig = giteaConfigFromEnvironment();
  } catch {
    return void res.status(503).end();
  }
  if (!forgeConfig || !process.env.GITEA_REPOSITORY || !process.env.GITEA_ENVIRONMENT_ID) {
    return void res.status(503).end();
  }

  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req);
  } catch {
    return void res.status(413).end();
  }
  if (!verifyGiteaSignature(rawBody, req.headers['x-gitea-signature'], forgeConfig.webhookSecrets)) {
    return void res.status(401).end();
  }

  let delivery;
  try {
    delivery = parseGiteaDelivery(req.headers, rawBody, forgeConfig.webhookSecrets);
  } catch {
    return void res.status(400).end();
  }
  if (!delivery || delivery.repositoryFullName !== process.env.GITEA_REPOSITORY) {
    return void res.status(202).end();
  }

  try {
    if (LIFECYCLE_MODE === 'all') BootstrapJobs(services);
    await services.GiteaService.enqueueDelivery(delivery);
    getLogger({ deliveryId: delivery.deliveryId }).info('Gitea: webhook queued');
    return void res.status(202).end();
  } catch (error) {
    getLogger({ error: error instanceof Error ? error.message : 'unknown' }).error('Gitea: webhook queue failed');
    return void res.status(503).end();
  }
}
