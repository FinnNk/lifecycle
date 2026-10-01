import * as k8s from '@kubernetes/client-node';
import { createHash } from 'crypto';
import type { ForgeCloneAccess } from 'server/lib/forge/types';
import { getLogger } from 'server/lib/logger';

const CA_MOUNT = '/etc/lifecycle-forge-ca';

function coreApi(): k8s.CoreV1Api {
  const config = new k8s.KubeConfig();
  config.loadFromDefault();
  return config.makeApiClient(k8s.CoreV1Api);
}

/** The Secret is passed to Kubernetes directly; its contents never enter kubectl YAML or logs. */
export async function createForgeCloneSecret(namespace: string, name: string, access: ForgeCloneAccess): Promise<void> {
  const secret: k8s.V1Secret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name, namespace },
    type: 'Opaque',
    stringData: {
      username: access.username,
      password: access.password,
      ...(access.caPem ? { 'ca.crt': access.caPem } : {}),
    },
  };
  try {
    await coreApi().createNamespacedSecret(namespace, secret);
  } catch {
    throw new Error(`Build: forge clone Secret creation failed secretName=${name} namespace=${namespace}`);
  }
}

export async function deleteForgeCloneSecret(namespace: string, name: string): Promise<void> {
  try {
    await coreApi().deleteNamespacedSecret(name, namespace);
  } catch (error: any) {
    if (error instanceof k8s.HttpError && error.response?.statusCode === 404) return;
    getLogger().warn(`Build: forge clone Secret cleanup failed secretName=${name} namespace=${namespace}`);
  }
}

export function forgeCloneSecretName(jobName: string): string {
  return `forge-clone-${createHash('sha256').update(jobName).digest('hex').slice(0, 20)}`;
}

export function forgeCloneVolumes(name: string, hasCa: boolean): k8s.V1Volume[] {
  return hasCa ? [{ name: 'forge-ca', secret: { secretName: name, items: [{ key: 'ca.crt', path: 'ca.crt' }] } }] : [];
}

/** The remote URL has no credentials; Git obtains them through an askpass script and Secret refs. */
export function createForgeCloneContainer(
  access: ForgeCloneAccess,
  revision: string,
  targetDir: string,
  secretName: string
): k8s.V1Container {
  if (!/^[0-9a-f]{40,64}$/i.test(revision)) throw new Error('Forge clone requires a full commit SHA');
  const url = new URL(access.url);
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !localHttp) || url.username || url.password || url.hash || url.search) {
    throw new Error('Forge clone URL must use HTTPS or local HTTP without embedded credentials');
  }
  const script = [
    'set -eu',
    'umask 077',
    "cat > /tmp/forge-askpass <<'ASKPASS'",
    '#!/bin/sh',
    'case "$1" in',
    '  *Username*) printf %s "$GIT_USERNAME" ;;',
    '  *Password*) printf %s "$GIT_PASSWORD" ;;',
    'esac',
    'ASKPASS',
    'chmod 700 /tmp/forge-askpass',
    'export GIT_ASKPASS=/tmp/forge-askpass GIT_TERMINAL_PROMPT=0',
    'git config --global --add safe.directory "$TARGET_DIR"',
    'git init "$TARGET_DIR"',
    'git -C "$TARGET_DIR" remote add origin "$GIT_REMOTE_URL"',
    'git -C "$TARGET_DIR" fetch --depth 1 --progress origin "$GIT_REVISION"',
    'git -C "$TARGET_DIR" checkout FETCH_HEAD',
  ].join('\n');
  return {
    name: 'git-clone',
    image: 'alpine/git:latest',
    command: ['sh', '-c'],
    args: [script],
    env: [
      { name: 'GIT_REMOTE_URL', value: access.url },
      { name: 'GIT_REVISION', value: revision },
      { name: 'TARGET_DIR', value: targetDir },
      { name: 'GIT_USERNAME', valueFrom: { secretKeyRef: { name: secretName, key: 'username' } } },
      { name: 'GIT_PASSWORD', valueFrom: { secretKeyRef: { name: secretName, key: 'password' } } },
      ...(access.caPem ? [{ name: 'GIT_SSL_CAINFO', value: `${CA_MOUNT}/ca.crt` }] : []),
    ],
    volumeMounts: [
      { name: 'workspace', mountPath: '/workspace' },
      ...(access.caPem ? [{ name: 'forge-ca', mountPath: CA_MOUNT, readOnly: true }] : []),
    ],
  };
}
