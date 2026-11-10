import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveLlmSettings } from "../src/config";

test("auto-configures Groq from GROQ_API_KEY", () => {
  const llm = resolveLlmSettings({ GROQ_API_KEY: "gsk_test" });
  assert.equal(llm.provider, "groq");
  assert.equal(llm.apiKey, "gsk_test");
  assert.equal(llm.baseURL, "https://api.groq.com/openai/v1");
  assert.equal(llm.model, "openai/gpt-oss-120b");
  assert.equal(llm.fastModel, "openai/gpt-oss-20b");
});

test("auto-configures OpenAI from OPENAI_API_KEY", () => {
  const llm = resolveLlmSettings({ OPENAI_API_KEY: "sk-test" });
  assert.equal(llm.provider, "openai");
  assert.equal(llm.apiKey, "sk-test");
  assert.equal(llm.baseURL, undefined);
  assert.equal(llm.model, "gpt-6.1-sol");
  assert.equal(llm.fastModel, "gpt-6-luna");
});

test("prefers free Groq when both keys are present", () => {
  const llm = resolveLlmSettings({
    GROQ_API_KEY: "gsk_test",
    OPENAI_API_KEY: "sk-test",
  });
  assert.equal(llm.provider, "groq");
  assert.equal(llm.apiKey, "gsk_test");
});

test("LLM_PROVIDER can override the default preference", () => {
  const llm = resolveLlmSettings({
    GROQ_API_KEY: "gsk_test",
    OPENAI_API_KEY: "sk-test",
    LLM_PROVIDER: "openai",
  });
  assert.equal(llm.provider, "openai");
  assert.equal(llm.apiKey, "sk-test");
});

test("custom OpenAI-compatible endpoints are honored and models overridable", () => {
  const llm = resolveLlmSettings({
    LLM_BASE_URL: "https://openrouter.ai/api/v1",
    LLM_API_KEY: "sk-or-test",
    LLM_MODEL: "meta-llama/some-model",
  });
  assert.equal(llm.provider, "custom");
  assert.equal(llm.baseURL, "https://openrouter.ai/api/v1");
  assert.equal(llm.apiKey, "sk-or-test");
  assert.equal(llm.model, "meta-llama/some-model");
  assert.equal(llm.fastModel, "gpt-4o-mini");
});

test("GROQ_BASE_URL can point at a proxy or local test server", () => {
  const llm = resolveLlmSettings({
    GROQ_API_KEY: "gsk_test",
    GROQ_BASE_URL: "http://127.0.0.1:4010/v1",
  });
  assert.equal(llm.provider, "groq");
  assert.equal(llm.baseURL, "http://127.0.0.1:4010/v1");
});

test("a Groq URL supplied through LLM_BASE_URL is still treated as Groq", () => {
  const llm = resolveLlmSettings({
    LLM_BASE_URL: "https://api.groq.com/openai/v1",
    GROQ_API_KEY: "gsk_test",
  });
  assert.equal(llm.provider, "groq");
  assert.equal(llm.apiKey, "gsk_test");
});

test("Groq defaults to low reasoning effort and allows an override", () => {
  assert.equal(resolveLlmSettings({ GROQ_API_KEY: "gsk_test" }).reasoningEffort, "low");
  assert.equal(
    resolveLlmSettings({
      GROQ_API_KEY: "gsk_test",
      LLM_REASONING_EFFORT: "high",
    }).reasoningEffort,
    "high",
  );
  assert.equal(resolveLlmSettings({ OPENAI_API_KEY: "sk-test" }).reasoningEffort, undefined);
});

test("no keys means no model is configured", () => {
  const llm = resolveLlmSettings({});
  assert.equal(llm.provider, "none");
  assert.equal(llm.apiKey, "");
  assert.equal(llm.model, "");
});
