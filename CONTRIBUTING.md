# Contributing

- Run the tests: `npm test` (needs Node 18+ only).
- Zero-dependency rule: no npm packages, no build step beyond what is in the repo. Use Node built-ins.
- Keep changes small and add a test that fails before the change.
- Tests use a scripted fake `claude`; never run a real `claude` in tests.
- Schemas in `schemas/` are vendored from aos-1-spec; change them there first.
