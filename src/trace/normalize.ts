import type { TraceEvent } from "../types.js";
import { nowIso } from "../utils.js";

function createEvent(
  runId: string,
  type: TraceEvent["type"],
  data: Record<string, unknown>,
  message: any
): TraceEvent {
  return {
    runId,
    sessionId: message.session_id,
    parentToolUseId: message.parent_tool_use_id ?? null,
    ts: nowIso(),
    type,
    data
  };
}

export function normalizeSdkMessage(runId: string, message: any): TraceEvent[] {
  const events: TraceEvent[] = [];

  if (message.type === "user" && message.uuid) {
    events.push(
      createEvent(
        runId,
        "checkpoint_created",
        { user_message_uuid: message.uuid, replay: Boolean(message.isReplay) },
        message
      )
    );
    return events;
  }

  if (message.type === "stream_event") {
    const event = message.event;
    if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
      events.push(
        createEvent(runId, "assistant_text", { text: event.delta.text, partial: true }, message)
      );
    }
    if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
      const toolName = event.content_block.name;
      const toolUseId = event.content_block.id;
      events.push(
        createEvent(runId, "tool_progress", { phase: "start", tool: toolName, tool_use_id: toolUseId }, message)
      );
      if (toolName === "Agent" || toolName === "Task") {
        events.push(
          createEvent(
            runId,
            "subagent_started",
            { tool: toolName, tool_use_id: toolUseId },
            message
          )
        );
      }
    }
    if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
      events.push(
        createEvent(
          runId,
          "tool_progress",
          { phase: "input", partial_json: event.delta.partial_json },
          message
        )
      );
    }
    if (event.type === "content_block_stop") {
      events.push(createEvent(runId, "tool_progress", { phase: "stop" }, message));
    }
    return events;
  }

  if (message.type === "assistant") {
    for (const block of message.message?.content ?? []) {
      if (block.type === "text") {
        events.push(createEvent(runId, "assistant_text", { text: block.text, partial: false }, message));
      }
      if (block.type === "tool_use") {
        events.push(
          createEvent(
            runId,
            "tool_use",
            { tool: block.name, tool_use_id: block.id, input: block.input ?? {} },
            message
          )
        );
        if ((block.name === "Write" || block.name === "Edit") && (block.input?.file_path || block.input?.path)) {
          events.push(
            createEvent(
              runId,
              "file_changed",
              { path: String(block.input.file_path ?? block.input.path), tool: block.name },
              message
            )
          );
        }
      }
      if (block.type === "tool_result") {
        events.push(
          createEvent(
            runId,
            "tool_result",
            { tool_use_id: block.tool_use_id, is_error: block.is_error ?? false, content: block.content ?? null },
            message
          )
        );
      }
    }
    return events;
  }

  if (message.type === "system") {
    if (message.subtype === "init") {
      events.push(
        createEvent(
          runId,
          "task_progress",
          { phase: "sdk_initialized", model: message.model, tools: message.tools },
          message
        )
      );
    }
    if (message.subtype === "task_notification") {
      events.push(
        createEvent(
          runId,
          "task_progress",
          { phase: "task_notification", status: message.status, summary: message.summary },
          message
        )
      );
    }
    if (message.subtype === "status") {
      events.push(
        createEvent(
          runId,
          "task_progress",
          { phase: "status", status: message.status ?? null },
          message
        )
      );
    }
    return events;
  }

  if (message.type === "result") {
    events.push(
      createEvent(
        runId,
        message.is_error ? "run_failed" : "task_progress",
        {
          subtype: message.subtype,
          total_cost_usd: message.total_cost_usd,
          num_turns: message.num_turns
        },
        message
      )
    );
  }

  return events;
}
