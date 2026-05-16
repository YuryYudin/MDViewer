# SSH integration test fixtures

These keypairs are **test-only**. They exist solely to drive the local
sshd that `ssh_integration_phase1.rs` (and any future WDIO sshd-fixture
helper) brings up against a random port on `127.0.0.1`.

- `id_test`, `id_test.pub` — client keypair, no passphrase
- `authorized_keys` — single line, equal to `id_test.pub`
- `test_host_key`, `test_host_key.pub` — host keypair for the sshd
- `sshd_config.template` — stripped-down sshd config (no PAM, no
  GSSAPI, `ListenAddress 127.0.0.1`)

Never re-use these keys outside this repo. They were generated with
`ssh-keygen -t ed25519 -N ""` at commit time and are intentionally
committed so the test suite does not re-keygen on every run (which
adds 100-300ms per test and prevents reproducing failures with stable
fingerprints).

The fixture helper at `tests/common/ssh_fixture.rs` substitutes
`__PORT__` / `__HOST_KEY__` / `__AUTHKEYS__` / `__PIDFILE__` into the
template at runtime against a tmpdir-rooted rendered config.
