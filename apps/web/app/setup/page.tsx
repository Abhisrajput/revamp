"use client";

import { useState } from "react";
import {
  verifyToken,
  createRealmAdmin,
  createIdpAzure,
  createIdpOkta,
  createIdpGoogle,
  createIdpSaml,
  createIdpOidc,
} from "./actions";

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

type IdpProvider = "azure" | "okta" | "google" | "saml" | "oidc";

function IdpStep(props: { token: string; onNext: () => void }) {
  const [provider, setProvider] = useState<IdpProvider>("azure");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Per-provider field state
  const [azure, setAzure] = useState({ tenantId: "", clientId: "", clientSecret: "" });
  const [okta, setOkta] = useState({ domain: "", clientId: "", clientSecret: "" });
  const [google, setGoogle] = useState({ hostedDomain: "", clientId: "", clientSecret: "" });
  const [saml, setSaml] = useState({ alias: "", singleSignOnServiceUrl: "", entityId: "" });
  const [oidc, setOidc] = useState({
    alias: "",
    authorizationUrl: "",
    tokenUrl: "",
    userInfoUrl: "",
    jwksUrl: "",
    issuer: "",
    clientId: "",
    clientSecret: "",
  });

  const inputClass = "border rounded px-3 py-2 w-full";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    try {
      let r: Awaited<ReturnType<typeof createIdpAzure>>;
      if (provider === "azure") {
        r = await createIdpAzure(props.token, azure);
      } else if (provider === "okta") {
        r = await createIdpOkta(props.token, okta);
      } else if (provider === "google") {
        r = await createIdpGoogle(props.token, google);
      } else if (provider === "saml") {
        r = await createIdpSaml(props.token, {
          alias: saml.alias || undefined,
          singleSignOnServiceUrl: saml.singleSignOnServiceUrl,
          entityId: saml.entityId || undefined,
        });
      } else {
        r = await createIdpOidc(props.token, {
          alias: oidc.alias || undefined,
          authorizationUrl: oidc.authorizationUrl,
          tokenUrl: oidc.tokenUrl,
          userInfoUrl: oidc.userInfoUrl,
          jwksUrl: oidc.jwksUrl,
          issuer: oidc.issuer,
          clientId: oidc.clientId,
          clientSecret: oidc.clientSecret,
        });
      }
      if (!r.ok) {
        setErr((r.body as any)?.error ?? `Failed (status ${r.status})`);
        return;
      }
      props.onNext();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Step 2: Pick your identity provider</h2>

      <select
        value={provider}
        onChange={(e) => {
          setProvider(e.target.value as IdpProvider);
          setErr(null);
        }}
        className="border rounded px-3 py-2"
      >
        <option value="azure">Azure AD</option>
        <option value="okta">Okta</option>
        <option value="google">Google Workspace</option>
        <option value="saml">Generic SAML 2.0</option>
        <option value="oidc">Generic OIDC</option>
      </select>

      <form onSubmit={submit} className="space-y-3">
        {provider === "azure" && (
          <>
            <input
              className={inputClass}
              placeholder="tenantId"
              type="text"
              value={azure.tenantId}
              onChange={(e) => setAzure({ ...azure, tenantId: e.target.value })}
              required
            />
            <input
              className={inputClass}
              placeholder="clientId"
              type="text"
              value={azure.clientId}
              onChange={(e) => setAzure({ ...azure, clientId: e.target.value })}
              required
            />
            <input
              className={inputClass}
              placeholder="clientSecret"
              type="password"
              value={azure.clientSecret}
              onChange={(e) => setAzure({ ...azure, clientSecret: e.target.value })}
              required
            />
          </>
        )}

        {provider === "okta" && (
          <>
            <input
              className={inputClass}
              placeholder="domain (e.g. your-org.okta.com)"
              type="text"
              value={okta.domain}
              onChange={(e) => setOkta({ ...okta, domain: e.target.value })}
              required
            />
            <input
              className={inputClass}
              placeholder="clientId"
              type="text"
              value={okta.clientId}
              onChange={(e) => setOkta({ ...okta, clientId: e.target.value })}
              required
            />
            <input
              className={inputClass}
              placeholder="clientSecret"
              type="password"
              value={okta.clientSecret}
              onChange={(e) => setOkta({ ...okta, clientSecret: e.target.value })}
              required
            />
          </>
        )}

        {provider === "google" && (
          <>
            <input
              className={inputClass}
              placeholder="hostedDomain (e.g. yourcompany.com)"
              type="text"
              value={google.hostedDomain}
              onChange={(e) => setGoogle({ ...google, hostedDomain: e.target.value })}
              required
            />
            <input
              className={inputClass}
              placeholder="clientId"
              type="text"
              value={google.clientId}
              onChange={(e) => setGoogle({ ...google, clientId: e.target.value })}
              required
            />
            <input
              className={inputClass}
              placeholder="clientSecret"
              type="password"
              value={google.clientSecret}
              onChange={(e) => setGoogle({ ...google, clientSecret: e.target.value })}
              required
            />
          </>
        )}

        {provider === "saml" && (
          <>
            <input
              className={inputClass}
              placeholder="alias (optional, defaults to saml)"
              type="text"
              value={saml.alias}
              onChange={(e) => setSaml({ ...saml, alias: e.target.value })}
            />
            <input
              className={inputClass}
              placeholder="singleSignOnServiceUrl"
              type="url"
              value={saml.singleSignOnServiceUrl}
              onChange={(e) => setSaml({ ...saml, singleSignOnServiceUrl: e.target.value })}
              required
            />
            <input
              className={inputClass}
              placeholder="entityId (optional, defaults to revamp)"
              type="text"
              value={saml.entityId}
              onChange={(e) => setSaml({ ...saml, entityId: e.target.value })}
            />
          </>
        )}

        {provider === "oidc" && (
          <>
            <input
              className={inputClass}
              placeholder="alias (optional, defaults to oidc)"
              type="text"
              value={oidc.alias}
              onChange={(e) => setOidc({ ...oidc, alias: e.target.value })}
            />
            <input
              className={inputClass}
              placeholder="authorizationUrl"
              type="url"
              value={oidc.authorizationUrl}
              onChange={(e) => setOidc({ ...oidc, authorizationUrl: e.target.value })}
              required
            />
            <input
              className={inputClass}
              placeholder="tokenUrl"
              type="url"
              value={oidc.tokenUrl}
              onChange={(e) => setOidc({ ...oidc, tokenUrl: e.target.value })}
              required
            />
            <input
              className={inputClass}
              placeholder="userInfoUrl"
              type="url"
              value={oidc.userInfoUrl}
              onChange={(e) => setOidc({ ...oidc, userInfoUrl: e.target.value })}
              required
            />
            <input
              className={inputClass}
              placeholder="jwksUrl"
              type="url"
              value={oidc.jwksUrl}
              onChange={(e) => setOidc({ ...oidc, jwksUrl: e.target.value })}
              required
            />
            <input
              className={inputClass}
              placeholder="issuer"
              type="url"
              value={oidc.issuer}
              onChange={(e) => setOidc({ ...oidc, issuer: e.target.value })}
              required
            />
            <input
              className={inputClass}
              placeholder="clientId"
              type="text"
              value={oidc.clientId}
              onChange={(e) => setOidc({ ...oidc, clientId: e.target.value })}
              required
            />
            <input
              className={inputClass}
              placeholder="clientSecret"
              type="password"
              value={oidc.clientSecret}
              onChange={(e) => setOidc({ ...oidc, clientSecret: e.target.value })}
              required
            />
          </>
        )}

        {err && <p className="text-red-600 text-sm">{err}</p>}

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={loading}
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? "Configuring..." : "Configure IdP"}
          </button>
          <button
            type="button"
            onClick={() => props.onNext()}
            className="bg-gray-200 text-gray-900 px-4 py-2 rounded hover:bg-gray-300"
          >
            Skip (configure later)
          </button>
        </div>
      </form>
    </div>
  );
}
