import { normalizeSdkMessage } from "../../src/trace/normalize.js";

describe("trace normalization", () => {
  it("normalizes streaming text deltas", () => {
    const events = normalizeSdkMessage("run-1", {
      type: "stream_event",
      session_id: "session-1",
      parent_tool_use_id: null,
      event: {
        type: "content_block_delta",
        delta: {
          type: "text_delta",
          text: "hello"
        }
      }
    });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("assistant_text");
  });

  it("normalizes assistant tool usage and file changes", () => {
    const events = normalizeSdkMessage("run-1", {
      type: "assistant",
      session_id: "session-1",
      parent_tool_use_id: null,
      message: {
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Write",
            input: { file_path: "tests/test_calc.py" }
          }
        ]
      }
    });
    expect(events.map((event) => event.type)).toEqual(["tool_use", "file_changed"]);
  });
});
