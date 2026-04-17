"use client";

import { useEffect, useState } from "react";

export default function TestCallbackPage() {
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [detail, setDetail] = useState<string>("");

  useEffect(() => {
    // Keycloak redirects back with query params including error/error_description on failure
    // or with a code on success (which gets exchanged — but in test mode the client is admin-cli
    // so we just look at whether there's an error param)
    const params = new URLSearchParams(window.location.search);
    const error = params.get("error");
    const errorDescription = params.get("error_description");

    if (error) {
      setStatus("error");
      setDetail(errorDescription ? decodeURIComponent(errorDescription) : error);
    } else {
      setStatus("success");
      setDetail("The identity provider round-trip completed successfully.");
    }

    // Notify the parent wizard window so it can advance the step
    if (window.opener && typeof window.opener.postMessage === "function") {
      window.opener.postMessage(
        { type: "keycloak-test-result", success: !error },
        window.location.origin,
      );
    }
  }, []);

  return (
    <main className="mx-auto max-w-md p-8 text-center">
      {status === "loading" && <p className="text-gray-500">Checking result...</p>}

      {status === "success" && (
        <div className="space-y-4">
          <div className="text-green-600 text-5xl">&#10003;</div>
          <h1 className="text-xl font-semibold text-green-700">Connection successful!</h1>
          <p className="text-gray-600 text-sm">{detail}</p>
          <p className="text-gray-500 text-xs">
            You can close this window and return to the setup wizard.
          </p>
          <button
            onClick={() => window.close()}
            className="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700"
          >
            Close window
          </button>
        </div>
      )}

      {status === "error" && (
        <div className="space-y-4">
          <div className="text-red-500 text-5xl">&#10007;</div>
          <h1 className="text-xl font-semibold text-red-700">Connection failed</h1>
          <p className="text-gray-600 text-sm">{detail || "An unknown error occurred."}</p>
          <p className="text-gray-500 text-xs">
            Check your IdP configuration and try again. Then close this window.
          </p>
          <button
            onClick={() => window.close()}
            className="bg-red-600 text-white px-4 py-2 rounded hover:bg-red-700"
          >
            Close window
          </button>
        </div>
      )}
    </main>
  );
}
