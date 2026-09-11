# Working on @nestarc/webhook

For **using** the package, read [README.md](./README.md), [docs/usage.md](./docs/usage.md), and the types in the installed package. The [quick start](./examples/quick-start/README.md) is the executable consumer example. Dated development reports are historical, not API contracts.

For **maintaining** this repository:

- Preserve tenant filters, event/delivery transaction boundaries, and queued URL/secret snapshots. Do not claim exactly-once HTTP delivery.
- Distinguish unreleased fixes from published package behavior in documentation.
- Keep optional adapter extensions compatible with existing implementations and describe their capabilities.
- Validate behavior changes with focused unit tests and PostgreSQL E2E tests when SQL/transactions change. `npm run lint` and `npm run build` check types/build.
- `npm run test:consumer:modern` checks the packed artifact's public types, loading, and dependency integrity. `npm run test:consumer:quick-start` checks an installed consumer against a test PostgreSQL database and HTTP receiver.
- E2E tests clear their configured webhook tables: use only the dedicated test database described in the repository, never an application database.
- Update the README, consumer contract, changelog, and applicable official site documentation together. Do not publish a package or deploy documentation merely to run verification.
