import { createFileRoute } from "@tanstack/react-router";
import { useState, useRef, useEffect } from "react";
import {
  submitQuery,
  resumeQuery,
  type QueryResponse,
  type AttachmentInput,
} from "@/utils/llm.functions";
import { updateContact, addContact, addAppEvent, addEvent } from "@/utils/sheets.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Sparkles,
  Send,
  Loader2,
  User,
  Bot,
  ChevronDown,
  ChevronRight,
  HelpCircle,
  ShieldAlert,
  Mail,
  ListChecks,
  Gauge,
  ExternalLink,
  Paperclip,
  X,
  FileText,
  Image as ImageIcon,
  Lock,
  Plus,
} from "lucide-react";
import { toast } from "sonner";
import { MarkdownMessage } from "@/components/query/MarkdownMessage";

export const Route = createFileRoute("/query")({
  head: () => ({
    meta: [
      { title: "Query — VenturePulse" },
      { name: "description", content: "Ask questions across your VenturePulse data" },
    ],
  }),
  component: QueryPage,
});

type JV = unknown;
interface Turn {
  role: "user" | "assistant";
  text: string;
  attachments?: string[];
  prov?: { tools: JV[]; sources: JV[]; tokensIn: number; tokensOut: number };
  artifacts?: JV[];
}
interface FileDraft {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  dataBase64: string;
  level: "internal" | "confidential";
}

const SUGGESTIONS = [
  "Who do we know in cybersecurity?",
  "Find people at companies using Kubernetes",
  "Draft a warm intro to our Hot contacts",
];

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 4;

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
const fmtSize = (b: number) =>
  b < 1024
    ? `${b} B`
    : b < 1024 * 1024
      ? `${(b / 1024).toFixed(0)} KB`
      : `${(b / 1024 / 1024).toFixed(1)} MB`;

