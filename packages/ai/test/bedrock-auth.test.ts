import { NodeFileSystem } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect, FileSystem } from "effect"
import { Headers } from "effect/unstable/http"
import { BedrockAuth } from "../src/protocols/utils/bedrock-auth.js"
import { testEffect } from "./lib/effect.js"
import { withProcessEnv } from "./lib/env.js"

const it = testEffect(NodeFileSystem.layer)

describe("Bedrock AWS credential chain", () => {
  it.live("re-reads shared credentials after rotation without rebuilding auth", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(
        `${dir}/credentials`,
        "[default]\naws_access_key_id = AKIAFIRST\naws_secret_access_key = first-secret\naws_session_token = first-token\n",
      )
      yield* Effect.gen(function* () {
        const auth = BedrockAuth.resolveAuth({}, "us-west-2")
        const request = {
          request: {},
          method: "POST" as const,
          url: "https://bedrock-runtime.us-west-2.amazonaws.com/model/test/converse-stream",
          body: "{}",
          headers: Headers.empty,
        }
        const first = yield* auth.apply(request)
        expect(first.authorization).toContain("Credential=AKIAFIRST/")
        expect(first.authorization).toContain("/us-west-2/bedrock/aws4_request")
        expect(first["x-amz-security-token"]).toBe("first-token")
        yield* fs.writeFileString(
          `${dir}/credentials`,
          "[default]\naws_access_key_id = AKIASECOND\naws_secret_access_key = second-secret\naws_session_token = second-token\n",
        )
        const second = yield* auth.apply(request)
        expect(second.authorization).toContain("Credential=AKIASECOND/")
        expect(second["x-amz-security-token"]).toBe("second-token")
      }).pipe(
        withProcessEnv({
          AWS_PROFILE: undefined,
          AWS_ACCESS_KEY_ID: undefined,
          AWS_SECRET_ACCESS_KEY: undefined,
          AWS_SESSION_TOKEN: undefined,
          AWS_BEARER_TOKEN_BEDROCK: undefined,
          AWS_CONFIG_FILE: `${dir}/config`,
          AWS_SHARED_CREDENTIALS_FILE: `${dir}/credentials`,
          AWS_WEB_IDENTITY_TOKEN_FILE: undefined,
          AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: undefined,
          AWS_CONTAINER_CREDENTIALS_FULL_URI: undefined,
          AWS_EC2_METADATA_DISABLED: "true",
        }),
      )
    }),
  )
})
