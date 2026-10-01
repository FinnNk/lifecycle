import { createForgeCloneContainer, forgeCloneVolumes } from '../forgeClone';

const access = {
  url: 'https://gitea.example.test/owner/app.git',
  username: 'bot',
  password: 'secret-token',
  caPem: 'trusted-ca',
};

describe('forge clone init container', () => {
  it('uses a Secret and a trusted CA without embedding credentials in the container', () => {
    const container = createForgeCloneContainer(access, 'a'.repeat(40), '/workspace/source', 'clone-secret');
    const manifest = JSON.stringify(container);
    expect(manifest).toContain('clone-secret');
    expect(manifest).toContain('GIT_SSL_CAINFO');
    expect(manifest).toContain('ASKPASS');
    expect(manifest).toContain('a'.repeat(40));
    expect(manifest).not.toContain(access.password);
    expect(manifest).not.toContain(access.username);
    expect(manifest).not.toContain(access.caPem);
    expect(forgeCloneVolumes('clone-secret', true)).toEqual([
      { name: 'forge-ca', secret: { secretName: 'clone-secret', items: [{ key: 'ca.crt', path: 'ca.crt' }] } },
    ]);
  });

  it('rejects mutable refs and URLs with embedded credentials', () => {
    expect(() => createForgeCloneContainer(access, 'main', '/workspace/source', 'clone-secret')).toThrow(
      'full commit SHA'
    );
    expect(() =>
      createForgeCloneContainer(
        { ...access, url: 'https://bot:token@gitea.example.test/app.git' },
        'a'.repeat(40),
        '/workspace/source',
        'clone-secret'
      )
    ).toThrow('without embedded credentials');
  });
});
