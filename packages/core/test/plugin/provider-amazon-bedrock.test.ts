import { describe, expect } from "bun:test"
import { Effect, FileSystem, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { TestClock } from "effect/testing"
import { createHash } from "node:crypto"
import { Integration } from "@opencode/core/integration"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { AmazonBedrockPlugin } from "@opencode/core/plugin/provider/amazon-bedrock"
import { Provider } from "@opencode/core/provider"
import { Model } from "@opencode/core/model"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(Layer.merge(PluginTestLayer, NodeFileSystem.layer))

const addPlugin = Effect.fn(function* () {
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin)
  yield* AmazonBedrockPlugin.effect(host)
})

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value")
  return value
}

function withEnv<A, E, R>(vars: Record<string, string | undefined>, fx: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]))
      Object.entries(vars).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      })
      return previous
    }),
    () => fx().pipe(Effect.scoped),
    (previous) =>
      Effect.sync(() => {
        Object.entries(previous).forEach(([key, value]) => {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        })
      }),
  )
}

const noAmbientAWS = {
  AWS_PROFILE: undefined,
  AWS_ACCESS_KEY_ID: undefined,
  AWS_SECRET_ACCESS_KEY: undefined,
  AWS_SESSION_TOKEN: undefined,
  AWS_BEARER_TOKEN_BEDROCK: undefined,
  AWS_WEB_IDENTITY_TOKEN_FILE: undefined,
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: undefined,
  AWS_CONTAINER_CREDENTIALS_FULL_URI: undefined,
  AWS_REGION: undefined,
  AWS_DEFAULT_REGION: undefined,
  AWS_CONFIG_FILE: "/nonexistent/opencode-bedrock-test/config",
  AWS_SHARED_CREDENTIALS_FILE: "/nonexistent/opencode-bedrock-test/credentials",
  AWS_EC2_METADATA_DISABLED: "true",
}

const seedBedrock = Effect.fn(function* (settings?: Provider.Settings) {
  const catalog = yield* Provider.Service
  yield* catalog.transform((catalog) => {
    catalog.update(Provider.ID.amazonBedrock, (item) => {
      item.package = "@opencode/ai/providers/amazon-bedrock"
      item.integrationID = Integration.ID.make(Provider.ID.amazonBedrock)
      if (settings) item.settings = settings
    })
  })
  return catalog
})

const eventually = <A, R>(effect: Effect.Effect<A, never, R>, predicate: (value: A) => boolean) =>
  Effect.promise(() => Bun.sleep(10)).pipe(
    Effect.andThen(effect),
    Effect.repeat({ until: predicate, times: 300 }),
    Effect.tap((value) => Effect.sync(() => expect(predicate(value)).toBe(true))),
  )

