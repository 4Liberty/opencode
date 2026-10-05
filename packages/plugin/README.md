# `@opencode/plugin`

Authoring interfaces and runtime loader support for OpenCode V2 plugins:

- `@opencode/plugin` — [Promise plugin API](./src/README.md)
- `@opencode/plugin/effect` — [Effect plugin API](./src/effect/README.md)
- `@opencode/plugin/rpc` — portable RPC contract definitions
- `@opencode/plugin/tui` — terminal UI plugin API

## Packaging And Runtime `effect`

OpenCode resolves imports of `effect`, every exported `effect/*` subpath, and `@opencode/plugin` entrypoints (including transitive imports from dependencies inside a plugin's `node_modules`) to the host's runtime module instances.

- Declare `effect` as a `peerDependency` (and `devDependency` for local type-checking/testing) rather than bundling it.
- Do not bundle `effect` into published plugin files; if you build with a bundler, keep `effect` and `effect/*` external. OpenCode detects and rejects Effect plugins whose returned `Effect` comes from a bundled copy.
- At runtime, plugins execute against the host OpenCode release's `effect` version, so plugins must use `effect` APIs and module paths compatible with the OpenCode release they target.
