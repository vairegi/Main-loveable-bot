import { createFileRoute, useNavigate, useParams, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { consumeLinkToken } from "@/lib/admin.functions";

export const Route = createFileRoute("/link/$token")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Link Telegram — Bot admin" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: LinkPage,
});

function LinkPage() {
  const { token } = useParams({ from: "/link/$token" });
  const navigate = useNavigate();
  const consume = useServerFn(consumeLinkToken);
  const [status, setStatus] = useState<"checking" | "needs-auth" | "linking" | "linked" | "error">("checking");
  const [message, setMessage] = useState<string>("");

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getUser();
      if (!data.user) {
        setStatus("needs-auth");
        return;
      }
      setStatus("linking");
      try {
        const res = await consume({ data: { token } });
        if (res.ok) {
          setStatus("linked");
          setMessage(`Linked to Telegram user ${res.telegramUserId}.`);
          setTimeout(() => navigate({ to: "/admin", replace: true }), 1500);
        } else {
          setStatus("error");
          setMessage(res.reason);
        }
      } catch (e: any) {
        setStatus("error");
        setMessage(e?.message ?? "Failed to consume token");
      }
    })();
  }, [token, consume, navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-sm">
        <h1 className="text-xl font-semibold text-foreground">Link your Telegram admin account</h1>
        {status === "checking" && <p className="mt-3 text-sm text-muted-foreground">Checking session…</p>}
        {status === "needs-auth" && (
          <>
            <p className="mt-3 text-sm text-muted-foreground">
              Sign in or create an account to complete the linking.
            </p>
            <Link
              to="/auth"
              search={{ redirect: `/link/${token}` } as any}
              className="mt-4 inline-flex rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            >
              Continue to sign in
            </Link>
          </>
        )}
        {status === "linking" && <p className="mt-3 text-sm text-muted-foreground">Linking…</p>}
        {status === "linked" && (
          <p className="mt-3 text-sm text-green-600">✅ {message} Redirecting to /admin…</p>
        )}
        {status === "error" && (
          <>
            <p className="mt-3 text-sm text-destructive">❌ {message}</p>
            <p className="mt-2 text-xs text-muted-foreground">Run <code>/linkweb</code> in the bot again to get a fresh link.</p>
          </>
        )}
      </div>
    </div>
  );
}
