import React from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import "./styles.css";

declare global {
  interface Window {
    __SAFETEST_FORGE__?: {
      apiBase?: string;
      sessionToken?: string;
    };
  }
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("UI root element is missing");
}

createRoot(root).render(
  <React.StrictMode>
    <App
      apiBase={window.__SAFETEST_FORGE__?.apiBase ?? "/api"}
      sessionToken={window.__SAFETEST_FORGE__?.sessionToken ?? ""}
    />
  </React.StrictMode>
);
