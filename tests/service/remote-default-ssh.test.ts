import { describe, expect, it } from 'vitest';
import { previewDefaultSSH } from '../../src/remote/security';

const home = '/owned/home';

describe('default SSH configuration preview', () => {
  it('uses the first applicable value, resolves tilde paths, and preserves jump order', () => {
    const preview = previewDefaultSSH(`
      Host Jump
        HostName jump.example
        Port 2200
      Host compute compute-alt
        HostName=compute.example
        Port 2222
        IdentityFile "~/.ssh/compute key"
        IdentityAgent $SSH_AUTH_SOCK
        StrictHostKeyChecking no
        UserKnownHostsFile /dev/null
        ProxyJump jump
      Host compute
        HostName ignored.example
      Host *
        User owned
        Port 22
        AddKeysToAgent yes
        UseKeychain yes
        StrictHostKeyChecking accept-new
    `, home);
    expect(preview.skipped).toEqual([]);
    expect(preview.omitted).toEqual([]);
    expect(preview.aliases).toEqual([
      [{ alias: 'Jump', host: 'jump.example', user: 'owned', port: 2200 }],
      ...['compute', 'compute-alt'].map((alias) => [
        { alias: 'jump', host: 'jump.example', user: 'owned', port: 2200 },
        {
          alias, host: 'compute.example', user: 'owned', port: 2222,
          identityFile: '/owned/home/.ssh/compute key', agent: 'environment',
        },
      ]),
    ]);
  });

  it('reports omitted sections and rejects a command or ambiguous jump for the affected alias', () => {
    const preview = previewDefaultSSH(`
      Include conf.d/*.conf
      Host special-*
        HostName ignored.example
      Match exec "ignored-command"
        User ignored
      Host plain
        HostName plain.example
        ProxyJump none
      Host hooked
        HostName hooked.example
        ProxyCommand ignored-command
      Host unresolved
        HostName unresolved.example
        ProxyJump undisclosed
      Host *
        User owned
    `, home);
    expect(preview.omitted).toEqual(['Include', 'Host 通配模式', 'Match']);
    expect(preview.aliases).toEqual([[{ alias: 'plain', host: 'plain.example', user: 'owned', port: 22 }]]);
    expect(preview.skipped).toEqual([
      { alias: 'hooked', reason: expect.stringContaining('ProxyCommand') },
      { alias: 'unresolved', reason: expect.stringContaining('跳板') },
    ]);
    expect(JSON.stringify(preview)).not.toContain('ignored-command');
  });

  it('leaves multiple identities and a cyclic jump route for manual review', () => {
    const preview = previewDefaultSSH(`
      Host multiple
        HostName multiple.example
        IdentityFile ~/.ssh/first
        IdentityFile ~/.ssh/second
      Host cycle
        HostName cycle.example
        ProxyJump CYCLE
      Host *
        User owned
    `, home);
    expect(preview.aliases).toEqual([]);
    expect(preview.skipped).toEqual([
      { alias: 'multiple', reason: expect.stringContaining('多个 identityfile') },
      { alias: 'cycle', reason: expect.stringContaining('SSH jump cycle') },
    ]);
  });
});
