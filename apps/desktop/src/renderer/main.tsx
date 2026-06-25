import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.js";
import "./styles/app.css";

if (import.meta.env.DEV && !(window as { screenlink?: unknown }).screenlink) {
  // Browser audit mode (Vite dev server without Electron preload)
  await import("./audit-shim.js");
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
