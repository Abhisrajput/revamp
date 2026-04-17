"use client";

import { useState } from "react";
import { verifyToken, createRealmAdmin } from "./actions";

type Step = "token" | "admin" | "idp" | "mapping" | "test" | "users" | "done";

export default function SetupWizard() {
  const [step, setStep] = useState<Step>("token");
  const [token, setToken] = useState("");
  const [err, setErr] = useState<string | null>(null);

  async function submitToken(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const res = await verifyToken(token);
    if (!res.ok) {
      setErr("Invalid bootstrap token. Check the API logs for the correct token.");
      return;
    }
    setStep("admin");
  }

  return (
    <main className="mx-auto max-w-xl p-8">
      <h1 className="text-2xl font-bold mb-6">REVAMP Setup</h1>

      {step === "token" && (
        <form onSubmit={submitToken} className="space-y-4">
          <label className="block text-sm font-medium text-gray-700">
            Bootstrap token
          </label>
          <p className="text-xs text-gray-500 -mt-3">
            Printed once to the API container logs on first boot. Search your API container logs for
            <code className="mx-1 px-1 bg-gray-100 rounded">[SETUP]</code>.
          </p>
          <input
            className="border rounded px-3 py-2 w-full font-mono text-sm"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="paste the 48-hex-char token"
            autoFocus
          />
          {err && <p className="text-red-600 text-sm">{err}</p>}
          <button
            type="submit"
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50"
            disabled={!token.trim()}
          >
            Continue
          </button>
        </form>
      )}

      {step === "admin" && <AdminStep token={token} onNext={() => setStep("idp")} />}

      {step === "idp" && <IdpStep token={token} onNext={() => setStep("mapping")} />}

      {step === "mapping" && (
        <p className="text-gray-500">
          Step 3 (attribute mapping) will be implemented in Task 14.
        </p>
      )}

      {step === "done" && (
        <p>
          Setup complete. You can now{" "}
          <a href="/auth/login" className="text-blue-600 underline">
            sign in
          </a>
          .
        </p>
      )}
    </main>
  );
}

function AdminStep(props: { token: string; onNext: () => void }) {
  const [form, setForm] = useState({
    email: "",
    password: "",
    firstName: "",
    lastName: "",
  });
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    try {
      const r = await createRealmAdmin(props.token, form);
      if (!r.ok) {
        setErr(r.body?.error ?? `Failed (status ${r.status})`);
        return;
      }
      props.onNext();
    } finally {
      setLoading(false);
    }
  }

  const inputClass = "border rounded px-3 py-2 w-full";

  return (
    <form onSubmit={submit} className="space-y-3">
      <h2 className="text-xl font-semibold">Step 1: Create realm admin</h2>
      <input
        className={inputClass}
        placeholder="email"
        type="email"
        value={form.email}
        onChange={(e) => setForm({ ...form, email: e.target.value })}
        required
      />
      <input
        className={inputClass}
        placeholder="password (set via Keycloak reset flow on first login)"
        type="password"
        value={form.password}
        onChange={(e) => setForm({ ...form, password: e.target.value })}
      />
      <input
        className={inputClass}
        placeholder="first name"
        value={form.firstName}
        onChange={(e) => setForm({ ...form, firstName: e.target.value })}
      />
      <input
        className={inputClass}
        placeholder="last name"
        value={form.lastName}
        onChange={(e) => setForm({ ...form, lastName: e.target.value })}
      />
      {err && <p className="text-red-600 text-sm">{err}</p>}
      <button
        type="submit"
        disabled={loading}
        className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50"
      >
        {loading ? "Creating..." : "Create admin"}
      </button>
    </form>
  );
}

function IdpStep(props: { token: string; onNext: () => void }) {
  const [provider, setProvider] = useState<
    "azure" | "okta" | "google" | "saml" | "oidc"
  >("azure");

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Step 2: Pick your identity provider</h2>
      <p className="text-sm text-gray-600">
        Forms for each provider are implemented in Task 13. For now, you can skip this step and
        configure federation later through Keycloak&apos;s admin UI.
      </p>
      <select
        value={provider}
        onChange={(e) => setProvider(e.target.value as "azure" | "okta" | "google" | "saml" | "oidc")}
        className="border rounded px-3 py-2"
      >
        <option value="azure">Azure AD</option>
        <option value="okta">Okta</option>
        <option value="google">Google Workspace</option>
        <option value="saml">Generic SAML 2.0</option>
        <option value="oidc">Generic OIDC</option>
      </select>
      <div>
        <button
          onClick={() => props.onNext()}
          className="bg-gray-200 text-gray-900 px-4 py-2 rounded hover:bg-gray-300"
        >
          Skip (configure later)
        </button>
      </div>
    </div>
  );
}