function QueryPage() {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pending, setPending] = useState<QueryResponse | null>(null);
  const [files, setFiles] = useState<FileDraft[]>([]);
  const endRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns, pending, busy]);

  const addTurn = (t: Turn) => setTurns((prev) => [...prev, t]);

  const handleOutcome = (res: QueryResponse) => {
    setSessionId(res.meta.sessionId);
    const o = res.outcome;
    if (o.status === "complete") {
      addTurn({
        role: "assistant",
        text: o.answer || "(no answer)",
        prov: o.state.prov as Turn["prov"],
        artifacts: o.state.prov.artifacts,
      });
      setPending(null);
    } else if (o.status === "error") {
      addTurn({ role: "assistant", text: `⚠️ ${o.error}` });
      setPending(null);
    } else {
      setPending(res);
    }
  };

  const onFiles = async (list: FileList | null) => {
    if (!list) return;
    const next: FileDraft[] = [];
    for (const file of Array.from(list)) {
      if (files.length + next.length >= MAX_FILES) {
        toast.error(`Up to ${MAX_FILES} files.`);
        break;
      }
      if (file.size > MAX_FILE_BYTES) {
        toast.error(`${file.name} is over 8 MB.`);
        continue;
      }
      try {
        next.push({
          id: `${file.name}-${file.size}-${Math.round(file.lastModified)}`,
          filename: file.name,
          mimeType: file.type || "application/octet-stream",
          sizeBytes: file.size,
          dataBase64: await readBase64(file),
          level: "internal",
        });
      } catch {
        toast.error(`Couldn't read ${file.name}.`);
      }
    }
    setFiles((prev) => [...prev, ...next]);
    if (fileRef.current) fileRef.current.value = "";
  };
  const removeFile = (id: string) => setFiles((prev) => prev.filter((f) => f.id !== id));
  const toggleLevel = (id: string) =>
    setFiles((prev) =>
      prev.map((f) =>
        f.id === id ? { ...f, level: f.level === "internal" ? "confidential" : "internal" } : f,
      ),
    );

  const send = async () => {
    const prompt = input.trim();
    if ((!prompt && files.length === 0) || busy) return;
    setInput("");
    const attachments: AttachmentInput[] = files.map((f) => ({
      filename: f.filename,
      mimeType: f.mimeType,
      sizeBytes: f.sizeBytes,
      dataBase64: f.dataBase64,
      level: f.level,
    }));
    // Carry prior turns (text only) so the agent keeps context across messages.
    const priorMessages = turns.map((t) => ({ role: t.role, content: t.text }));
    addTurn({
      role: "user",
      text: prompt || "(attachment only)",
      attachments: files.map((f) => f.filename),
    });
    setFiles([]);
    setBusy(true);
    try {
      const res = await submitQuery({ data: { prompt, sessionId, attachments, priorMessages } });
      handleOutcome(res);
    } catch (e) {
      console.error("submitQuery failed", e);
      addTurn({ role: "assistant", text: "⚠️ Query failed — see console." });
    } finally {
      setBusy(false);
    }
  };

  const resume = async (resultText: string, approvedBy?: string) => {
    if (!pending) return;
    setBusy(true);
    const { meta, outcome } = pending;
    setPending(null);
    try {
      const res = await resumeQuery({
        data: {
          meta,
          state: outcome.state,
          toolUseId: outcome.status === "needs_input" ? outcome.pause.toolUseId : "",
          resultText,
          approvedBy,
        },
      });
      handleOutcome(res);
    } catch (e) {
      console.error("resumeQuery failed", e);
      addTurn({ role: "assistant", text: "⚠️ Resume failed — see console." });
    } finally {
      setBusy(false);
    }
  };

  const pause = pending?.outcome.status === "needs_input" ? pending.outcome.pause : null;
  const canSend = (!!input.trim() || files.length > 0) && !busy && !pending;

  return (
    <div className="flex flex-col h-[calc(100vh-3rem)]">
      <header className="px-6 py-3 border-b border-border bg-background/60 backdrop-blur">
        <div className="max-w-3xl mx-auto flex items-center justify-between gap-2.5">
          <div className="flex items-center gap-2.5">
            <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <Sparkles className="h-4 w-4 text-primary" />
            </div>
            <div>
              <h1 className="text-sm font-bold leading-tight">Query</h1>
              <p className="text-[11px] text-muted-foreground leading-tight">
                Grounded in your data · Asana excluded · every query logged
              </p>
            </div>
          </div>
          {turns.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              disabled={busy}
              onClick={() => {
                setTurns([]);
                setPending(null);
                setFiles([]);
                setSessionId(undefined);
              }}
            >
              <Plus className="h-3.5 w-3.5 mr-1" /> New chat
            </Button>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-auto">
        <div className="max-w-3xl mx-auto px-6 py-6 space-y-5">
          {turns.length === 0 && !pending && !busy && (
            <div className="text-center py-16">
              <div className="h-12 w-12 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
                <Bot className="h-6 w-6 text-primary" />
              </div>
              <h2 className="text-base font-semibold">Ask across your network</h2>
              <p className="text-sm text-muted-foreground mt-1 mb-5">
                Network, Apollo, and the web — grounded in your own data.
              </p>
              <div className="flex flex-wrap gap-2 justify-center">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => {
                      setInput(s);
                      taRef.current?.focus();
                    }}
                    className="text-xs px-3 py-1.5 rounded-full border border-border hover:bg-accent transition-colors"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {turns.map((t, i) => (
            <TurnView key={i} turn={t} />
          ))}

          {pause?.kind === "clarification" && (
            <ClarificationCard input={pause.input} onSubmit={(txt) => resume(txt)} busy={busy} />
          )}
          {pause?.kind === "write_approval" && (
            <ApprovalCard name={pause.name} input={pause.input} onResolve={resume} busy={busy} />
          )}

          {busy && (
            <div className="flex items-center gap-2.5">
              <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                <Bot className="h-4 w-4 text-primary" />
              </div>
              <div className="flex gap-1 px-3 py-2.5 rounded-2xl bg-muted">
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:-0.3s]" />
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:-0.15s]" />
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50 animate-bounce" />
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>
      </div>

      <div className="border-t border-border bg-background px-6 py-3">
        <div className="max-w-3xl mx-auto">
          {files.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {files.map((f) => (
                <div
                  key={f.id}
                  className="flex items-center gap-1.5 text-[11px] border border-border rounded-lg pl-2 pr-1 py-1 bg-muted/40"
                >
                  {f.mimeType.startsWith("image/") ? (
                    <ImageIcon className="h-3 w-3 text-muted-foreground" />
                  ) : (
                    <FileText className="h-3 w-3 text-muted-foreground" />
                  )}
                  <span className="max-w-[140px] truncate font-medium">{f.filename}</span>
                  <span className="text-muted-foreground">{fmtSize(f.sizeBytes)}</span>
                  <button
                    onClick={() => toggleLevel(f.id)}
                    title="Toggle confidentiality"
                    className={`px-1.5 py-0.5 rounded text-[9px] font-medium ${f.level === "confidential" ? "bg-amber-100 text-amber-700" : "bg-muted text-muted-foreground"}`}
                  >
                    {f.level === "confidential" ? (
                      <span className="inline-flex items-center gap-0.5">
                        <Lock className="h-2.5 w-2.5" /> won't send
                      </span>
                    ) : (
                      "internal"
                    )}
                  </button>
                  <button
                    onClick={() => removeFile(f.id)}
                    className="text-muted-foreground hover:text-foreground p-0.5"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-end gap-2 rounded-2xl border border-border bg-background px-2 py-1.5 focus-within:ring-1 focus-within:ring-ring transition-shadow">
            <input
              ref={fileRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => onFiles(e.target.files)}
              accept="image/*,application/pdf,text/plain,text/csv,text/markdown"
            />
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 shrink-0 text-muted-foreground"
              onClick={() => fileRef.current?.click()}
              disabled={busy || !!pending}
              title="Attach files"
            >
              <Paperclip className="h-4 w-4" />
            </Button>
            <textarea
              ref={taRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={
                pending ? "Answer above to continue…" : "Ask anything about your network…"
              }
              disabled={busy || !!pending}
              rows={1}
              className="flex-1 resize-none bg-transparent text-sm py-2 max-h-32 outline-none placeholder:text-muted-foreground disabled:opacity-60"
            />
            <Button
              onClick={send}
              disabled={!canSend}
              size="icon"
              className="h-9 w-9 shrink-0 rounded-xl bg-(image:--gradient-primary) shadow-(--shadow-elegant) hover:shadow-(--shadow-elegant) hover:brightness-110"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground mt-1.5 text-center">
            Confidential attachments are hashed &amp; logged but never sent to the model. Press
            Enter to send · Shift+Enter for a new line.
          </p>
        </div>
      </div>
    </div>
  );
}

function TurnView({ turn }: { turn: Turn }) {
  const [showProv, setShowProv] = useState(false);
  const isUser = turn.role === "user";
  const artifacts = (turn.artifacts || []) as Array<Record<string, JV>>;
  return (
    <div className={`flex gap-2.5 ${isUser ? "flex-row-reverse" : ""}`}>
      <div
        className={`h-7 w-7 rounded-full flex items-center justify-center shrink-0 ${isUser ? "bg-muted" : "bg-primary/10"}`}
      >
        {isUser ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4 text-primary" />}
      </div>
      <div className={`max-w-[85%] ${isUser ? "items-end flex flex-col" : ""}`}>
        <div
          className={`rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${isUser ? "bg-primary text-primary-foreground rounded-tr-sm whitespace-pre-wrap" : "bg-muted rounded-tl-sm"}`}
        >
          {isUser ? turn.text : <MarkdownMessage text={turn.text} />}
        </div>
        {turn.attachments && turn.attachments.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1 justify-end">
            {turn.attachments.map((n, i) => (
              <Badge key={i} variant="outline" className="text-[9px] gap-0.5">
                <Paperclip className="h-2.5 w-2.5" />
                {n}
              </Badge>
            ))}
          </div>
        )}

        {artifacts.map((a, i) => (
          <ArtifactView key={i} a={a} />
        ))}

        {turn.prov && (turn.prov.tools.length > 0 || turn.prov.sources.length > 0) && (
          <div className="mt-1.5">
            <button
              onClick={() => setShowProv((v) => !v)}
              className="text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
            >
              {showProv ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              {turn.prov.tools.length} tool{turn.prov.tools.length !== 1 ? "s" : ""} ·{" "}
              {turn.prov.sources.length} source{turn.prov.sources.length !== 1 ? "s" : ""} ·{" "}
              {(turn.prov.tokensIn + turn.prov.tokensOut).toLocaleString()} tokens
            </button>
            {showProv && (
              <div className="mt-1 border border-border rounded-lg p-2 space-y-1 text-[10px] bg-card">
                {turn.prov.tools.map((t, i) => {
                  const o = t as Record<string, JV>;
                  return (
                    <div key={`t${i}`} className="text-muted-foreground">
                      <Badge variant="outline" className="text-[9px] mr-1">
                        {String(o.tool)}
                      </Badge>
                      {String(o.result_summary || "")}
                    </div>
                  );
                })}
                {turn.prov.sources.map((s, i) => {
                  const o = s as Record<string, JV>;
                  if (o.type === "redaction")
                    return (
                      <div key={`s${i}`} className="text-amber-600 flex items-center gap-1">
                        <ShieldAlert className="h-3 w-3" />
                        {String(o.excluded_count)} {String(o.level)} item(s) excluded
                      </div>
                    );
                  const ref = String(o.ref || "");
                  return (
                    <div key={`s${i}`} className="text-muted-foreground truncate">
                      · {String(o.type)}:{" "}
                      {o.type === "web" ? (
                        <a
                          href={ref}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline"
                        >
                          {String(o.title) || ref}
                        </a>
                      ) : (
                        String(o.title) || ref
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ArtifactView({ a }: { a: Record<string, unknown> }) {
  const type = String(a.type);
  if (type === "draft_email") {
    const to = String(a.to || ""),
      subject = String(a.subject || ""),
      body = String(a.body || "");
    const mailto = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    return (
      <div className="mt-2 border border-border rounded-xl bg-card p-3">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1.5">
          <Mail className="h-3 w-3" /> Draft email{to ? ` · ${to}` : ""}
        </div>
        <div className="text-sm font-semibold">{subject}</div>
        <div className="text-xs text-muted-foreground whitespace-pre-wrap mt-1">{body}</div>
        {to && (
          <a
            href={mailto}
            className="text-primary text-[11px] hover:underline inline-flex items-center gap-0.5 mt-2"
          >
            Open in email <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
    );
  }
  if (type === "invite_list") {
    const contacts = (a.contacts as Array<Record<string, unknown>>) || [];
    return (
      <div className="mt-2 border border-border rounded-xl bg-card p-3">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1.5">
          <ListChecks className="h-3 w-3" /> Invite list · {contacts.length}
        </div>
        <div className="max-h-44 overflow-auto space-y-0.5">
          {contacts.map((c, i) => (
            <div key={i} className="text-xs">
              <span className="font-medium">{String(c.name)}</span>{" "}
              <span className="text-muted-foreground">
                · {String(c.company || "")} · {String(c.email || "")}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (type === "company_score") {
    const sc = (a.score as Record<string, unknown>) || {};
    return (
      <div className="mt-2 border border-border rounded-xl bg-card p-3">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1">
          <Gauge className="h-3 w-3" /> DNA score · {String(a.company)}
        </div>
        <div className="text-lg font-bold">{sc.score != null ? `${String(sc.score)}/10` : "—"}</div>
        {sc.rationale ? (
          <div className="text-xs text-muted-foreground mt-0.5">{String(sc.rationale)}</div>
        ) : null}
      </div>
    );
  }
  return null;
}

function ClarificationCard({
  input,
  onSubmit,
  busy,
}: {
  input: unknown;
  onSubmit: (resultText: string) => void;
  busy: boolean;
}) {
  const data = (input || {}) as {
    reason?: string;
    questions?: Array<{
      id: string;
      prompt: string;
      type: string;
      options: string[];
      allow_other?: boolean;
    }>;
  };
  const questions = data.questions || [];
  const [answers, setAnswers] = useState<
    Record<string, { selected: string[]; other_text: string }>
  >(() => Object.fromEntries(questions.map((q) => [q.id, { selected: [], other_text: "" }])));
  const setSel = (qid: string, opt: string, multi: boolean) =>
    setAnswers((prev) => {
      const cur = prev[qid] || { selected: [], other_text: "" };
      const selected = multi
        ? cur.selected.includes(opt)
          ? cur.selected.filter((o) => o !== opt)
          : [...cur.selected, opt]
        : [opt];
      return { ...prev, [qid]: { ...cur, selected } };
    });
  const setOther = (qid: string, text: string) =>
    setAnswers((prev) => ({
      ...prev,
      [qid]: { ...(prev[qid] || { selected: [] }), other_text: text },
    }));
  const submit = () =>
    onSubmit(
      JSON.stringify(
        questions.map((q) => ({
          id: q.id,
          prompt: q.prompt,
          selected: answers[q.id]?.selected || [],
          other_text: answers[q.id]?.other_text || "",
        })),
      ),
    );
  const ready = questions.every(
    (q) => (answers[q.id]?.selected.length || 0) > 0 || (answers[q.id]?.other_text || "").trim(),
  );

  return (
    <div className="ml-9 border border-primary/30 bg-primary/5 rounded-xl p-3.5 space-y-3">
      <div className="flex items-center gap-1.5 text-xs font-semibold">
        <HelpCircle className="h-4 w-4 text-primary" /> {data.reason || "A quick question"}
      </div>
      {questions.map((q) => {
        const multi = q.type === "multi_select";
        const a = answers[q.id] || { selected: [], other_text: "" };
        return (
          <div key={q.id} className="space-y-1.5">
            <div className="text-xs font-medium">{q.prompt}</div>
            <div className="space-y-1">
              {q.options.map((opt) => (
                <label
                  key={opt}
                  className="flex items-center gap-2 text-xs cursor-pointer hover:text-foreground"
                >
                  <input
                    type={multi ? "checkbox" : "radio"}
                    name={q.id}
                    checked={a.selected.includes(opt)}
                    onChange={() => setSel(q.id, opt, multi)}
                  />
                  {opt}
                </label>
              ))}
              <div className="flex items-center gap-2 pt-0.5">
                <span className="text-xs text-muted-foreground shrink-0">Other:</span>
                <Input
                  value={a.other_text}
                  onChange={(e) => setOther(q.id, e.target.value)}
                  className="h-7 text-xs"
                  placeholder="free text"
                />
              </div>
            </div>
          </div>
        );
      })}
      <Button size="sm" className="h-7 text-xs" disabled={busy || !ready} onClick={submit}>
        Submit answer
      </Button>
    </div>
  );
}

function ApprovalCard({
  name,
  input,
  onResolve,
  busy,
}: {
  name: string;
  input: unknown;
  onResolve: (resultText: string, approvedBy?: string) => void;
  busy: boolean;
}) {
  const d = (input || {}) as Record<string, unknown>;
  const v = (k: string) => (d[k] == null ? undefined : String(d[k]));
  const list = (k: string) => (Array.isArray(d[k]) ? (d[k] as unknown[]).map(String) : []);

  // (title, label, field rows, commit fn) per write tool.
  let title = "Approve write to CRM";
  let subject = "";
  let rows: Array<[string, string]> = [];
  let commit: () => Promise<void>;

  if (name === "sheets_add_contact") {
    title = "Approve — add new contact";
    subject = v("name") || "";
    rows = (
      ["title", "company", "email", "phone", "location", "sector", "prime", "temperature"] as const
    )
      .filter((f) => v(f) != null)
      .map((f) => [f, v(f)!]);
    commit = async () => {
      await addContact({
        data: {
          name: v("name") || "",
          role: v("title") || "",
          company: v("company") || "",
          email: v("email") || "",
          phone: v("phone") || "",
          location: v("location") || "",
          prime: v("prime") || "",
          sector: v("sector") || "",
          temperature: v("temperature") || "Warm",
        },
      });
    };
  } else if (name === "sheets_add_attendees") {
    const emails = list("emails");
    const type = v("type") || "invited";
    title = "Approve — tag event attendees";
    subject = `${v("eventName") || ""} · ${emails.length} ${type}`;
    rows = [
      ["type", type],
      ["count", String(emails.length)],
      ["contacts", emails.slice(0, 12).join(", ") + (emails.length > 12 ? " …" : "")],
    ];
    commit = async () => {
      const ev = v("eventName") || "";
      for (const email of emails) {
        await addEvent({ data: { contactEmail: email, eventName: ev, type } });
      }
    };
  } else if (name === "sheets_add_event") {
    title = "Approve — create event (app, not Asana)";
    subject = v("name") || "";
    rows = [
      ["date", v("date") || ""],
      ["type", v("type") || ""],
      ["format", v("format") || ""],
      ["lead", v("lead") || ""],
      ["role", v("role") || ""],
      ["sectors", list("sectors").join(", ")],
      ["portcos", list("portcos").join(", ")],
    ].filter(([, val]) => val) as Array<[string, string]>;
    commit = async () => {
      await addAppEvent({
        data: {
          name: v("name") || "",
          date: v("date") || "",
          type: v("type"),
          format: v("format"),
          lead: v("lead"),
          role: v("role"),
          sectors: list("sectors"),
          portcos: list("portcos"),
        },
      });
    };
  } else {
    // sheets_update_contact
    title = "Approve — update contact";
    subject = v("email") || "";
    rows = (["title", "company", "phone", "location"] as const)
      .filter((f) => v(f) != null)
      .map((f) => [f, v(f)!]);
    commit = async () => {
      await updateContact({
        data: {
          email: v("email") || "",
          title: v("title"),
          company: v("company"),
          phone: v("phone"),
          location: v("location"),
        },
      });
    };
  }

  const approve = async () => {
    try {
      await commit();
      toast.success("Applied");
      onResolve(
        `Approved & applied (${name}): ${subject} — ${rows.map(([k, val]) => `${k}=${val}`).join(", ")}`,
        "tester",
      );
    } catch (e) {
      console.error(`${name} failed`, e);
      toast.error("Write failed — see console.");
      onResolve(`Write failed for ${subject}.`);
    }
  };

  return (
    <div className="ml-9 border border-amber-300 bg-amber-50 rounded-xl p-3.5 space-y-2">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-800">
        <ShieldAlert className="h-4 w-4" /> {title}
      </div>
      <div className="text-xs text-amber-900">
        <span className="font-medium">{subject}</span>
      </div>
      <div className="space-y-0.5">
        {rows.map(([k, val]) => (
          <div key={k} className="text-xs">
            <span className="text-muted-foreground">{k}:</span>{" "}
            <span className="font-medium">{val}</span>
          </div>
        ))}
      </div>
      <div className="flex gap-2 pt-0.5">
        <Button size="sm" className="h-7 text-xs" disabled={busy} onClick={approve}>
          Approve &amp; apply
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          disabled={busy}
          onClick={() => onResolve(`User declined (${name}) for ${subject}.`)}
        >
          Decline
        </Button>
      </div>
    </div>
  );
}
