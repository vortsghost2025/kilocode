import { describe, expect, test } from "bun:test"
import { getKiloUrlFromToken, isValidKilocodeToken, getApiKey } from "../../src/auth/token"

describe("getKiloUrlFromToken", () => {
  test("empty token returns default URL", () => {
    expect(getKiloUrlFromToken("https://default.test", "")).toBe("https://default.test")
  })

  test("ordinary token returns default URL", () => {
    expect(getKiloUrlFromToken("https://default.test", "sk-abc123")).toBe("https://default.test")
  })

  test("URL-prefixed token extracts the URL", () => {
    expect(getKiloUrlFromToken("https://default.test", "https://custom.test:token123")).toBe("https://custom.test")
  })

  test("URL with explicit numeric port", () => {
    expect(getKiloUrlFromToken("https://default.test", "https://localhost:8080:token123")).toBe(
      "https://localhost:8080",
    )
  })

  test("URL with path prefix", () => {
    expect(getKiloUrlFromToken("https://default.test", "https://proxy.test/v1:token123")).toBe("https://proxy.test/v1")
  })

  test("malformed URL falls back safely", () => {
    expect(getKiloUrlFromToken("https://default.test", "not-a-url:token123")).toBe("https://default.test")
  })

  test("token with http (not https) prefix", () => {
    expect(getKiloUrlFromToken("https://default.test", "http://local.test:abc")).toBe("http://local.test")
  })
})

describe("isValidKilocodeToken", () => {
  test("returns false for empty token", () => {
    expect(isValidKilocodeToken("")).toBe(false)
  })

  test("returns false for short token", () => {
    expect(isValidKilocodeToken("abc")).toBe(false)
  })

  test("returns true for token with sufficient length", () => {
    expect(isValidKilocodeToken("sk-abc123def456")).toBe(true)
  })

  test("returns false for non-string input", () => {
    expect(isValidKilocodeToken(null as unknown as string)).toBe(false)
    expect(isValidKilocodeToken(undefined as unknown as string)).toBe(false)
  })
})

describe("getApiKey", () => {
  test("prefers kilocodeToken over apiKey", () => {
    expect(getApiKey({ kilocodeToken: "token", apiKey: "key" })).toBe("token")
  })

  test("falls back to apiKey", () => {
    expect(getApiKey({ apiKey: "key" })).toBe("key")
  })

  test("returns undefined when neither provided", () => {
    expect(getApiKey({})).toBeUndefined()
  })
})
