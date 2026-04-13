import { AGENT_ID, anthropic, getEnvironmentId } from "@/lib/anthropic";

export const runtime = "nodejs";
export const maxDuration = 300;

type Send = (event: string, data: unknown) => void;

async function fetchOutputs(sessionId: string, send: Send) {
  // brief indexing lag (~1-3s) between idle and outputs being listable
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const files = await anthropic.beta.files.list({
        // SDK types say `scope_id`, but the API rejects that — correct query param is `scope`
        ...({ scope: sessionId } as Record<string, string>),
      });
      const matches = files.data.filter((f) =>
        /\.(svg|txt|ascii)$/i.test(f.filename ?? "")
      );
      if (matches.length === 0) {
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      for (const f of matches) {
        const resp = await anthropic.beta.files.download(f.id);
        const content = await resp.text();
        const kind = /\.svg$/i.test(f.filename) ? "svg" : "ascii";
        send("artifact", { kind, filename: f.filename, content });
      }
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 800));
    }
  }
}

function summarize(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input.slice(0, 100);
  try {
    const obj = input as Record<string, unknown>;
    const key =
      ("command" in obj && "command") ||
      ("url" in obj && "url") ||
      ("path" in obj && "path") ||
      ("file_path" in obj && "file_path") ||
      ("query" in obj && "query") ||
      ("pattern" in obj && "pattern");
    if (key) return String(obj[key]).slice(0, 100);
    return JSON.stringify(input).slice(0, 100);
  } catch {
    return "";
  }
}

export async function POST(req: Request) {
  const { prompt } = (await req.json()) as { prompt?: string };
  if (!prompt || !prompt.trim()) {
    return new Response(JSON.stringify({ error: "prompt required" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const environmentId = await getEnvironmentId();
  const session = await anthropic.beta.sessions.create({
    agent: AGENT_ID,
    environment_id: environmentId,
    title: `Illustration: ${prompt.slice(0, 60)}`,
  });

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        );
      };

      try {
        send("session", { id: session.id });

        // Stream-first: open before sending
        const eventStream = await anthropic.beta.sessions.events.stream(
          session.id
        );

        await anthropic.beta.sessions.events.send(session.id, {
          events: [
            {
              type: "user.message",
              content: [{ type: "text", text: prompt }],
            },
          ],
        });

        for await (const ev of eventStream) {
          if (ev.type === "agent.message") {
            for (const block of ev.content) {
              if (block.type === "text") {
                send("text", { text: block.text });
              }
            }
          } else if (ev.type === "agent.thinking") {
            send("thinking", {});
          } else if (ev.type === "agent.tool_use") {
            send("tool_use", { name: ev.name, input: summarize(ev.input) });
            // Capture file contents written by the agent (write/edit tools)
            const inp = ev.input as Record<string, unknown> | undefined;
            const path =
              (inp?.file_path as string | undefined) ??
              (inp?.path as string | undefined);
            const content = inp?.content as string | undefined;
            if (ev.name === "write" && path && content) {
              if (/\.svg$/i.test(path)) {
                send("artifact", {
                  kind: "svg",
                  filename: path.split("/").pop() ?? "output.svg",
                  content,
                });
              } else if (/\.(txt|ascii)$/i.test(path)) {
                send("artifact", {
                  kind: "ascii",
                  filename: path.split("/").pop() ?? "output.txt",
                  content,
                });
              }
            }
          } else if (ev.type === "agent.mcp_tool_use") {
            send("tool_use", { name: ev.name, input: summarize(ev.input) });
          } else if (ev.type === "agent.custom_tool_use") {
            send("tool_use", {
              name: (ev as { tool_name?: string }).tool_name ?? "custom",
              input: summarize((ev as { input?: unknown }).input),
            });
          } else if (ev.type === "agent.tool_result") {
            send("tool_result", {});
          } else if (ev.type === "span.model_request_start") {
            send("turn_start", {});
          } else if (ev.type === "session.status_terminated") {
            await fetchOutputs(session.id, send);
            send("done", { reason: "terminated" });
            break;
          } else if (ev.type === "session.status_idle") {
            const stop = (ev as { stop_reason?: { type?: string } }).stop_reason;
            if (stop?.type !== "requires_action") {
              await fetchOutputs(session.id, send);
              send("done", { reason: stop?.type ?? "idle" });
              break;
            }
          } else if (ev.type === "session.error") {
            send("error", { message: "session error" });
            break;
          }
        }
      } catch (err) {
        send("error", {
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        controller.close();
        anthropic.beta.sessions.archive(session.id).catch(() => {});
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
