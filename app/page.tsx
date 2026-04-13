"use client";

import { useState, useMemo, useRef } from "react";
import DOMPurify from "isomorphic-dompurify";

type Status = "idle" | "streaming" | "done" | "error";

function extractArtifact(text: string): {
  kind: "svg" | "ascii" | "none";
  content: string;
} {
  const svgMatch = text.match(/<svg[\s\S]*?<\/svg>/i);
  if (svgMatch) return { kind: "svg", content: svgMatch[0] };

  const fenced = text.match(/```(?:ascii|text|txt)?\n([\s\S]*?)```/);
  if (fenced) return { kind: "ascii", content: fenced[1] };

  return { kind: "none", content: "" };
}

export default function Home() {
  const [prompt, setPrompt] = useState("a friendly robot waving hello");
  const [status, setStatus] = useState<Status>("idle");
  const [output, setOutput] = useState("");
  const [activity, setActivity] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fileArtifact, setFileArtifact] = useState<{
    kind: "svg" | "ascii";
    content: string;
    filename: string;
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const artifact = useMemo(() => {
    if (fileArtifact) return fileArtifact;
    return extractArtifact(output);
  }, [fileArtifact, output]);
  const safeSvg = useMemo(
    () =>
      artifact.kind === "svg"
        ? DOMPurify.sanitize(artifact.content, {
            USE_PROFILES: { svg: true, svgFilters: true },
          })
        : "",
    [artifact]
  );

  async function generate() {
    if (!prompt.trim() || status === "streaming") return;
    setStatus("streaming");
    setOutput("");
    setActivity([]);
    setError(null);
    setFileArtifact(null);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt }),
        signal: ctrl.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`request failed: ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        const chunks = buf.split("\n\n");
        buf = chunks.pop() ?? "";

        for (const chunk of chunks) {
          const lines = chunk.split("\n");
          let event = "message";
          let data = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) event = line.slice(7);
            else if (line.startsWith("data: ")) data = line.slice(6);
          }
          if (!data) continue;
          let payload: Record<string, unknown> = {};
          try {
            payload = JSON.parse(data);
          } catch {
            continue;
          }

          if (event === "text") {
            setOutput((prev) => prev + (payload.text as string));
          } else if (event === "session") {
            setActivity((a) => [...a, `session ${payload.id}`]);
          } else if (event === "turn_start") {
            setActivity((a) => [...a, "→ model turn"]);
          } else if (event === "thinking") {
            setActivity((a) => [...a, "thinking…"]);
          } else if (event === "tool_use") {
            const inp = payload.input ? ` ${payload.input}` : "";
            setActivity((a) => [...a, `tool: ${payload.name ?? "?"}${inp}`]);
          } else if (event === "tool_result") {
            setActivity((a) => [...a, "  ↳ result"]);
          } else if (event === "artifact") {
            setFileArtifact({
              kind: payload.kind as "svg" | "ascii",
              content: payload.content as string,
              filename: payload.filename as string,
            });
            setActivity((a) => [...a, `artifact: ${payload.filename}`]);
          } else if (event === "done") {
            setStatus("done");
          } else if (event === "error") {
            setError((payload.message as string) ?? "unknown error");
            setStatus("error");
          }
        }
      }

      setStatus((s) => (s === "streaming" ? "done" : s));
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }

  function stop() {
    abortRef.current?.abort();
    setStatus("idle");
  }

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-black dark:text-zinc-100">
      <main className="mx-auto max-w-5xl px-6 py-12">
        <header className="mb-8">
          <h1 className="text-3xl font-semibold tracking-tight">
            Illustration Agent
          </h1>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            Powered by a Claude Managed Agent that returns SVG or ASCII art.
          </p>
        </header>

        <section className="mb-6">
          <label className="mb-2 block text-sm font-medium">Prompt</label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            className="w-full resize-none rounded-lg border border-zinc-300 bg-white px-4 py-3 text-sm shadow-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900"
            placeholder="describe the illustration…"
            disabled={status === "streaming"}
          />
          <div className="mt-3 flex gap-2">
            <button
              onClick={generate}
              disabled={status === "streaming" || !prompt.trim()}
              className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
            >
              {status === "streaming" ? "generating…" : "generate"}
            </button>
            {status === "streaming" && (
              <button
                onClick={stop}
                className="rounded-md border border-zinc-300 px-4 py-2 text-sm dark:border-zinc-700"
              >
                stop
              </button>
            )}
          </div>
        </section>

        {error && (
          <div className="mb-6 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
            {error}
          </div>
        )}

        {activity.length > 0 && (
          <details className="mb-6 text-xs text-zinc-500">
            <summary className="cursor-pointer">activity ({activity.length})</summary>
            <ul className="mt-2 space-y-1 font-mono">
              {activity.map((a, i) => (
                <li key={i}>· {a}</li>
              ))}
            </ul>
          </details>
        )}

        <section className="grid gap-6 md:grid-cols-2">
          <div>
            <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
              Illustration
            </h2>
            <div className="flex min-h-[320px] items-center justify-center rounded-lg border border-zinc-300 bg-white p-6 dark:border-zinc-700 dark:bg-zinc-900">
              {artifact.kind === "svg" && (
                <div
                  className="max-h-[480px] w-full [&>svg]:mx-auto [&>svg]:max-h-[480px] [&>svg]:w-auto"
                  dangerouslySetInnerHTML={{ __html: safeSvg }}
                />
              )}
              {artifact.kind === "ascii" && (
                <pre className="overflow-auto whitespace-pre text-xs leading-[1.1]">
                  {artifact.content}
                </pre>
              )}
              {artifact.kind === "none" && (
                <span className="text-sm text-zinc-400">
                  {status === "streaming" ? "drawing…" : "no illustration yet"}
                </span>
              )}
            </div>
          </div>

          <div>
            <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
              Raw response
            </h2>
            <pre className="min-h-[320px] max-h-[480px] overflow-auto rounded-lg border border-zinc-300 bg-white p-4 text-xs dark:border-zinc-700 dark:bg-zinc-900">
              {output || (
                <span className="text-zinc-400">
                  {status === "streaming" ? "…" : "empty"}
                </span>
              )}
            </pre>
          </div>
        </section>
      </main>
    </div>
  );
}
