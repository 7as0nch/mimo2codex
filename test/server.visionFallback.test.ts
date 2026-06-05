import { describe, it, expect } from "vitest";
import {
  requestContainsImages,
  chatRequestContainsImages,
} from "../src/server.js";
import { modelSupportsImages } from "../src/translate/reqToChat.js";
import { mimo } from "../src/providers/mimo.js";
import { deepseek } from "../src/providers/deepseek.js";
import type { ChatRequest, ResponsesRequest } from "../src/translate/types.js";

// These back the multimodal (vision) fallback: only rewrite the model when the
// request actually carries an image AND the active model can't see it.

describe("vision fallback — image detection", () => {
  // The fallback is scoped to providers that implement `supportsVision`.
  // Only MiMo does — DeepSeek (and other providers) must NOT, otherwise their
  // image requests would get rewritten to a MiMo model they can't serve.
  describe("vision capability is MiMo-only", () => {
    it("MiMo exposes supportsVision with correct results", () => {
      expect(typeof mimo.supportsVision).toBe("function");
      expect(mimo.supportsVision!("mimo-v2.5")).toBe(true);
      expect(mimo.supportsVision!("mimo-v2-omni")).toBe(true);
      expect(mimo.supportsVision!("mimo-v2.5-pro")).toBe(false);
    });

    it("DeepSeek does NOT implement supportsVision (fallback never fires)", () => {
      expect(deepseek.supportsVision).toBeUndefined();
    });
  });

  describe("modelSupportsImages", () => {
    it("recognizes vision-capable MiMo models (case-insensitive)", () => {
      expect(modelSupportsImages("mimo-v2.5")).toBe(true);
      expect(modelSupportsImages("mimo-v2-omni")).toBe(true);
      expect(modelSupportsImages("MIMO-V2-OMNI")).toBe(true);
    });

    it("rejects non-vision models", () => {
      expect(modelSupportsImages("mimo-v2.5-pro")).toBe(false);
      expect(modelSupportsImages("mimo-v2-flash")).toBe(false);
      expect(modelSupportsImages("deepseek-chat")).toBe(false);
    });
  });

  describe("requestContainsImages (Responses API)", () => {
    it("detects input_image inside a message", () => {
      const req: ResponsesRequest = {
        model: "mimo-v2.5-pro",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "what is this?" },
              { type: "input_image", image_url: "data:image/png;base64,AAAA" },
            ],
          },
        ],
      };
      expect(requestContainsImages(req)).toBe(true);
    });

    it("detects input_image returned by a tool (function_call_output)", () => {
      const req: ResponsesRequest = {
        model: "mimo-v2.5-pro",
        input: [
          {
            type: "function_call_output",
            call_id: "c1",
            output: [
              { type: "input_image", image_url: "data:image/png;base64,AAAA" },
            ],
          },
        ],
      };
      expect(requestContainsImages(req)).toBe(true);
    });

    it("returns false for a text-only message", () => {
      const req: ResponsesRequest = {
        model: "mimo-v2.5-pro",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        ],
      };
      expect(requestContainsImages(req)).toBe(false);
    });

    it("returns false when input is a plain string", () => {
      expect(requestContainsImages({ model: "m", input: "hi" })).toBe(false);
    });
  });

  describe("chatRequestContainsImages (Chat Completions API)", () => {
    it("detects an image_url content part", () => {
      const req: ChatRequest = {
        model: "mimo-v2.5-pro",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this?" },
              { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
            ],
          },
        ],
      };
      expect(chatRequestContainsImages(req)).toBe(true);
    });

    it("returns false for string content", () => {
      const req: ChatRequest = {
        model: "mimo-v2.5-pro",
        messages: [{ role: "user", content: "hi" }],
      };
      expect(chatRequestContainsImages(req)).toBe(false);
    });
  });
});
