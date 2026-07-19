import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";

// Local typed wrapper — the supabase-js beta `auth.oauth` namespace isn't in the shipped types.
type AuthDetails = {
  client?: { name?: string; client_uri?: string };
  redirect_url?: string;
  redirect_to?: string;
  scope?: string;
};
type AuthResult<T> = { data: T | null; error: { message: string } | null };
const authOAuth = () =>
  (supabase.auth as unknown as {
    oauth: {
      getAuthorizationDetails: (id: string) => Promise<AuthResult<AuthDetails>>;
      approveAuthorization: (id: string) => Promise<AuthResult<AuthDetails>>;
      denyAuthorization: (id: string) => Promise<AuthResult<AuthDetails>>;
    };
  }).oauth;

export const Route = createFileRoute("/.lovable/oauth/consent")({
  ssr: false,
  validateSearch: (s: Record<string, unknown>) => ({
    authorization_id: typeof s.authorization_id === "string" ? s.authorization_id : "",
  }),
  beforeLoad: async ({ search, location }) => {
    if (!search.authorization_id) throw new Error("Missing authorization_id");
    const { data } = await supabase.auth.getSession();
    if (!data.session) {
      // Preserve the full consent URL so /auth returns here after sign-in.
      throw redirect({ to: "/auth", search: { redirect: location.href } });
    }
  },
  loader: async ({ location }) => {
    const authorizationId = new URLSearchParams(location.search).get("authorization_id")!;
    const { data, error } = await authOAuth().getAuthorizationDetails(authorizationId);
    if (error) throw new Error(error.message);
    const immediate = data?.redirect_url ?? data?.redirect_to;
    if (immediate && !data?.client) throw redirect({ href: immediate });
    return data;
  },
  component: Consent,
  errorComponent: ({ error }) => (
    <main style={{ maxWidth: 520, margin: "80px auto", padding: 24, fontFamily: "system-ui" }}>
      <h1>Authorization error</h1>
      <p>{String((error as Error)?.message ?? error)}</p>
    </main>
  ),
});

function Consent() {
  const details = Route.useLoaderData();
  const { authorization_id } = Route.useSearch();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(approve: boolean) {
    setBusy(true);
    setError(null);
    const { data, error } = approve
      ? await authOAuth().approveAuthorization(authorization_id)
      : await authOAuth().denyAuthorization(authorization_id);
    if (error) {
      setBusy(false);
      setError(error.message);
      return;
    }
    const target = data?.redirect_url ?? data?.redirect_to;
    if (!target) {
      setBusy(false);
      setError("No redirect returned by the authorization server.");
      return;
    }
    window.location.href = target;
  }

  const clientName = details?.client?.name ?? "an app";

  return (
    <main
      style={{
        maxWidth: 520,
        margin: "80px auto",
        padding: 32,
        fontFamily: "system-ui",
        border: "1px solid #e5e7eb",
        borderRadius: 12,
        background: "#fff",
      }}
    >
      <h1 style={{ fontSize: 22, marginBottom: 8 }}>
        Connect {clientName} to your Telegram Bot Admin account
      </h1>
      <p style={{ color: "#4b5563", marginBottom: 16 }}>
        This lets {clientName} call this app's MCP tools while you are signed in. Access still
        follows your admin role and the app's backend policies.
      </p>
      {details?.scope && (
        <p style={{ fontSize: 13, color: "#6b7280", marginBottom: 16 }}>
          Requested permission: <code>{details.scope}</code>
        </p>
      )}
      {error && (
        <p role="alert" style={{ color: "#b91c1c", marginBottom: 12 }}>
          {error}
        </p>
      )}
      <div style={{ display: "flex", gap: 12 }}>
        <button
          disabled={busy}
          onClick={() => decide(true)}
          style={{
            background: "#111827",
            color: "#fff",
            padding: "10px 18px",
            borderRadius: 8,
            border: "none",
            cursor: busy ? "wait" : "pointer",
            fontWeight: 600,
          }}
        >
          {busy ? "Working…" : "Approve"}
        </button>
        <button
          disabled={busy}
          onClick={() => decide(false)}
          style={{
            background: "#fff",
            color: "#111827",
            padding: "10px 18px",
            borderRadius: 8,
            border: "1px solid #d1d5db",
            cursor: busy ? "wait" : "pointer",
          }}
        >
          Cancel connection
        </button>
      </div>
    </main>
  );
}