describe("AmazonBedrockPlugin", () => {
  it.live("discovers default shared credentials and exposes models without storing AWS secrets", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(
        `${dir}/credentials`,
        "[default]\naws_access_key_id = AKIATEST\naws_secret_access_key = test-secret\naws_session_token = test-session\n",
      )
      yield* withEnv({ ...noAmbientAWS, AWS_SHARED_CREDENTIALS_FILE: `${dir}/credentials` }, () =>
        Effect.gen(function* () {
          const catalog = yield* seedBedrock()
          yield* catalog.transform((editor) => {
            editor.models.update(Provider.ID.amazonBedrock, Model.ID.make("test-model"), () => {})
          })
          const models = yield* Model.Service
          yield* addPlugin()
          yield* eventually(catalog.available(), (providers) =>
            providers.some((provider) => provider.id === Provider.ID.amazonBedrock),
          )
          expect((yield* models.available()).map((model) => model.id)).toContain(Model.ID.make("test-model"))
          const integrations = yield* Integration.Service
          expect((yield* integrations.get(Integration.ID.make(Provider.ID.amazonBedrock)))?.connections).toEqual([])
          expect(required(yield* catalog.get(Provider.ID.amazonBedrock)).settings).toEqual({ region: "us-east-1" })
        }),
      )
    }),
  )

  it.live("discovers a default aws login session without AWS_PROFILE", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const session = "arn:aws:iam::123456789012:user/test"
      yield* fs.writeFileString(`${dir}/config`, `[default]\nlogin_session = ${session}\n`)
      yield* fs.writeFileString(
        `${dir}/${createHash("sha256").update(session).digest("hex")}.json`,
        JSON.stringify({
          accessToken: {
            accessKeyId: "AKIATEST",
            secretAccessKey: "test-secret",
            sessionToken: "test-session",
            accountId: "123456789012",
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          },
          clientId: "test-client",
          refreshToken: "test-refresh",
          dpopKey: "unused-for-unexpired-token",
        }),
      )
      yield* withEnv({ ...noAmbientAWS, AWS_CONFIG_FILE: `${dir}/config`, AWS_LOGIN_CACHE_DIRECTORY: dir }, () =>
        Effect.gen(function* () {
          const catalog = yield* seedBedrock()
          yield* addPlugin()
          yield* eventually(catalog.available(), (providers) =>
            providers.some((provider) => provider.id === Provider.ID.amazonBedrock),
          )
        }),
      )
    }),
  )

  it.live("discovers default credential_process credentials", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(
        `${dir}/config`,
        `[default]\ncredential_process = "${process.execPath}" "${dir}/credentials.ts"\n`,
      )
      yield* fs.writeFileString(
        `${dir}/credentials.ts`,
        `console.log(JSON.stringify({ Version: 1, AccessKeyId: "AKIATEST", SecretAccessKey: "test-secret", SessionToken: "test-session" }))`,
      )
      yield* withEnv({ ...noAmbientAWS, AWS_CONFIG_FILE: `${dir}/config` }, () =>
        Effect.gen(function* () {
          const catalog = yield* seedBedrock()
          yield* addPlugin()
          yield* eventually(catalog.available(), (providers) =>
            providers.some((provider) => provider.id === Provider.ID.amazonBedrock),
          )
        }),
      )
    }),
  )

  it.live("rechecks changed credentials after discovery fails without restarting the plugin", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const credentials = "[default]\naws_access_key_id = AKIATEST\naws_secret_access_key = test-secret\n"
      yield* fs.writeFileString(`${dir}/credentials`, credentials)
      yield* withEnv({ ...noAmbientAWS, AWS_SHARED_CREDENTIALS_FILE: `${dir}/credentials` }, () =>
        Effect.gen(function* () {
          const catalog = yield* seedBedrock()
          yield* addPlugin()
          const available = catalog
            .available()
            .pipe(Effect.map((providers) => providers.some((provider) => provider.id === Provider.ID.amazonBedrock)))
          yield* eventually(available, (value) => value)
          yield* fs.writeFileString(`${dir}/credentials`, "")
          yield* Effect.promise(() => Bun.sleep(20))
          yield* TestClock.adjust("1 minute")
          yield* eventually(available, (value) => !value)
          yield* fs.writeFileString(`${dir}/credentials`, credentials)
          yield* Effect.promise(() => Bun.sleep(20))
          yield* TestClock.adjust("1 minute")
          yield* eventually(available, (value) => value)
        }).pipe(Effect.provide(TestClock.layer())),
      )
    }),
  )

  it.live("discovers an EC2 instance role without profile or access-key environment variables", () =>
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: (request) => {
              const pathname = new URL(request.url).pathname
              if (pathname === "/latest/api/token") return new Response("test-imds-token")
              if (pathname === "/latest/meta-data/iam/security-credentials/") return new Response("test-role")
              if (pathname === "/latest/meta-data/iam/security-credentials/test-role")
                return Response.json({
                  Code: "Success",
                  AccessKeyId: "AKIATEST",
                  SecretAccessKey: "test-secret",
                  Token: "test-session",
                  Expiration: new Date(Date.now() + 3_600_000).toISOString(),
                })
              return new Response("not found", { status: 404 })
            },
          }),
        ),
        (server) => Effect.sync(() => server.stop(true)),
      )
      yield* withEnv(
        {
          ...noAmbientAWS,
          AWS_EC2_METADATA_DISABLED: undefined,
          AWS_EC2_METADATA_SERVICE_ENDPOINT: server.url.href,
        },
        () =>
          Effect.gen(function* () {
            const catalog = yield* seedBedrock()
            yield* addPlugin()
            yield* eventually(catalog.available(), (providers) =>
              providers.some((provider) => provider.id === Provider.ID.amazonBedrock),
            )
          }),
      )
    }),
  )

  it.effect("moves endpoint setting to baseURL", () =>
    withEnv(noAmbientAWS, () =>
      Effect.gen(function* () {
        const catalog = yield* seedBedrock({ endpoint: "https://bedrock.example" })
        yield* addPlugin()
        const result = required(yield* catalog.get(Provider.ID.amazonBedrock))
        expect(result.package).toBe("@opencode/ai/providers/amazon-bedrock")
        expect(result.settings).toEqual({ baseURL: "https://bedrock.example", region: "us-east-1" })
      }),
    ),
  )

  it.effect("keeps an explicit baseURL over endpoint", () =>
    withEnv(noAmbientAWS, () =>
      Effect.gen(function* () {
        const catalog = yield* seedBedrock({ baseURL: "https://base.example", endpoint: "https://endpoint.example" })
        yield* addPlugin()
        expect(required(yield* catalog.get(Provider.ID.amazonBedrock)).settings).toEqual({
          baseURL: "https://base.example",
          region: "us-east-1",
        })
      }),
    ),
  )

  it.effect("only treats the bearer token env var as a key credential", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const integrationID = Integration.ID.make(Provider.ID.amazonBedrock)
      yield* integrations.transform((editor) => {
        editor.method.update({ integrationID, method: { type: "key" } })
        editor.method.update({
          integrationID,
          method: {
            type: "env",
            names: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "AWS_BEARER_TOKEN_BEDROCK"],
          },
        })
      })
      yield* addPlugin()
      expect((yield* integrations.get(integrationID))?.methods).toEqual([
        { type: "key" },
        { type: "env", names: ["AWS_BEARER_TOKEN_BEDROCK"] },
      ])
    }),
  )

  it.effect("leaves activation on auto without ambient AWS configuration", () =>
    withEnv(noAmbientAWS, () =>
      Effect.gen(function* () {
        const catalog = yield* seedBedrock()
        yield* addPlugin()
        expect(required(yield* catalog.get(Provider.ID.amazonBedrock)).activation).toBe("auto")
      }),
    ),
  )

  for (const name of [
    "AWS_PROFILE",
    "AWS_ACCESS_KEY_ID",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  ]) {
    it.effect(`enables the provider when ${name} is set`, () =>
      withEnv({ ...noAmbientAWS, [name]: "value" }, () =>
        Effect.gen(function* () {
          const catalog = yield* seedBedrock()
          yield* addPlugin()
          expect(required(yield* catalog.get(Provider.ID.amazonBedrock)).activation).toBe("enabled")
        }),
      ),
    )
  }

  it.effect("enables the provider when a profile is configured", () =>
    withEnv(noAmbientAWS, () =>
      Effect.gen(function* () {
        const catalog = yield* seedBedrock({ profile: "work" })
        yield* addPlugin()
        const result = required(yield* catalog.get(Provider.ID.amazonBedrock))
        expect(result.activation).toBe("enabled")
        expect(result.settings).toEqual({ profile: "work", region: "us-east-1" })
      }),
    ),
  )

  it.effect("does not override a disabled provider", () =>
    withEnv({ ...noAmbientAWS, AWS_PROFILE: "work" }, () =>
      Effect.gen(function* () {
        const catalog = yield* Provider.Service
        yield* catalog.transform((catalog) => {
          catalog.update(Provider.ID.amazonBedrock, (item) => {
            item.package = "@opencode/ai/providers/amazon-bedrock"
            item.activation = "disabled"
          })
        })
        yield* addPlugin()
        expect(required(yield* catalog.get(Provider.ID.amazonBedrock)).activation).toBe("disabled")
      }),
    ),
  )

  it.effect("fills region from AWS_REGION then AWS_DEFAULT_REGION without overriding config", () =>
    withEnv({ ...noAmbientAWS, AWS_REGION: "eu-west-1", AWS_DEFAULT_REGION: "us-west-2" }, () =>
      Effect.gen(function* () {
        const catalog = yield* seedBedrock()
        yield* addPlugin()
        expect(required(yield* catalog.get(Provider.ID.amazonBedrock)).settings).toEqual({
          region: "eu-west-1",
        })

        yield* catalog.transform((catalog) => {
          catalog.update(Provider.ID.amazonBedrock, (item) => {
            item.settings = { region: "ap-southeast-2" }
          })
        })
        expect(required(yield* catalog.get(Provider.ID.amazonBedrock)).settings).toEqual({
          region: "ap-southeast-2",
        })
      }),
    ),
  )

  it.effect("falls back to AWS_DEFAULT_REGION then us-east-1", () =>
    withEnv({ ...noAmbientAWS, AWS_DEFAULT_REGION: "us-west-2" }, () =>
      Effect.gen(function* () {
        const catalog = yield* seedBedrock()
        yield* addPlugin()
        expect(required(yield* catalog.get(Provider.ID.amazonBedrock)).settings).toEqual({
          region: "us-west-2",
        })
        const fallback = yield* Effect.gen(function* () {
          yield* catalog.reload()
          return required(yield* catalog.get(Provider.ID.amazonBedrock)).settings
        }).pipe((fx) => withEnv({ AWS_DEFAULT_REGION: undefined }, () => fx))
        expect(fallback).toEqual({ region: "us-east-1" })
      }),
    ),
  )

  it.effect("applies to Mantle and native Bedrock packages", () =>
    withEnv({ ...noAmbientAWS, AWS_PROFILE: "work" }, () =>
      Effect.gen(function* () {
        const catalog = yield* Provider.Service
        yield* catalog.transform((catalog) => {
          catalog.update(Provider.ID.make("mantle"), (item) => {
            item.package = "@opencode/ai/providers/amazon-bedrock/mantle/responses"
          })
          catalog.update(Provider.ID.make("native"), (item) => {
            item.package = "@opencode/ai/providers/amazon-bedrock"
          })
          catalog.update(Provider.ID.make("other"), (item) => {
            item.package = "@opencode/ai/providers/anthropic"
          })
        })
        yield* addPlugin()
        expect(required(yield* catalog.get(Provider.ID.make("mantle"))).activation).toBe("enabled")
        expect(required(yield* catalog.get(Provider.ID.make("native"))).activation).toBe("enabled")
        expect(required(yield* catalog.get(Provider.ID.make("other"))).activation).toBe("auto")
      }),
    ),
  )
})
