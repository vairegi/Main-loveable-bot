import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getAdminDashboard, checkAdminAccess } from "@/lib/admin.functions";

export const Route = createFileRoute("/_authenticated/admin")({
  head: () => ({
    meta: [
      { title: "Admin console — Bot" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AdminPage,
});

type Tab = "activity" | "users" | "posts" | "failures" | "audit";

function AdminPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const checkAccess = useServerFn(checkAdminAccess);
  const fetchDashboard = useServerFn(getAdminDashboard);
  const [tab, setTab] = useState<Tab>("activity");
  const [liveRows, setLiveRows] = useState<any[]>([]);

  const access = useQuery({
    queryKey: ["admin", "access"],
    queryFn: () => checkAccess(),
  });

  const dashboard = useQuery({
    queryKey: ["admin", "dashboard"],
    queryFn: () => fetchDashboard(),
    enabled: !!access.data?.isAdmin,
  });

  // Live tail of activity_log via realtime — prepends new rows to the activity tab.
  useEffect(() => {
    if (!access.data?.isAdmin) return;
    const channel = supabase
      .channel("admin-activity-tail")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "activity_log" },
        (payload) => {
          setLiveRows((prev) => [payload.new, ...prev].slice(0, 50));
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [access.data?.isAdmin, queryClient]);

  async function signOut() {
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  if (access.isLoading) {
    return <div className="p-8 text-sm text-muted-foreground">Checking access…</div>;
  }

  if (!access.data?.isAdmin) {
    return (
      <div className="mx-auto mt-16 max-w-md rounded-lg border border-border bg-card p-6 text-center">
        <h1 className="text-xl font-semibold text-foreground">Not linked</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your web account is not linked to a Telegram admin.
          Run <code>/linkweb</code> in the bot to get a one-time linking URL.
        </p>
        <button
          onClick={signOut}
          className="mt-4 rounded-md border border-input bg-background px-4 py-2 text-sm"
        >
          Sign out
        </button>
      </div>
    );
  }

  const data = dashboard.data;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div>
            <h1 className="text-lg font-semibold text-foreground">Bot admin</h1>
            <p className="text-xs text-muted-foreground">
              Linked to Telegram <code>{access.data.telegramUserId}</code>
            </p>
          </div>
          <button
            onClick={signOut}
            className="rounded-md border border-input bg-background px-3 py-1.5 text-xs"
          >
            Sign out
          </button>
        </div>
        <nav className="mx-auto flex max-w-6xl gap-1 px-4">
          {(["activity", "users", "posts", "failures", "audit"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`border-b-2 px-3 py-2 text-sm capitalize ${
                tab === t
                  ? "border-primary font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {t}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">
        {dashboard.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {dashboard.isError && <p className="text-sm text-destructive">{(dashboard.error as any)?.message}</p>}
        {data && (
          <>
            {tab === "activity" && <ActivityTable rows={[...liveRows, ...data.activity].slice(0, 100)} />}
            {tab === "users" && <UsersTable rows={data.users} />}
            {tab === "posts" && <PostsTable rows={data.posts} />}
            {tab === "failures" && <FailuresTable rows={data.failures} />}
            {tab === "audit" && <AuditTable rows={(data as any).audit ?? []} />}
          </>
        )}
      </main>
    </div>
  );
}

function Table({ headers, rows }: { headers: string[]; rows: (string | number | null)[][] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full text-sm">
        <thead className="bg-muted/50">
          <tr>{headers.map((h) => <th key={h} className="px-3 py-2 text-left font-medium text-muted-foreground">{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-border">
              {r.map((c, j) => <td key={j} className="px-3 py-2 align-top text-foreground">{c ?? "—"}</td>)}
            </tr>
          ))}
          {!rows.length && (
            <tr><td colSpan={headers.length} className="px-3 py-6 text-center text-muted-foreground">No data</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function fmtTime(s?: string | null) {
  return s ? new Date(s).toLocaleString() : "—";
}

function ActivityTable({ rows }: { rows: any[] }) {
  return (
    <Table
      headers={["When", "Actor", "Action", "Details"]}
      rows={rows.map((r) => [
        fmtTime(r.created_at),
        r.actor_username ? `@${r.actor_username}` : String(r.actor_id ?? "—"),
        r.action,
        r.details ? JSON.stringify(r.details).slice(0, 200) : "—",
      ])}
    />
  );
}

function UsersTable({ rows }: { rows: any[] }) {
  return (
    <Table
      headers={["Telegram ID", "Username", "Name", "Fetches", "Last seen", "Banned"]}
      rows={rows.map((r) => [
        r.telegram_user_id,
        r.username ? `@${r.username}` : "—",
        r.first_name ?? "—",
        r.fetch_count ?? 0,
        fmtTime(r.last_seen),
        r.banned ? "🚫" : "—",
      ])}
    />
  );
}

function PostsTable({ rows }: { rows: any[] }) {
  return (
    <Table
      headers={["ID", "Code", "Caption", "Fetches", "Created"]}
      rows={rows.map((r) => [
        r.id,
        r.code,
        (r.caption ?? "").slice(0, 80),
        r.fetch_count ?? 0,
        fmtTime(r.created_at),
      ])}
    />
  );
}

function FailuresTable({ rows }: { rows: any[] }) {
  return (
    <Table
      headers={["Post", "Backup chat", "Attempts", "Last error", "Updated"]}
      rows={rows.map((r) => [
        r.post_id,
        r.backup_chat_id,
        r.attempts,
        (r.last_error ?? "").slice(0, 120),
        fmtTime(r.updated_at),
      ])}
    />
  );
}

function AuditTable({ rows }: { rows: any[] }) {
  return (
    <Table
      headers={["When", "Admin", "Action", "Target", "Details"]}
      rows={rows.map((r) => [
        fmtTime(r.created_at),
        r.admin_username ? `@${r.admin_username}` : String(r.admin_id ?? "—"),
        r.action,
        r.target ?? "—",
        r.details ? JSON.stringify(r.details).slice(0, 200) : "—",
      ])}
    />
  );
}
