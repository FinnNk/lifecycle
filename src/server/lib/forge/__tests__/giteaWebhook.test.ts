import { createHmac } from 'crypto';
import { parseGiteaDelivery, verifyGiteaSignature } from '../giteaWebhook';

const secret = 'test-secret';
const body = Buffer.from(JSON.stringify({
  action: 'opened',
  number: 17,
  repository: { id: 42, full_name: 'example/app' },
}));
const signature = createHmac('sha256', secret).update(body).digest('hex');
const headers = {
  'x-gitea-delivery': '12345678-1234-1234-1234-123456789abc',
  'x-gitea-event': 'pull_request',
  'x-gitea-event-type': 'pull_request',
  'x-gitea-signature': signature,
};

describe('Gitea webhook delivery', () => {
  it('verifies exact raw bytes and accepts either secret during rotation', () => {
    expect(verifyGiteaSignature(body, signature, ['new-secret', secret])).toBe(true);
    expect(verifyGiteaSignature(Buffer.concat([body, Buffer.from(' ')]), signature, [secret])).toBe(false);
    expect(verifyGiteaSignature(body, 'a', [secret])).toBe(false);
    expect(() => parseGiteaDelivery({ ...headers, 'x-gitea-signature': '0'.repeat(64) }, body, [secret])).toThrow(
      'Invalid Gitea webhook signature'
    );
  });

  it.each([
    ['pull_request', 'opened', 'opened'],
    ['pull_request', 'reopened', 'reopened'],
    ['pull_request', 'closed', 'closed'],
    ['pull_request_sync', 'synchronized', 'synchronised'],
    ['pull_request_label', 'label_updated', 'labelled'],
    ['pull_request_label', 'label_cleared', 'labelled'],
  ])('maps %s %s to %s', (eventType, action, expected) => {
    const payload = Buffer.from(JSON.stringify({ action, number: 17, repository: { id: 42, full_name: 'example/app' } }));
    const signedHeaders = {
      ...headers,
      'x-gitea-event-type': eventType,
      'x-gitea-signature': createHmac('sha256', secret).update(payload).digest('hex'),
    };
    expect(parseGiteaDelivery(signedHeaders, payload, [secret])).toEqual({
      deliveryId: headers['x-gitea-delivery'],
      action: expected,
      repositoryFullName: 'example/app',
      repositoryId: 42,
      pullRequestNumber: 17,
    });
  });

  it('does not use GitHub compatibility headers or accept malformed identity', () => {
    expect(parseGiteaDelivery({ ...headers, 'x-gitea-event-type': 'push' }, body, [secret])).toBeNull();
    expect(() => parseGiteaDelivery({ ...headers, 'x-gitea-delivery': '' }, body, [secret])).toThrow(
      'Invalid Gitea delivery ID'
    );
  });
});
