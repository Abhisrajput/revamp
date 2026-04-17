"use client";

import { useEffect, useRef, useState } from "react";
import Papa from "papaparse";
import {
  verifyToken,
  createRealmAdmin,
  createIdpAzure,
  createIdpOkta,
  createIdpGoogle,
  createIdpSaml,
  createIdpOidc,
  createAttributeMapping,
  setMfaPolicy,
  getIdpTestUrl,
  importUsersFromCsv,
} from "./actions";

type Step =
  | "token"
  | "admin"
  | "idp"
  | "mapping"
  | "mfa"
  | "test"
  | "users"
  | "finalize"
  | "done";

const REALM_ROLES = ["admin", "architect", "developer", "sme"] as const;
type RealmRole = (typeof REALM_ROLES)[number];

interface WizardState {
  adminEmail: string;
  idpAlias: string; // alias of the IdP configured in Step 2 (if any)
  userCount: number;
}

export default function SetupWizard() {
  const [step, setStep] = useState<Step>("token");
  const [token, setToken] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [state, setState] = useState<WizardState>({
    adminEmail: "",
    idpAlias: "",
    userCount: 0,
  });

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

      {/* Progress indicator */}
      {step !== "token" && step !== "done" && (
        <nav className="mb-6 flex gap-1 text-xs text-gray-400">
          {(
            [
              ["admin", "1. Admin"],
              ["idp", "2. IdP"],
              ["mapping", "3. Mapping"],
              ["mfa", "3b. MFA"],
              ["test", "4. Test"],
              ["users", "5. Users"],
              ["finalize", "6. Finalize"],
            ] as [Step, string][]
          ).map(([s, label]) => (
            <span
              key={s}
              className={`px-2 py-0.5 rounded ${step === s ? "bg-blue-600 text-white" : "bg-gray-100"}`}
            >
              {label}
            </span>
          ))}
        </nav>
      )}

      {step === "token" && (
        <form onSubmit={submitToken} className="space-y-4">
          <label className="block text-sm font-medium text-gray-700">Bootstrap token</label>
          <p className="text-xs text-gray-500 -mt-3">
            Printed once to the API container logs on first boot. Search your API container logs
            for <code className="mx-1 px-1 bg-gray-100 rounded">[SETUP]</code>.
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

      {step === "admin" && (
        <AdminStep
          token={token}
          onNext={(email) => {
            setState((s) => ({ ...s, adminEmail: email }));
            setStep("idp");
          }}
        />
      )}

      {step === "idp" && (
        <IdpStep
          token={token}
          onNext={(alias) => {
            setState((s) => ({ ...s, idpAlias: alias }));
            setStep("mapping");
          }}
        />
      )}

      {step === "mapping" && (
        <MappingStep
          token={token}
          idpAlias={state.idpAlias}
          onNext={() => setStep("mfa")}
        />
      )}

      {step === "mfa" && (
        <MfaStep token={token} onNext={() => setStep("test")} />
      )}

      {step === "test" && (
        <TestStep
          idpAlias={state.idpAlias}
          onNext={() => setStep("users")}
        />
      )}

      {step === "users" && (
        <UsersStep
          token={token}
          onNext={(count) => {
            setState((s) => ({ ...s, userCount: count }));
            setStep("finalize");
          }}
        />
      )}

      {step === "finalize" && (
        <FinalizeStep token={token} wizardState={state} />
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

// ─── Step 1: Create realm admin ───────────────────────────────────────────

function AdminStep(props: { token: string; onNext: (email: string) => void }) {
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
        setErr((r.body as { error?: string } | null)?.error ?? `Failed (status ${r.status})`);
        return;
      }
      props.onNext(form.email);
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

// ─── Step 2: Identity provider ────────────────────────────────────────────

type IdpProvider = "azure" | "okta" | "google" | "saml" | "oidc";

function IdpStep(props: { token: string; onNext: (alias: string) => void }) {
  const [provider, setProvider] = useState<IdpProvider>("azure");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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
      let alias: string = provider;
      if (provider === "azure") {
        r = await createIdpAzure(props.token, azure);
      } else if (provider === "okta") {
        r = await createIdpOkta(props.token, okta);
      } else if (provider === "google") {
        r = await createIdpGoogle(props.token, google);
      } else if (provider === "saml") {
        alias = saml.alias || "saml";
        r = await createIdpSaml(props.token, {
          alias: saml.alias || undefined,
          singleSignOnServiceUrl: saml.singleSignOnServiceUrl,
          entityId: saml.entityId || undefined,
        });
      } else {
        alias = oidc.alias || "oidc";
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
        setErr((r.body as { error?: string } | null)?.error ?? `Failed (status ${r.status})`);
        return;
      }
      props.onNext(alias);
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
            <input className={inputClass} placeholder="tenantId" type="text" value={azure.tenantId} onChange={(e) => setAzure({ ...azure, tenantId: e.target.value })} required />
            <input className={inputClass} placeholder="clientId" type="text" value={azure.clientId} onChange={(e) => setAzure({ ...azure, clientId: e.target.value })} required />
            <input className={inputClass} placeholder="clientSecret" type="password" value={azure.clientSecret} onChange={(e) => setAzure({ ...azure, clientSecret: e.target.value })} required />
          </>
        )}
        {provider === "okta" && (
          <>
            <input className={inputClass} placeholder="domain (e.g. your-org.okta.com)" type="text" value={okta.domain} onChange={(e) => setOkta({ ...okta, domain: e.target.value })} required />
            <input className={inputClass} placeholder="clientId" type="text" value={okta.clientId} onChange={(e) => setOkta({ ...okta, clientId: e.target.value })} required />
            <input className={inputClass} placeholder="clientSecret" type="password" value={okta.clientSecret} onChange={(e) => setOkta({ ...okta, clientSecret: e.target.value })} required />
          </>
        )}
        {provider === "google" && (
          <>
            <input className={inputClass} placeholder="hostedDomain (e.g. yourcompany.com)" type="text" value={google.hostedDomain} onChange={(e) => setGoogle({ ...google, hostedDomain: e.target.value })} required />
            <input className={inputClass} placeholder="clientId" type="text" value={google.clientId} onChange={(e) => setGoogle({ ...google, clientId: e.target.value })} required />
            <input className={inputClass} placeholder="clientSecret" type="password" value={google.clientSecret} onChange={(e) => setGoogle({ ...google, clientSecret: e.target.value })} required />
          </>
        )}
        {provider === "saml" && (
          <>
            <input className={inputClass} placeholder="alias (optional, defaults to saml)" type="text" value={saml.alias} onChange={(e) => setSaml({ ...saml, alias: e.target.value })} />
            <input className={inputClass} placeholder="singleSignOnServiceUrl" type="url" value={saml.singleSignOnServiceUrl} onChange={(e) => setSaml({ ...saml, singleSignOnServiceUrl: e.target.value })} required />
            <input className={inputClass} placeholder="entityId (optional, defaults to revamp)" type="text" value={saml.entityId} onChange={(e) => setSaml({ ...saml, entityId: e.target.value })} />
          </>
        )}
        {provider === "oidc" && (
          <>
            <input className={inputClass} placeholder="alias (optional, defaults to oidc)" type="text" value={oidc.alias} onChange={(e) => setOidc({ ...oidc, alias: e.target.value })} />
            <input className={inputClass} placeholder="authorizationUrl" type="url" value={oidc.authorizationUrl} onChange={(e) => setOidc({ ...oidc, authorizationUrl: e.target.value })} required />
            <input className={inputClass} placeholder="tokenUrl" type="url" value={oidc.tokenUrl} onChange={(e) => setOidc({ ...oidc, tokenUrl: e.target.value })} required />
            <input className={inputClass} placeholder="userInfoUrl" type="url" value={oidc.userInfoUrl} onChange={(e) => setOidc({ ...oidc, userInfoUrl: e.target.value })} required />
            <input className={inputClass} placeholder="jwksUrl" type="url" value={oidc.jwksUrl} onChange={(e) => setOidc({ ...oidc, jwksUrl: e.target.value })} required />
            <input className={inputClass} placeholder="issuer" type="url" value={oidc.issuer} onChange={(e) => setOidc({ ...oidc, issuer: e.target.value })} required />
            <input className={inputClass} placeholder="clientId" type="text" value={oidc.clientId} onChange={(e) => setOidc({ ...oidc, clientId: e.target.value })} required />
            <input className={inputClass} placeholder="clientSecret" type="password" value={oidc.clientSecret} onChange={(e) => setOidc({ ...oidc, clientSecret: e.target.value })} required />
          </>
        )}

        {err && <p className="text-red-600 text-sm">{err}</p>}

        <div className="flex gap-3">
          <button type="submit" disabled={loading} className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50">
            {loading ? "Configuring..." : "Configure IdP"}
          </button>
          <button type="button" onClick={() => props.onNext("")} className="bg-gray-200 text-gray-900 px-4 py-2 rounded hover:bg-gray-300">
            Skip (configure later)
          </button>
        </div>
      </form>
    </div>
  );
}

// ─── Step 3: Attribute mapping ────────────────────────────────────────────

function MappingStep(props: {
  token: string;
  idpAlias: string;
  onNext: () => void;
}) {
  const [alias, setAlias] = useState(props.idpAlias || "");
  const [emailAttr, setEmailAttr] = useState("email");
  const [firstNameAttr, setFirstNameAttr] = useState("given_name");
  const [lastNameAttr, setLastNameAttr] = useState("family_name");
  const [groupAttr, setGroupAttr] = useState("groups");
  // roleMap: role → IdP group name that should map to that role
  const [roleMap, setRoleMap] = useState<Record<RealmRole, string>>({
    admin: "",
    architect: "",
    developer: "",
    sme: "",
  });
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const inputClass = "border rounded px-3 py-2 w-full";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!alias) {
      setErr("IdP alias is required. Enter the alias you used when configuring the IdP.");
      return;
    }
    setLoading(true);
    try {
      // Build roleMap with only non-empty entries
      const filteredRoleMap: Record<string, RealmRole> = {};
      for (const role of REALM_ROLES) {
        const group = roleMap[role].trim();
        if (group) filteredRoleMap[group] = role;
      }
      const r = await createAttributeMapping(props.token, {
        idpAlias: alias,
        emailAttr,
        firstNameAttr,
        lastNameAttr,
        groupAttr,
        roleMap: filteredRoleMap,
      });
      if (!r.ok) {
        setErr((r.body as { error?: string } | null)?.error ?? `Failed (status ${r.status})`);
        return;
      }
      props.onNext();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Step 3: Attribute mapping</h2>
      <p className="text-sm text-gray-500">
        Map IdP claims to Keycloak user attributes and realm roles.
      </p>

      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">IdP alias</label>
          <input
            className={inputClass}
            placeholder="e.g. azure, okta, google"
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Email claim</label>
            <input className={inputClass} value={emailAttr} onChange={(e) => setEmailAttr(e.target.value)} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">First name claim</label>
            <input className={inputClass} value={firstNameAttr} onChange={(e) => setFirstNameAttr(e.target.value)} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Last name claim</label>
            <input className={inputClass} value={lastNameAttr} onChange={(e) => setLastNameAttr(e.target.value)} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Groups claim</label>
            <input className={inputClass} value={groupAttr} onChange={(e) => setGroupAttr(e.target.value)} />
          </div>
        </div>

        <div>
          <p className="text-xs font-medium text-gray-600 mb-2">
            Role mapping — IdP group name that maps to each REVAMP role:
          </p>
          <table className="w-full text-sm border rounded overflow-hidden">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left px-3 py-2 font-medium text-gray-600">REVAMP role</th>
                <th className="text-left px-3 py-2 font-medium text-gray-600">IdP group name</th>
              </tr>
            </thead>
            <tbody>
              {REALM_ROLES.map((role) => (
                <tr key={role} className="border-t">
                  <td className="px-3 py-2 font-mono text-xs text-gray-700">{role}</td>
                  <td className="px-3 py-2">
                    <input
                      className="border rounded px-2 py-1 w-full text-sm"
                      placeholder={`e.g. revamp-${role}`}
                      value={roleMap[role]}
                      onChange={(e) =>
                        setRoleMap((m) => ({ ...m, [role]: e.target.value }))
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-gray-400 mt-1">Leave blank to skip role mapping for that role.</p>
        </div>

        {err && <p className="text-red-600 text-sm">{err}</p>}

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={loading}
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? "Applying..." : "Apply mapping"}
          </button>
          <button
            type="button"
            onClick={props.onNext}
            className="bg-gray-200 text-gray-900 px-4 py-2 rounded hover:bg-gray-300"
          >
            Skip
          </button>
        </div>
      </form>
    </div>
  );
}

// ─── Step 3b: MFA policy ──────────────────────────────────────────────────

function MfaStep(props: { token: string; onNext: () => void }) {
  const [policy, setPolicy] = useState<"all" | "admins_only" | "optional">("admins_only");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    try {
      const r = await setMfaPolicy(props.token, policy);
      if (!r.ok) {
        setErr((r.body as { error?: string } | null)?.error ?? `Failed (status ${r.status})`);
        return;
      }
      props.onNext();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Step 3b: MFA policy</h2>
      <p className="text-sm text-gray-500">
        Choose how multi-factor authentication is enforced for realm users.
      </p>

      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          {(
            [
              ["all", "Required for everyone", "All users must enroll in TOTP before accessing the app."],
              ["admins_only", "Admins only (recommended)", "Admins are prompted to configure TOTP at next login. Other users are not required to enroll."],
              ["optional", "Optional", "TOTP shown as an option but not enforced for any user."],
            ] as [typeof policy, string, string][]
          ).map(([value, label, description]) => (
            <label
              key={value}
              className={`flex items-start gap-3 p-3 border rounded cursor-pointer ${policy === value ? "border-blue-500 bg-blue-50" : "border-gray-200"}`}
            >
              <input
                type="radio"
                name="mfa-policy"
                value={value}
                checked={policy === value}
                onChange={() => setPolicy(value)}
                className="mt-0.5"
              />
              <div>
                <div className="font-medium text-sm">{label}</div>
                <div className="text-xs text-gray-500">{description}</div>
              </div>
            </label>
          ))}
        </div>

        {err && <p className="text-red-600 text-sm">{err}</p>}

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={loading}
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? "Applying..." : "Apply MFA policy"}
          </button>
          <button
            type="button"
            onClick={props.onNext}
            className="bg-gray-200 text-gray-900 px-4 py-2 rounded hover:bg-gray-300"
          >
            Skip
          </button>
        </div>
      </form>
    </div>
  );
}

// ─── Step 4: Test IdP connection ─────────────────────────────────────────

function TestStep(props: { idpAlias: string; onNext: () => void }) {
  const [alias, setAlias] = useState(props.idpAlias || "");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [testOpened, setTestOpened] = useState(false);
  const winRef = useRef<Window | null>(null);

  // Listen for postMessage from the test-callback window
  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === "keycloak-test-result") {
        if (winRef.current) winRef.current.close();
        if (event.data.success) {
          // Auto-advance if test was successful
          props.onNext();
        } else {
          setErr("IdP test reported a failure. Check the callback window for details.");
          setTestOpened(false);
        }
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [props]);

  async function openTestWindow() {
    setErr(null);
    if (!alias) {
      setErr("Enter the IdP alias to test.");
      return;
    }
    setLoading(true);
    try {
      const r = await getIdpTestUrl(alias);
      if (!r.ok || !r.body?.url) {
        setErr("Could not retrieve test URL from the API.");
        return;
      }
      const win = window.open(r.body.url, "keycloak-test", "width=600,height=700");
      winRef.current = win;
      setTestOpened(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Step 4: Test IdP connection</h2>
      <p className="text-sm text-gray-500">
        Opens a Keycloak federated login round-trip in a new window to verify the IdP is
        correctly configured.
      </p>

      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">IdP alias to test</label>
        <input
          className="border rounded px-3 py-2 w-full"
          placeholder="e.g. azure, okta, google"
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
        />
      </div>

      {err && <p className="text-red-600 text-sm">{err}</p>}

      <div className="flex gap-3 flex-wrap">
        <button
          type="button"
          onClick={openTestWindow}
          disabled={loading}
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? "Opening..." : "Test connection"}
        </button>

        {testOpened && (
          <button
            type="button"
            onClick={props.onNext}
            className="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700"
          >
            It worked — continue
          </button>
        )}

        <button
          type="button"
          onClick={props.onNext}
          className="bg-gray-200 text-gray-900 px-4 py-2 rounded hover:bg-gray-300"
        >
          Skip (no IdP configured)
        </button>
      </div>

      {testOpened && (
        <p className="text-xs text-gray-400">
          A browser window opened for the IdP login flow. After completing the login, it will
          redirect back to this wizard. If the window does not auto-close, click{" "}
          <strong>It worked — continue</strong> manually.
        </p>
      )}
    </div>
  );
}

// ─── Step 5: Initial users ────────────────────────────────────────────────

interface CsvRow {
  email: string;
  firstName: string;
  lastName: string;
  role: RealmRole;
}

function UsersStep(props: { token: string; onNext: (count: number) => void }) {
  const [rows, setRows] = useState<CsvRow[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{
    created: number;
    skipped: number;
    errors: string[];
  } | null>(null);
  const [apiErr, setApiErr] = useState<string | null>(null);

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    setParseError(null);
    setRows([]);
    setResult(null);
    const file = e.target.files?.[0];
    if (!file) return;

    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete(results) {
        const parsed: CsvRow[] = [];
        for (const raw of results.data) {
          const email = (raw["email"] ?? raw["Email"] ?? "").trim();
          const firstName = (raw["first_name"] ?? raw["firstName"] ?? raw["First Name"] ?? "").trim();
          const lastName = (raw["last_name"] ?? raw["lastName"] ?? raw["Last Name"] ?? "").trim();
          const roleRaw = (raw["role"] ?? raw["Role"] ?? "").trim().toLowerCase() as RealmRole;
          if (!email) continue;
          const role: RealmRole = (REALM_ROLES as readonly string[]).includes(roleRaw)
            ? roleRaw
            : "developer";
          parsed.push({ email, firstName, lastName, role });
        }
        if (parsed.length === 0) {
          setParseError("No valid rows found. Expected columns: email, first_name, last_name, role");
          return;
        }
        setRows(parsed);
      },
      error(err) {
        setParseError(`CSV parse error: ${err.message}`);
      },
    });
  }

  async function submit() {
    setApiErr(null);
    setSubmitting(true);
    try {
      const r = await importUsersFromCsv(props.token, rows);
      if (!r.ok) {
        setApiErr((r.body as { error?: string } | null)?.error ?? `Failed (status ${r.status})`);
        return;
      }
      const body = r.body as { created: number; skipped: number; errors: string[] } | null;
      setResult(body ?? { created: 0, skipped: 0, errors: [] });
    } finally {
      setSubmitting(false);
    }
  }

  const ROLE_COLORS: Record<RealmRole, string> = {
    admin: "bg-red-100 text-red-700",
    architect: "bg-purple-100 text-purple-700",
    developer: "bg-blue-100 text-blue-700",
    sme: "bg-green-100 text-green-700",
  };

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Step 5: Import initial users</h2>
      <p className="text-sm text-gray-500">
        Upload a CSV file with columns:{" "}
        <code className="bg-gray-100 px-1 rounded">email, first_name, last_name, role</code>.
        Valid roles: admin, architect, developer, sme.
      </p>

      <input
        type="file"
        accept=".csv"
        onChange={handleFile}
        className="block w-full text-sm text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:border file:rounded file:text-sm file:font-medium file:bg-gray-50 file:text-gray-700 hover:file:bg-gray-100"
      />

      {parseError && <p className="text-red-600 text-sm">{parseError}</p>}

      {rows.length > 0 && !result && (
        <div className="space-y-3">
          <p className="text-sm text-gray-600">{rows.length} users parsed. Preview:</p>
          <div className="overflow-auto max-h-48 border rounded">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  <th className="text-left px-3 py-2 font-medium text-gray-600">Email</th>
                  <th className="text-left px-3 py-2 font-medium text-gray-600">First</th>
                  <th className="text-left px-3 py-2 font-medium text-gray-600">Last</th>
                  <th className="text-left px-3 py-2 font-medium text-gray-600">Role</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i} className="border-t">
                    <td className="px-3 py-1.5 font-mono">{row.email}</td>
                    <td className="px-3 py-1.5">{row.firstName}</td>
                    <td className="px-3 py-1.5">{row.lastName}</td>
                    <td className="px-3 py-1.5">
                      <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${ROLE_COLORS[row.role]}`}>
                        {row.role}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {result && (
        <div className="border rounded p-4 space-y-2 bg-gray-50">
          <p className="text-sm font-medium">Import complete</p>
          <div className="flex gap-4 text-sm">
            <span className="text-green-700">Created: {result.created}</span>
            <span className="text-yellow-700">Skipped: {result.skipped}</span>
            <span className="text-red-700">Errors: {result.errors.length}</span>
          </div>
          {result.errors.length > 0 && (
            <ul className="text-xs text-red-600 space-y-0.5 list-disc ml-4">
              {result.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {apiErr && <p className="text-red-600 text-sm">{apiErr}</p>}

      <div className="flex gap-3">
        {!result && rows.length > 0 && (
          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? "Importing..." : `Create ${rows.length} user${rows.length !== 1 ? "s" : ""}`}
          </button>
        )}

        {result ? (
          <button
            type="button"
            onClick={() => props.onNext(result.created)}
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
          >
            Continue
          </button>
        ) : (
          <button
            type="button"
            onClick={() => props.onNext(0)}
            className="bg-gray-200 text-gray-900 px-4 py-2 rounded hover:bg-gray-300"
          >
            Skip (add users later)
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Step 6: Finalize ────────────────────────────────────────────────────

function FinalizeStep(props: { token: string; wizardState: WizardState }) {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function complete() {
    setErr(null);
    setLoading(true);
    try {
      // Import finalize action inline to avoid circular ref at module scope
      const { finalize } = await import("./actions");
      const r = await finalize(props.token);
      if (!r.ok) {
        setErr((r.body as { error?: string } | null)?.error ?? `Failed (status ${r.status})`);
        return;
      }
      window.location.href = "/auth/login";
    } finally {
      setLoading(false);
    }
  }

  const { adminEmail, idpAlias, userCount } = props.wizardState;

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">Step 6: Finalize setup</h2>

      <div className="border rounded p-4 bg-gray-50 space-y-3">
        <h3 className="text-sm font-medium text-gray-700">Configuration summary</h3>
        <dl className="text-sm space-y-2">
          <div className="flex justify-between">
            <dt className="text-gray-500">Realm admin</dt>
            <dd className="font-medium">{adminEmail || "—"}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-gray-500">Identity provider</dt>
            <dd className="font-medium">{idpAlias || "None configured"}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-gray-500">Initial users imported</dt>
            <dd className="font-medium">{userCount}</dd>
          </div>
        </dl>
      </div>

      <p className="text-sm text-gray-500">
        Clicking <strong>Complete setup</strong> marks setup as done. The setup wizard will no
        longer be accessible after this point.
      </p>

      {err && <p className="text-red-600 text-sm">{err}</p>}

      <button
        type="button"
        onClick={complete}
        disabled={loading}
        className="w-full bg-green-600 text-white px-4 py-3 rounded font-medium hover:bg-green-700 disabled:opacity-50"
      >
        {loading ? "Completing..." : "Complete setup"}
      </button>
    </div>
  );
}
