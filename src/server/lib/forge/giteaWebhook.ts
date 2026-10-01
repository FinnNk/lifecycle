import { createHmac, timingSafeEqual } from 'crypto';

export type GiteaAction = 'opened' | 'synchronised' | 'reopened' | 'labelled' | 'closed';

export interface GiteaDelivery {
  deliveryId: string;
  action: GiteaAction;
  repositoryFullName: string;
  repositoryId: number;
  pullRequestNumber: number;
}

type Header = string | string[] | undefined;

function single(value: Header): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Gitea's native signature is a bare hexadecimal HMAC-SHA256 of the original bytes. */
export function verifyGiteaSignature(rawBody: Buffer, signature: Header, secrets: string[]): boolean {
  const incoming = single(signature);
  if (!incoming || !/^[0-9a-f]{64}$/.test(incoming)) return false;
  const digest = Buffer.from(incoming, 'hex');
  return secrets.some((secret) => {
    if (!secret) return false;
    const expected = createHmac('sha256', secret).update(rawBody).digest();
    return timingSafeEqual(digest, expected);
  });
}

/** Parse only the event fields required to enqueue a current-state reconciliation. */
export function parseGiteaDelivery(
  headers: Record<string, Header>,
  rawBody: Buffer,
  secrets: string[]
): GiteaDelivery | null {
  if (!verifyGiteaSignature(rawBody, headers['x-gitea-signature'], secrets)) {
    throw new Error('Invalid Gitea webhook signature');
  }

  const deliveryId = single(headers['x-gitea-delivery']);
  if (!deliveryId || !/^[a-zA-Z0-9-]{8,128}$/.test(deliveryId)) {
    throw new Error('Invalid Gitea delivery ID');
  }

  const event = single(headers['x-gitea-event']);
  const eventType = single(headers['x-gitea-event-type']) || event;
  const body = JSON.parse(rawBody.toString('utf8'));
  const actions: Record<string, Record<string, GiteaAction>> = {
    pull_request: { opened: 'opened', reopened: 'reopened', closed: 'closed' },
    pull_request_sync: { synchronized: 'synchronised' },
    pull_request_label: { label_updated: 'labelled', label_cleared: 'labelled' },
  };
  // Some Gitea versions send the specific event in X-Gitea-Event; accept either
  // representation, but never infer it from GitHub compatibility headers.
  const action = actions[eventType || '']?.[body?.action];
  if (!action) return null;

  const repositoryFullName = body?.repository?.full_name;
  const repositoryId = body?.repository?.id;
  const pullRequestNumber = body?.number;
  if (
    typeof repositoryFullName !== 'string' ||
    !/^[^/]+\/[^/]+$/.test(repositoryFullName) ||
    !Number.isSafeInteger(repositoryId) ||
    !Number.isSafeInteger(pullRequestNumber) ||
    pullRequestNumber < 1
  ) {
    throw new Error('Invalid Gitea pull request payload');
  }

  return { deliveryId, action, repositoryFullName, repositoryId, pullRequestNumber };
}
